@AGENTS.md

# Kindest Regards ring service

This app reacts to paid Shopify orders, creates one ring record per purchased unit, generates QR codes, writes them back onto the order, and gives the packing team a small admin page. The full plan, decisions and open questions are in `PROJECT_BRIEF.md`: read it before the first change in a session.

## Working rules

- Reply to the developer in Bangla. Code, file names, comments and commit messages stay in English.
- The developer is a senior Shopify developer. Skip Shopify basics; explain Node backend, webhook, OAuth and database details carefully.
- Never log in to Shopify, the Partner/Dev Dashboard or any store, and never enter credentials. When a step needs a browser or an admin login, stop and give click-by-click instructions.
- Build and test on the developer's dev store only. Nothing touches the client's store before brief Phase 9, and only after the developer says so.
- The Vault app (`/r/{ringId}` pages, gift flow, claim, video) belongs to another developer. Do not build it here.
- Decided by the developer: MongoDB, the 30-character ring ID alphabet, the app-owned (`$app`) order metafield. Still open and his to decide: final domain, hosting, client store domain.

## Hard invariants

These are the short form; the skills hold the detail.

- The ring ID is the only thing stored. Vault URLs are built at runtime from `VAULT_BASE_URL`, which has no default in code.
- Ring IDs are 12 random characters from `node:crypto`, never sequential or derived.
- This app writes ring status `UNCLAIMED` and `VOID` only, and voids only rings that are still `UNCLAIMED`, in one conditional update.
- Every webhook goes through `authenticate.webhook(request)` first and is de-duplicated by webhook ID; duplicate rings are blocked by a unique database index.
- Scan URLs, QR images, webhook payloads and access tokens never reach logs, customers, or the storefront.

## Skills and agents

| Name | Use |
|---|---|
| `ring-domain` | ring record, status machine, ID format, storage interface |
| `shopify-webhooks` | subscriptions, verification, idempotency, deferred work |
| `qr-generation` | QR render settings, storage, tests |
| `order-writeback` | app-owned `rings` order metafield and `rings-ready` tag |
| `/phase-check [n]` | prove a brief phase is done before starting the next |
| `ring-invariant-reviewer` agent | read-only review against the invariants; run after ring, webhook, QR or write-back changes |

## Commands

- `npm run dev`: `shopify app dev` (tunnel, OAuth, webhook subscriptions)
- `npm run typecheck`, `npm run lint`, `npm run build`
- `npm test`: unit and integration tests (real in-memory MongoDB)

## Layout

- `app/rings/`: ring ID, QR, order events, write-back queue, repository
- `app/db/`: MongoDB connection and indexes, encrypted session storage
- `app/routes/`: `webhooks.orders.*.tsx`, `qr.$file.tsx`, `api.rings.$ringId.tsx`, `internal.sweep.tsx`, `app._index.tsx` (packing page)
- `docs/RING_CONTRACT.md`: the agreement with the Vault app; change it together with the ring record
- `.env.example`: every environment variable
