---
name: ring-domain
description: Domain rules for Kindest Regards ring records - ring ID format, status state machine, data shape, indexes, storage interface, and the security invariants that must never be broken. Load before writing or changing any code that creates, reads, updates or voids rings, touches the database layer or schema, or builds a vault/scan URL.
---

# Ring domain rules

Source of truth: `PROJECT_BRIEF.md` (sections 4, 5, 6, 9). If this skill and the brief disagree, the brief wins; fix this file.

## Ownership boundary

This app owns: ring creation, QR generation, order write-back, cancellation voiding, packing-team admin page.
The Vault app (another developer, Next.js) owns: `/r/{ringId}` pages, gift flow, claim, video, timeline.
Do not build Vault UI or claim logic here.

The seam is the ring record. Field names and status values are a shared contract: never rename or add a status without the developer confirming it was agreed with the other developer.

## Status state machine

`UNCLAIMED` -> `SEALED_GIFT` -> `ACTIVE_CLAIMED`, plus `VOID`.

| Transition | Who may do it |
|---|---|
| (create) -> `UNCLAIMED` | this app, on `orders/paid` |
| `UNCLAIMED` -> `VOID` | this app, on `orders/cancelled` |
| `UNCLAIMED` -> `SEALED_GIFT` -> `ACTIVE_CLAIMED` | Vault app only |

This app never writes `SEALED_GIFT` or `ACTIVE_CLAIMED`, and never modifies a ring in either state. Those rings hold a family's memories.

Every status change is a conditional write: the filter includes the expected current status (`where: { orderId, status: "UNCLAIMED" }`). Never read-then-write; the Vault app can claim a ring between the read and the write.

There is no defined state after `ACTIVE_CLAIMED` (pass-it-on, brief gap #5). Do not invent one.

## Record shape

```ts
{
  id: "K7M9XQ2PR4TB",        // the ring ID is the primary key
  status: "UNCLAIMED",
  shop: "xxx.myshopify.com",
  order: { id: "gid://shopify/Order/123", name: "#1001",
           lineItemId: "gid://shopify/LineItem/456", unitIndex: 0 },
  qr: { png: null, svg: null },   // object-storage keys, filled in later
  createdAt, updatedAt
}
```

Indexes:
- unique `(order.lineItemId, order.unitIndex)`: the real duplicate guard
- `(order.id)`: cancellation lookup
- `(status)`

`webhook_events`: `{ id: <webhook id>, topic, receivedAt }`, TTL 30 days on `receivedAt`.

## Invariants

1. **Never store a URL that contains the vault domain.** Store the ring ID only. Build `${VAULT_BASE_URL}/r/${ringId}` at runtime through one helper. The domain is engraved on metal and the client will change it before production.
2. **`VAULT_BASE_URL` comes from the environment.** No fallback value in code. Fail at startup if it is missing or not `https://`.
3. **Ring IDs are unguessable.** 12 characters from the alphabet below, generated with `node:crypto` (`randomInt`, which is unbiased). Never `Math.random`, never sequential, never derived from order data.
4. **The scan URL is a key.** Until claimed, whoever holds it can claim the vault. It may appear only on the physical ring and in the Shopify admin. Never in customer emails, the order status page, storefront-readable metafields, order notes, or logs. Log the ring ID's last 4 characters at most.
5. **Uniqueness is enforced by the database, not by application checks.** Insert and treat a duplicate-key error as "already done".
6. **Shopify access tokens are encrypted at rest.** Sessions are stored through `app/db/session-storage.server.ts` (AES-256-GCM, key in `TOKEN_ENCRYPTION_KEY`). Never add a second place that stores a token.
7. **No binary data in the database.** QR images and anything else binary go to object storage; the record holds the key.

## Ring ID alphabet

`23456789ABCDEFGHJKMNPQRSTVWXYZ` (30 characters): Crockford base32 with `0` and `1` also removed, following the brief's "no 0/O, no 1/I/L". About 59 bits for 12 characters.

The developer approved this alphabet; it still has to be confirmed with the Vault developer before the first production ring exists, because IDs are permanent. It lives in `app/rings/ring-id.ts` only, with the validator `/^[2-9A-HJKMNP-TV-Z]{12}$/`.

On an ID collision at insert, generate a new ID and retry a small bounded number of times.

## Storage

MongoDB (developer's decision), through the official `mongodb` driver. Collections: `rings` (shared with the Vault app), and `ring_orders`, `webhook_events`, `shopify_sessions` (this app only). Indexes are created in `ensureIndexes` in `app/db/mongo.server.ts`.

All ring persistence goes through the `RingRepository` interface in `app/rings/ring-repository.server.ts`. Routes and services never use a collection directly. The interface exposes intent, not queries:

- `ensureRingsForOrder`: idempotent; one ring per unit, returns the order's rings
- `findRingById`, `findRingsByOrderId(s)`
- `voidUnclaimedByOrderId`: one conditional update
- `recordWebhookEvent` / `forgetWebhookEvent`
- `queueWriteback`, `requeueWriteback`, `claimDueWritebacks`, `claimWriteback`, `completeWriteback`, `failWriteback`: the durable write-back queue (`ring_orders`)
- `listOrders`: admin page, always scoped by shop

Services take the repository as a parameter so tests can run them against a real in-memory MongoDB (`test/mongo.test.ts`). New persistence needs a new interface method, not a direct query in a route.

The shared contract with the Vault app is written down in `docs/RING_CONTRACT.md`. Update it in the same change as any change to the ring record.

## Open items that block work

Ask the developer instead of guessing: the final production domain, the hosting target, and whether the Vault app has agreed to `docs/RING_CONTRACT.md` (shared MongoDB, or the optional read API at `/api/rings/:ringId`). Ring products are marked with the tag in `RING_PRODUCT_TAG` (default `has_vault_ring`).
