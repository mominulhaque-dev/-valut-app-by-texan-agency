import type { RingRepository } from "./ring-repository.server";
import type { RingUnit } from "./types";

/** The parts of the orders/* webhook payload this app relies on. */
interface OrderPayload {
  admin_graphql_api_id?: unknown;
  name?: unknown;
  cancelled_at?: unknown;
  line_items?: unknown;
}

interface LineItemPayload {
  admin_graphql_api_id?: unknown;
  product_id?: unknown;
  quantity?: unknown;
}

export type OrderPaidResult =
  | { outcome: "created"; ringCount: number }
  | { outcome: "skipped"; reason: "cancelled" | "no_ring_products" };

/** Returns the lower-cased tags of each product, keyed by product GID. */
export type FetchProductTags = (productIds: string[]) => Promise<Map<string, string[]>>;

export class InvalidPayloadError extends Error {}

function orderIdentity(payload: OrderPayload): { orderId: string; orderName: string } {
  const orderId = payload.admin_graphql_api_id;
  if (typeof orderId !== "string" || !orderId.startsWith("gid://shopify/Order/")) {
    throw new InvalidPayloadError("Order payload has no order GID");
  }
  return {
    orderId,
    orderName: typeof payload.name === "string" ? payload.name : orderId,
  };
}

const productGid = (id: number | string) => `gid://shopify/Product/${id}`;

export async function handleOrderPaid(input: {
  shop: string;
  payload: unknown;
  ringProductTag: string;
  fetchProductTags: FetchProductTags;
  repo: RingRepository;
}): Promise<OrderPaidResult> {
  const payload = (input.payload ?? {}) as OrderPayload;
  const { orderId, orderName } = orderIdentity(payload);

  // Webhooks can arrive late and out of order: a paid event for an order that
  // is already cancelled must not create rings.
  if (payload.cancelled_at) return { outcome: "skipped", reason: "cancelled" };

  const lineItems = (Array.isArray(payload.line_items) ? payload.line_items : []) as LineItemPayload[];

  // Custom line items and deleted products have no product_id: not ring products.
  const candidates = lineItems.filter(
    (item): item is { admin_graphql_api_id: string; product_id: number | string; quantity: number } =>
      typeof item.admin_graphql_api_id === "string" &&
      (typeof item.product_id === "number" || typeof item.product_id === "string") &&
      Number.isInteger(item.quantity) &&
      (item.quantity as number) > 0,
  );
  if (candidates.length === 0) return { outcome: "skipped", reason: "no_ring_products" };

  const productIds = [...new Set(candidates.map((item) => productGid(item.product_id)))];
  const tagsByProduct = await input.fetchProductTags(productIds);
  const wanted = input.ringProductTag.toLowerCase();

  const units: RingUnit[] = [];
  for (const item of candidates) {
    const tags = tagsByProduct.get(productGid(item.product_id)) ?? [];
    if (!tags.includes(wanted)) continue;
    for (let unitIndex = 0; unitIndex < item.quantity; unitIndex++) {
      units.push({ lineItemId: item.admin_graphql_api_id, unitIndex });
    }
  }
  if (units.length === 0) return { outcome: "skipped", reason: "no_ring_products" };

  // Database first. Writing to the Shopify order happens afterwards from the
  // queue, so a failed Admin API call never loses rings.
  const rings = await input.repo.ensureRingsForOrder({
    shop: input.shop,
    orderId,
    orderName,
    units,
  });
  await input.repo.queueWriteback({ shop: input.shop, orderId, orderName });

  return { outcome: "created", ringCount: rings.length };
}

export async function handleOrderCancelled(input: {
  shop: string;
  payload: unknown;
  repo: RingRepository;
}): Promise<{ voided: number }> {
  const { orderId, orderName } = orderIdentity((input.payload ?? {}) as OrderPayload);

  // Only UNCLAIMED rings are voided. A sealed or claimed ring holds a
  // family's memories and is never changed by an automated event.
  const voided = await input.repo.voidUnclaimedByOrderId(orderId);
  if (voided > 0) {
    // Refresh the order metafield and tag so the packing team sees the change.
    await input.repo.queueWriteback({ shop: input.shop, orderId, orderName });
  }
  return { voided };
}
