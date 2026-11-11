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
6. **Shopify access tokens are encrypted at rest.** The template's Prisma `Session.accessToken` is plaintext; that has to be dealt with before production.
7. **No binary data in the database.** QR images and anything else binary go to object storage; the record holds the key.

## Ring ID alphabet

`23456789ABCDEFGHJKMNPQRSTVWXYZ` (30 characters): Crockford base32 with `0` and `1` also removed, following the brief's "no 0/O, no 1/I/L". About 59 bits for 12 characters.

This is an interpretation of the brief (standard Crockford keeps `0` and `1`). It must be confirmed with the developer before the first production ring exists, because IDs are permanent. Keep the alphabet in one constant, and export a validator (`/^[2-9A-HJKMNP-TV-Z]{12}$/`) for the Vault side to share.

On an ID collision at insert, generate a new ID and retry a small bounded number of times.

## Storage interface

The database is undecided (brief open item 1: MongoDB vs Firebase). The template ships Prisma with SQLite.

All ring and webhook-event persistence goes through a repository interface (for example `app/rings/ring-repository.server.ts`); route and service code never import the Prisma client or a Mongo driver directly. The interface exposes intent, not queries:

- `createRingsForOrder(rings)`: bulk insert, duplicates skipped, returns the rings that now exist for the order
- `findByOrderId(orderId)`
- `voidUnclaimedByOrderId(orderId)`: conditional update, returns count
- `setQrKeys(ringId, { png, svg })`
- `recordWebhookEvent(id, topic)`: returns `false` when already recorded

Swapping the database must mean writing one new implementation and nothing else.

## Open items that block work

Ask the developer instead of guessing: which database (blocks Phase 3), how ring products are marked (default `RING_PRODUCT_TAG=has_vault_ring`), whether the Vault app reads the DB or calls an API here (blocks Phase 7), final domain, hosting target.
