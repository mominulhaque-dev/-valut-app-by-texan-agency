---
name: order-writeback
description: How ring data is written back to the Shopify order (vault.rings JSON metafield and the rings-ready tag) through the Admin GraphQL API, including retry and privacy rules. Load before writing or changing any Admin API mutation on orders, the order metafield shape, order tags, or the write-back retry logic.
---

# Writing rings back to the order

Validate every query and mutation against the live schema with the Shopify dev MCP (`shopify-dev-mcp`) before committing it. API version is set in `app/shopify.server.ts`.

## What is written

1. Order metafield: namespace `vault`, key `rings`, type `json`.
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

Do not put signed, expiring image URLs in the metafield; they will be dead by the time someone packs the order. Use stable links to an authenticated route in this app.

## Mutations

- `metafieldsSet` with `ownerId` = the order GID. It is an upsert, so retries are safe.
- `tagsAdd` with the order GID. Adding an existing tag is a no-op, so retries are safe.

Always read `userErrors` on both and treat a non-empty list as failure; these mutations return HTTP 200 with errors inside. Write the whole metafield from the database's current rings for the order every time, never patch it.

## Ordering and failure

Order of operations for one order:

1. Rings inserted in the database (webhook request).
2. QR images generated and uploaded.
3. Metafield set.
4. Tag added, last. The tag tells the packing team the order is ready, so it must not appear before the metafield and images exist.

None of this is atomic with ring creation. If steps 2 to 4 fail, the rings still exist and the work is retried by the processor described in `shopify-webhooks`. Retry with backoff on throttling (`THROTTLED` error code / HTTP 429) and 5xx; do not retry `userErrors`, log and surface them in the admin page.

Outside a webhook or admin request, get an Admin client with `unauthenticated.admin(shop)` from `app/shopify.server.ts`. It throws if the shop has no stored session (app uninstalled): leave the work pending, do not crash the processor.

## Privacy

The scan URL is a key (brief risk 1). After this write it lives on the order, so:

- Never expose the `vault.rings` metafield to the storefront, customer accounts, checkout or order status extensions, or notification templates. No storefront access on any metafield definition for it.
- Never copy ring IDs or URLs into order notes, note attributes, line item properties, or the timeline.
- The `vault` namespace is not app-reserved, so other apps with order access on the store can read it. If the developer wants it private to this app, the alternative is the app-reserved `$app:vault` namespace; that changes the brief's contract, so raise it, do not switch silently.

## Done check (brief Phase 5)

The metafield is visible on the order in Shopify admin with correct JSON, and the `rings-ready` tag filters the order list. Only the developer can confirm this in the browser.
