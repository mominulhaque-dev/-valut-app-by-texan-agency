---
name: order-writeback
description: How ring data is written back to the Shopify order (app-owned rings JSON metafield and the rings-ready tag) through the Admin GraphQL API, including retry and privacy rules. Load before writing or changing any Admin API mutation on orders, the order metafield shape, order tags, or the write-back retry logic.
---

# Writing rings back to the order

Validate every query and mutation against the live schema with the Shopify dev MCP (`shopify-dev-mcp`) before committing it. API version is set in `app/shopify.server.ts`.

## What is written

1. Order metafield: namespace `$app`, key `rings`, type `json`, declared in `shopify.app.toml` as `[order.metafields.app.rings]` with `access.admin = "merchant_read"`.
2. Order tag: `rings-ready`.

Both need `write_orders`.

Metafield value:

```json
{
  "version": 1,
  "rings": [
    { "id": "K7M9XQ2PR4TB", "lineItemId": "gid://shopify/LineItem/456", "unitIndex": 0,
      "scanUrl": "https://.../r/K7M9XQ2PR4TB", "png": "https://...", "svg": "https://..." }
  ]
}
```

The brief asks for the scan URL and image URLs in the metafield, and the `ring-domain` rule says never to store vault URLs. Both hold: the database stores IDs only, and the metafield is a derived copy for the packing team that can be rewritten from the database at any time. Keep a "rewrite all order metafields" operation available for the day the domain changes.

The `png` and `svg` values are the stable signed links from `buildQrLink` (see `qr-generation`). Do not use expiring URLs; they would be dead by the time someone packs the order.

## Mutations

- `metafieldsSet` with `ownerId` = the order GID. It is an upsert, so retries are safe.
- `tagsAdd` with the order GID. Adding an existing tag is a no-op, so retries are safe.

Always read `userErrors` on both and treat a non-empty list as failure; these mutations return HTTP 200 with errors inside. Write the whole metafield from the database's current rings for the order every time, never patch it.

## Ordering and failure

Order of operations for one order:

1. Rings inserted in the database and the order queued in `ring_orders` (webhook request).
2. Metafield set.
3. Tag added, last. The tag tells the packing team the order is ready, so it must not appear before the metafield and images exist.

None of this is atomic with ring creation. If steps 2 and 3 fail, the rings still exist and the queue in `app/rings/writeback.server.ts` retries. On cancellation the order is queued again: the metafield is rewritten without void rings, and the tag is removed when no active ring is left. Thrown errors (network, throttling, 5xx, missing session) are retried with exponential backoff up to `MAX_WRITEBACK_ATTEMPTS`; `userErrors` are permanent (`PermanentWritebackError`) and mark the order `FAILED` at once. Failed orders show in the admin page with a retry button.

Outside a webhook or admin request, get an Admin client with `unauthenticated.admin(shop)` from `app/shopify.server.ts`. It throws if the shop has no stored session (app uninstalled): leave the work pending, do not crash the processor.

## Privacy

The scan URL is a key (brief risk 1). After this write it lives on the order, so:

- Never expose the rings metafield to the storefront, customer accounts, checkout or order status extensions, or notification templates. No storefront access on any metafield definition for it.
- Never copy ring IDs or URLs into order notes, note attributes, line item properties, or the timeline.
- The namespace is app-reserved (`$app`) on purpose: only this app can write it, and it is hidden from the Storefront and Customer Account APIs by default. This deviates from the brief's `vault` namespace; the developer approved it. Do not move it to a merchant-owned namespace and do not add `access.storefront` or `access.customer_account`.
- Liquid can read order metafields regardless of API access settings. Nobody may add this metafield to a notification template or theme.

## Done check (brief Phase 5)

The metafield is visible on the order in Shopify admin with correct JSON, and the `rings-ready` tag filters the order list. Only the developer can confirm this in the browser.
