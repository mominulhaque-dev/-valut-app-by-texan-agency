# PROJECT BRIEF — Kindest Regards Shopify App

> Paste this whole file as your first message in the new session.
> It contains everything needed to start work. Nothing else is assumed.

---

## 0. Instructions to the assistant reading this

You are picking up a project mid-way. The planning is done; the coding has just started.
Read this whole brief before touching any file. Then:

1. Read the existing project folder and report what the Shopify CLI template generated.
2. Confirm the plan in Section 7 still fits what you find.
3. Start at Phase 2.

Working language: reply in **Bangla**. Code, file names, comments and commit messages stay in English.
The developer is a senior Shopify developer with 2 years of experience. Do not over-explain Shopify basics,
but do explain anything related to Node backends, webhooks, OAuth internals and databases carefully.

Do not log in to Shopify, Partner Dashboard or any store on his behalf, and do not enter passwords
anywhere. When an action needs a browser or an admin login, stop and give him click-by-click instructions.

---

## 1. The product

**Kindest Regards** (`kindestregards.com.au`) is an Australian Shopify store, currently
password-protected and not yet launched. It sells a reusable keepsake gift bag.

Each bag carries a **physical metal ring (hallmark disc) with a QR code**. Scanning the ring opens a
web app where a child's family stores videos and messages for **21 years** — a digital heirloom vault.

Two separate web properties exist:

| Property | Stack | Who owns it |
|---|---|---|
| `kindestregards.com.au` | Shopify | Client. Not launched yet (password page). |
| `caseyjaderingin-frontend.vercel.app` | Next.js on Vercel | Another developer. Vault app frontend, partly built. |

The Vault app already has a home page with a "ring scan" section and a `/choose-your-journey`
page offering two options: *"This is for my own child"* → `/own-child/recipient-welcome`,
and *"I'm preparing this as a gift"* → `/gift-details`.

**What is missing there:** the URL carries no ring ID yet. Today "Continue" just moves to the next
page. In the real system every ring must have its own URL.

---

## 2. The client's requirements document (summary)

The client (Casey) wrote six gaps. Only #1 has a full solution written; the rest are stated problems.

**1. Buyer vs recipient handover (fully specified).**
Grandma buys the bag but the child receives it. Flow:
- Grandma scans the ring → sees two options → picks "I am preparing this as a gift" (Giver Mode)
- She enters giver name, child's name, occasion; records a video + note
- Ring state becomes `SEALED_GIFT`. **No admin account is attached at this point.**
- On Christmas morning the parent scans the ring → the video plays full screen, no login
- A button appears: "Claim Klay's 21-Year Vault" → parent enters email/phone + child's birth date
- The birth date generates the 21-year milestone timeline
- Grandma's video is filed automatically as "Year 1 · Christmas 2026 · Gifted by Grandma"
- Grandma gets a confirmation email/SMS
- **Privacy boundary:** the giver gets no access to future private memories unless the parent
  explicitly invites her as a Contributor

Ring state machine specified by the client: `UNCLAIMED` → `SEALED_GIFT` → `ACTIVE_CLAIMED`

Metadata migrated on claim: `{ giverName, occasion, videoUrl, message, timestamp }`

**2. First scan experience.** A grandparent or a 7-year-old scans the disc. No app store download.
The browser must open an app-like PWA instantly and play the video before asking for an account.

**3. Guest contributors with no account.** Mum sends a WhatsApp/SMS link to Grandma. Grandma's
whole flow: open link → see child's photo → Record video or choose from camera roll → "Send with
Love" → done. Technically a tokenized magic link, no password.

**4. Notifications years later.** A video locked in 2026 unlocks in 2047. Emails and phone numbers
change over 21 years. Needs: a secondary recovery contact, an annual "Vault Health Check" message,
and a countdown badge inside the vault.

**5. Traveling bag (pass-it-on).** The bag moves from family to family. Needs an "Impact Passport"
(public cumulative counter: miles travelled, paper saved, gifting chain count) visible to all past
holders, while each recipient's videos stay private. Also needs protection against resetting a bag
that still holds active memories. **The client did not specify how the reset protection works, and
the state machine in #1 has no state after `ACTIVE_CLAIMED`. This is an open contradiction.**

**6. Archive export.** Parents want "Download Memory Vault" — a ZIP/MP4 export of 21 years.

The client's document says Firebase. The team has since said **MongoDB**. This must be reconciled
(see Section 6, open item 1).

---

## 3. Division of work

**This developer builds the Shopify side only:**
react to paid orders → create one ring record per purchased unit → generate QR codes →
write ring IDs and QR links back onto the order → a small admin page for the packing team.

**The other developer builds the Vault app:** `/r/{ringId}` routing, gift flow, claim ceremony,
video upload, timeline, notifications, export.

