import type { ActionFunctionArgs } from "react-router";
import { getConfig } from "../config.server";
import { handleOrderPaid, InvalidPayloadError } from "../rings/order-events.server";
import { ringRepository } from "../rings/ring-repository.server";
import { kickWritebacks } from "../rings/runner.server";
import { authenticate } from "../shopify.server";

const PRODUCT_TAGS = `#graphql
  query RingsProductTags($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product { id tags }
    }
  }`;

export const action = async ({ request }: ActionFunctionArgs) => {
  // Verifies the HMAC against the raw body and throws a 401 on mismatch.
  // Nothing may read the request before this line.
  const { shop, topic, payload, webhookId, admin } =
    await authenticate.webhook(request);

  // No session means the app was uninstalled; there is nothing to look up or
  // write back to, and a retry would not change that.
  if (!admin) {
    console.warn(`${topic} ${shop} webhook=${webhookId} ignored: no session for shop`);
    return new Response();
  }

  const firstDelivery = await ringRepository.recordWebhookEvent(webhookId, topic);
  if (!firstDelivery) return new Response();

  try {
    const result = await handleOrderPaid({
      shop,
      payload,
      ringProductTag: getConfig().ringProductTag,
      repo: ringRepository,
      fetchProductTags: async (ids) => {
        const response = await admin.graphql(PRODUCT_TAGS, { variables: { ids } });
        const { data } = (await response.json()) as {
          data?: { nodes?: ({ id?: string; tags?: string[] } | null)[] };
        };
        const tags = new Map<string, string[]>();
        for (const node of data?.nodes ?? []) {
          if (node?.id) {
            tags.set(node.id, (node.tags ?? []).map((tag) => tag.toLowerCase()));
          }
        }
        return tags;
      },
    });

    // Never log the payload: it carries customer names and addresses.
    console.log(
      `${topic} ${shop} webhook=${webhookId} ` +
        (result.outcome === "created"
          ? `rings=${result.ringCount}`
          : `skipped=${result.reason}`),
    );

    // The slow part (Admin API write-back) runs after the response.
    if (result.outcome === "created") kickWritebacks();
    return new Response();
  } catch (error) {
    if (error instanceof InvalidPayloadError) {
      // A retry would deliver the same payload; accept it and move on.
      console.error(`${topic} ${shop} webhook=${webhookId} invalid payload`);
      return new Response();
    }
    // Let Shopify retry: forget the event so the retry is not treated as a
    // duplicate. Ring creation is idempotent, so a retry is safe.
    await ringRepository.forgetWebhookEvent(webhookId).catch(() => {});
    console.error(
      `${topic} ${shop} webhook=${webhookId} failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return new Response(null, { status: 500 });
  }
};
