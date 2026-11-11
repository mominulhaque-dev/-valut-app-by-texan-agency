import { buildQrLink } from "./qr-links.server";
import type { RingRepository } from "./ring-repository.server";
import type { RingDoc, RingOrderDoc } from "./types";
import { buildScanUrl } from "./vault-url";

/**
 * App-reserved namespace: only this app can write it, and it is hidden from
 * the Storefront and Customer Account APIs. The definition in
 * shopify.app.toml makes it visible (read-only) on the order in Shopify admin.
 */
export const METAFIELD_NAMESPACE = "$app";
export const METAFIELD_KEY = "rings";
export const READY_TAG = "rings-ready";

export interface AdminGraphql {
  graphql(
    query: string,
    options?: { variables?: Record<string, unknown> },
  ): Promise<{ json(): Promise<unknown> }>;
}

export type GetAdmin = (shop: string) => Promise<AdminGraphql>;

export interface WritebackConfig {
  vaultBaseUrl: string;
  appUrl: string;
  apiSecret: string;
}

/** Shopify rejected the request itself; retrying the same call cannot help. */
export class PermanentWritebackError extends Error {}

interface UserError {
  field?: string[] | null;
  message: string;
}

export function buildMetafieldValue(rings: RingDoc[], config: WritebackConfig) {
  return {
    version: 1,
    rings: rings.map((ring) => ({
      id: ring._id,
      lineItemId: ring.order.lineItemId,
      unitIndex: ring.order.unitIndex,
      scanUrl: buildScanUrl(config.vaultBaseUrl, ring._id),
      png: buildQrLink(config, ring._id, "png"),
      svg: buildQrLink(config, ring._id, "svg"),
    })),
  };
}

async function mutate(
  admin: AdminGraphql,
  query: string,
  variables: Record<string, unknown>,
  root: string,
): Promise<void> {
  const response = await admin.graphql(query, { variables });
  const body = (await response.json()) as {
    data?: Record<string, { userErrors?: UserError[] } | null>;
    errors?: unknown;
  };
  if (body.errors) {
    throw new Error(`${root} failed with GraphQL errors`);
  }
  // Mutations answer HTTP 200 even when they did nothing; the failure is here.
  const userErrors = body.data?.[root]?.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new PermanentWritebackError(
      `${root}: ${userErrors.map((e) => e.message).join("; ")}`,
    );
  }
}

const SET_METAFIELD = `#graphql
  mutation RingsSetOrderMetafield($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message }
    }
  }`;

const ADD_TAG = `#graphql
  mutation RingsAddOrderTag($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      userErrors { field message }
    }
  }`;

const REMOVE_TAG = `#graphql
  mutation RingsRemoveOrderTag($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) {
      userErrors { field message }
    }
  }`;

/**
 * Writes the current rings of one order to Shopify. The metafield is always
 * rebuilt from the database, and both mutations are upserts, so running this
 * twice gives the same result.
 */
export async function writeBackOrder(input: {
  orderId: string;
  admin: AdminGraphql;
  repo: RingRepository;
  config: WritebackConfig;
}): Promise<void> {
  const rings = await input.repo.findRingsByOrderId(input.orderId);
  const active = rings.filter((ring) => ring.status !== "VOID");

  await mutate(
    input.admin,
    SET_METAFIELD,
    {
      metafields: [
        {
          ownerId: input.orderId,
          namespace: METAFIELD_NAMESPACE,
          key: METAFIELD_KEY,
          type: "json",
          value: JSON.stringify(buildMetafieldValue(active, input.config)),
        },
      ],
    },
    "metafieldsSet",
  );

  // The tag goes last: it tells the packing team the order is ready, so it
  // must not appear before the metafield exists.
  if (active.length > 0) {
    await mutate(input.admin, ADD_TAG, { id: input.orderId, tags: [READY_TAG] }, "tagsAdd");
  } else {
    await mutate(input.admin, REMOVE_TAG, { id: input.orderId, tags: [READY_TAG] }, "tagsRemove");
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

async function runOne(
  order: RingOrderDoc,
  deps: { repo: RingRepository; getAdmin: GetAdmin; config: WritebackConfig },
): Promise<boolean> {
  try {
    const admin = await deps.getAdmin(order.shop);
    await writeBackOrder({ orderId: order._id, admin, repo: deps.repo, config: deps.config });
    await deps.repo.completeWriteback(order._id, order.attempts);
    return true;
  } catch (error) {
    // Stays PENDING with its backoff unless the error is permanent or the
    // attempts are used up; then it shows as FAILED in the admin page.
    await deps.repo.failWriteback(
      order._id,
      describe(error),
      error instanceof PermanentWritebackError,
    );
    console.error(`Ring write-back failed for order ${order.orderName}: ${describe(error)}`);
    return false;
  }
}

/** Processes due orders from the queue. Returns how many were written. */
export async function processDueWritebacks(deps: {
  repo: RingRepository;
  getAdmin: GetAdmin;
  config: WritebackConfig;
  limit?: number;
}): Promise<{ processed: number; succeeded: number }> {
  const orders = await deps.repo.claimDueWritebacks(deps.limit ?? 20);
  let succeeded = 0;
  for (const order of orders) {
    if (await runOne(order, deps)) succeeded++;
  }
  return { processed: orders.length, succeeded };
}

/** Processes one order now (admin "retry" button). */
export async function processWritebackNow(
  orderId: string,
  deps: { repo: RingRepository; getAdmin: GetAdmin; config: WritebackConfig },
): Promise<boolean> {
  const order = await deps.repo.claimWriteback(orderId);
  return order ? runOne(order, deps) : false;
}