**The seam between them** is the ring record and its `status` field.
This side creates it as `UNCLAIMED`. Their side moves it to `SEALED_GIFT` and `ACTIVE_CLAIMED`.

---

## 4. Decisions already made

| Decision | Value |
|---|---|
| QR generation timing | **After the order** — generated on `orders/paid`, not pre-printed |
| App location | Created in **the developer's own Partner organization**, not the client's |
| Distribution | **Custom distribution** — install link sent to the client's store |
| Auth | **OAuth** (offline access token). Client credentials grant does NOT work here, because the client's store is in a different organization |
| Testing | Build and test fully on the **developer's own dev store** first; only then install on the client's store |
| Database | MongoDB is intended, but **not set up yet** — build behind an interface |
| Hosting | **Not decided yet** |
| Final domain | **Not decided yet** — the client will change it later |
| CLI template | `npm init @shopify/app@latest` → **"Build a React Router app (recommended)"** |

### Why the domain matters more than it looks
A QR engraved on metal can never be changed. Whatever domain is burned into the first production
run is permanent. So: read the base URL from `VAULT_BASE_URL` in the environment, never hard-code it,
and **store only the ring ID in the database — never a full URL**. Build the URL at runtime.

---

## 5. Architecture

```
Shopify store
   |  orders/paid, orders/cancelled (webhooks)
   v
Ring Service  (Node.js — the app being built)
   |
   |--> Database: rings, webhook_events, shops
   |--> Object storage: QR images (PNG + SVG)
   '--> Shopify Admin API: write order metafields
           |
           v
   Vault app (Next.js) reads ring status when /r/{ringId} is opened
```

### Data shape (storage-agnostic)

`rings`
```js
{
  _id: "K7M9XQ2PR4TB",          // the ring ID itself
  status: "UNCLAIMED",           // UNCLAIMED | SEALED_GIFT | ACTIVE_CLAIMED | VOID
  shop: "xxx.myshopify.com",
  order: {
    id: "gid://shopify/Order/123",
    name: "#1001",
    lineItemId: "gid://shopify/LineItem/456",
    unitIndex: 0                 // quantity 3 produces unitIndex 0, 1, 2
  },
  qr: { png: null, svg: null },
  createdAt, updatedAt
}
```

Required indexes:
- `(order.lineItemId, order.unitIndex)` — **unique**. This is the real duplicate guard: if Shopify
  delivers the same webhook twice, the second attempt cannot create extra rings.
- `(order.id)` — to find all rings when an order is cancelled
- `(status)`

`webhook_events`
```js
{ _id: "<X-Shopify-Webhook-Id>", topic: "orders/paid", receivedAt: ISODate() }
```
Insert first; a duplicate key error means it was already processed, so return 200 and stop.
Add a TTL index on `receivedAt` (30 days).

`shops` — holds the Shopify access token. **Encrypt the token at rest.**

### Ring ID format
12 characters, Crockford base32 (no `0/O`, no `1/I/L`), uppercase, cryptographically random.
**Never sequential** — a guessable ID would let a stranger claim someone else's vault.

---

## 6. Open items — ask the developer before building past Phase 3

| # | Question | Blocks |
|---|---|---|
| 1 | Is the whole backend MongoDB, or is the Vault app still on Firebase? If both, ring data would be split across two databases and `status` would have no single source of truth. Must be settled with the other developer. | Phase 3 |
| 2 | Does the Vault app read the database directly, or call an API on this side? | Phase 7 |
| 3 | Final production domain | First engraving run |
| 4 | The client's `myshopify.com` domain | Phase 9 |
| 5 | Which products carry a ring (tag or metafield name) | Phase 3 |
| 6 | Developer's own dev store name | Phase 1 |
| 7 | Hosting target for the backend | Deployment |

Videos must never be stored in the database — object storage only, with the URL in the record.

---

## 7. Build plan

### Phase 1 — Scaffold and install  *(IN PROGRESS)*
- App created with Shopify CLI in the developer's Partner org, React Router template
- Scopes: `read_orders`, `write_orders`, `read_products`
- `shopify app dev` → install on the dev store (CLI handles OAuth and the tunnel)
- **Done when:** one authenticated Admin API call succeeds (fetch a recent order)

### Phase 2 — Webhooks
- Subscribe to `orders/paid` and `orders/cancelled` in `shopify.app.toml`
- Verify HMAC on every request using the **raw body**, before any JSON body parser runs.
  Failure → 401 and nothing else.
- Idempotency via `webhook_events` and the `X-Shopify-Webhook-Id` header
- Return 200 fast; move slow work (QR generation, uploads) out of the request path
- **Done when:** a test order reaches the handler, verifies, and a replay is ignored

