---
name: shopify-webhooks
description: How webhooks are received, verified, de-duplicated and processed in this React Router Shopify app (orders/paid, orders/cancelled). Load before adding or changing a webhook subscription in shopify.app.toml, writing a webhooks.*.tsx route, or debugging webhook delivery, HMAC failures, duplicates or timeouts.
---

# Webhooks in this app

Use the Shopify dev MCP (`shopify-dev-mcp`) or shopify.dev to confirm payload fields and topic requirements for the API version in `shopify.app.toml`. Do not rely on memory for payload shape.

## Subscribing

Subscriptions are app-specific, declared in `shopify.app.toml` and applied by `shopify app deploy` (or automatically during `shopify app dev`). Do not register them in code.

```toml
[[webhooks.subscriptions]]
topics = [ "orders/paid" ]
uri = "/webhooks/orders/paid"

[[webhooks.subscriptions]]
topics = [ "orders/cancelled" ]
uri = "/webhooks/orders/cancelled"
```

Route file naming follows the template: `app/routes/webhooks.orders.paid.tsx`.

Before this works:
- Scopes must include `read_orders` (brief: `read_orders,write_orders,read_products`). The template still has its demo scopes.
- Order topics carry protected customer data. The app must have protected customer data access configured in the Partner/Dev Dashboard, or the deploy rejects the subscription. This is a dashboard step: give the developer click-by-click instructions, do not attempt it.

## Verification

`authenticate.webhook(request)` from `app/shopify.server.ts` is the only allowed entry point. It reads the raw body, checks the HMAC against `SHOPIFY_API_SECRET`, and throws a `401` Response on mismatch (`400` on malformed requests).

- Call it first, before anything else touches `request`. Never call `request.json()` or `request.text()` before it; the body can be read once.
- Do not catch its thrown Response and turn it into something else.
- Do not hand-roll HMAC verification. If a non-Shopify caller ever needs an endpoint here, that is a separate route with separate auth.

It returns `{ topic, shop, payload, webhookId, apiVersion, session, admin }`. `admin` is the Admin GraphQL client for that shop, and is `undefined` if the shop has no stored session (uninstalled).

## Handler shape

```ts
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, webhookId, admin } = await authenticate.webhook(request);

  const firstTime = await ringRepo.recordWebhookEvent(webhookId, topic);
  if (!firstTime) return new Response();          // duplicate delivery: 200, stop

  await handleOrderPaid({ shop, payload, admin }); // fast, durable part only
  return new Response();
};
```

Rules:

1. **Idempotency is two layers.** `webhook_events` keyed by `webhookId` stops replays of the same delivery. The unique index on `(lineItemId, unitIndex)` stops duplicates when Shopify sends a fresh delivery for the same order. Both are required; neither replaces the other.
2. **If processing fails after the event row is inserted, delete the row (or mark it failed) before returning 5xx.** Otherwise Shopify's retry is swallowed as a duplicate and the order never gets rings.
3. **Respond within 5 seconds.** Shopify times out and retries; repeated failures over its retry window can remove the subscription. In the request: verify, de-duplicate, insert rings. Out of the request: QR rendering, storage uploads, Admin API write-back.
4. **Deferred work must be durable.** A ring with `qr.png == null`, or an order without the `rings-ready` tag, is the pending-work record. A processor must be able to find and finish those after a crash. An un-awaited promise alone is not acceptable: on serverless hosts it is killed when the response is sent. Hosting is undecided, so keep the processor callable from both an in-process trigger and a scheduled sweep.
5. **Return 200 for events that need no action** (no ring products in the order, shop unknown). Non-2xx means "retry", so use it only for failures a retry could fix.
6. **Webhooks arrive out of order and late.** `orders/cancelled` can precede `orders/paid`. On `orders/paid`, skip ring creation if `payload.cancelled_at` is set.
7. **Never log the payload.** It contains customer names, emails and addresses. Log topic, shop, order name and webhook ID. Remove the template's `console.log(JSON.stringify(payload))` pattern from any handler you copy.

## orders/paid specifics

- One ring per unit: `quantity: 3` gives `unitIndex` 0, 1, 2.
- The payload's `line_items[]` have `id`, `admin_graphql_api_id`, `product_id`, `quantity`, but not product tags. To apply `RING_PRODUCT_TAG`, query the products through `admin.graphql` (one query for all product IDs in the order, not one per line). Line items with `product_id: null` (custom items, deleted products) are not ring products.
- Store GIDs (`admin_graphql_api_id`), not numeric IDs.

## orders/cancelled specifics

Call `voidUnclaimedByOrderId` only. A single conditional update; never load rings and loop. See the `ring-domain` skill for why.

## Testing

- `shopify app webhook trigger --topic orders/paid --address <tunnel>/webhooks/orders/paid` sends a fixture payload. Good for HMAC and routing; its IDs are fake, so it does not prove ring creation against real products.
- Real test: place an order on the dev store with a tagged product, mark it paid.
- Replay: re-send the same request with the same `X-Shopify-Webhook-Id`; expect 200 and no new rings.
- Tamper: change one byte of the body; expect 401.
