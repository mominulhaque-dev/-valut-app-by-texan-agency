import type { ActionFunctionArgs } from "react-router";
import { handleOrderCancelled, InvalidPayloadError } from "../rings/order-events.server";
import { ringRepository } from "../rings/ring-repository.server";
import { kickWritebacks } from "../rings/runner.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  // Verifies the HMAC against the raw body and throws a 401 on mismatch.
  const { shop, topic, payload, webhookId } = await authenticate.webhook(request);

  const firstDelivery = await ringRepository.recordWebhookEvent(webhookId, topic);
  if (!firstDelivery) return new Response();

  try {
    const { voided } = await handleOrderCancelled({
      shop,
      payload,
      repo: ringRepository,
    });
    console.log(`${topic} ${shop} webhook=${webhookId} voided=${voided}`);
    if (voided > 0) kickWritebacks();
    return new Response();
  } catch (error) {
    if (error instanceof InvalidPayloadError) {
      console.error(`${topic} ${shop} webhook=${webhookId} invalid payload`);
      return new Response();
    }
    await ringRepository.forgetWebhookEvent(webhookId).catch(() => {});
    console.error(
      `${topic} ${shop} webhook=${webhookId} failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return new Response(null, { status: 500 });
  }
};