### Phase 3 — Ring creation
- On `orders/paid`, for each line item, check the ring product tag/metafield; skip other products
- One ring per unit (quantity 3 → 3 rings)
- Insert all rings for an order in one call, relying on the unique index as the duplicate guard
- **Done when:** a 2-item order creates exactly 2 rings and a replay creates none

### Phase 4 — QR generation
- URL: `${VAULT_BASE_URL}/r/${ringId}`
- Generate **both** PNG (admin preview, proofs) and SVG (engraving and print — raster will not
  engrave cleanly)
- Error correction level **M** with a quiet zone. Level H makes the pattern denser, which hurts
  on a small metal disc. Keep the URL short for the same reason.
- **Done when:** a phone scan of the generated QR opens the right URL

### Phase 5 — Write back to the order
- Order metafield: namespace `vault`, key `rings`, type `json` — ring ID, scan URL, PNG URL, SVG URL
- Also add an order tag such as `rings-ready` so the packing team can filter
- **Not atomic with Phase 3.** Write to the database first, then the metafield. If the metafield
  call fails the rings still exist and the write can be retried.
- **Done when:** the metafield is visible on the order in the Shopify admin

### Phase 6 — Cancellation
- On `orders/cancelled`, find rings by `order.id` and set `status: "VOID"` —
  **only those still `UNCLAIMED`**
- A ring already `SEALED_GIFT` or `ACTIVE_CLAIMED` holds real memories and must never be voided
  by an automated webhook
- **Done when:** cancelling voids unclaimed rings and leaves a claimed test ring untouched

### Phase 7 — Admin UI (Polaris, inside Shopify admin)
A small, functional page for the packing team: rings grouped by order, each with its status and
download links for the QR PNG and SVG. Polaris ships with the template.

**This is NOT the client's beautiful gift UI.** Those pages belong to the other developer's
Next.js app and must not be rebuilt here.

### Phase 7b — Resolver contract (agree in writing with the other developer)

| Ring status | What `/r/{ringId}` shows |
|---|---|
| not found / `VOID` | "This ring is not active" |
| `UNCLAIMED` | `/choose-your-journey` |
| `SEALED_GIFT` | Giver's video, then "Claim Your Vault" |
| `ACTIVE_CLAIMED` | Sign in / vault dashboard |

Also agree who owns the database and the field names. Neither side changes field names alone.

### Phase 8 — Test checklist (dev store, before touching the client's store)
- Single item, quantity 1
- Single item, quantity 3 → exactly 3 distinct rings
- Mixed cart: ring product + normal product → rings only for the ring product
- Same webhook delivered twice → no duplicates
- Tampered HMAC → 401
- Order cancelled → unclaimed rings voided, claimed ring untouched
- QR scanned with a real phone, in poor light, at the printed size
- Metafield visible and correctly formatted in the admin

### Phase 9 — Move to the client's store
1. Dev Dashboard → app Home → Distribution card → **Custom distribution**.
   This choice is permanent. Do not pick Public by mistake.
2. Enter the client's `myshopify.com` domain → Generate link
3. Send the link to the client with one line explaining what the app does.
   The developer has store access and could install it himself, but should tell the client first.
4. Point the app at production environment variables
5. Place one real low-value test order on the live store before launch, then refund it

---

## 8. Environment variables

```
SHOPIFY_API_KEY
SHOPIFY_API_SECRET
SCOPES=read_orders,write_orders,read_products
VAULT_BASE_URL=https://vault.example.com
DATABASE_URL
STORAGE_BUCKET
RING_PRODUCT_TAG=has_vault_ring
```

---

## 9. Risks to raise with the client early

1. **The QR link is a key.** Until a vault is claimed, whoever holds the link can claim it.
   So the link must never appear in the confirmation email or on the order status page —
   only on the physical ring and in the admin.
2. **The domain cannot change after engraving.** The final domain must be fixed before the first
   production run, and the old domain must be kept alive with a redirect forever.
3. **App ownership.** The app lives in the developer's Partner organization. Moving an app between
   organizations later is not simple. Decide now whether he maintains it long term or hands it over.
4. **Gap #5 is unresolved.** Passing the bag to a new family has no defined state after
   `ACTIVE_CLAIMED`, and no specified protection against resetting a bag that still holds memories.

---

## 10. Reference links

- Vault app frontend: https://caseyjaderingin-frontend.vercel.app/
- Client store (password-protected): https://www.kindestregards.com.au/
- Shopify: Select a distribution method —
  https://shopify.dev/docs/apps/launch/distribution/select-distribution-method
- Shopify: Verify webhook deliveries —
  https://shopify.dev/docs/apps/build/webhooks/verify-deliveries
- Shopify: About app authentication —
  https://shopify.dev/docs/apps/build/authentication-authorization
