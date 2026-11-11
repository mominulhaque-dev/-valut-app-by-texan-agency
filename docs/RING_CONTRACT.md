# Ring contract: Shopify ring service and Vault app

This is the agreement between the two codebases that share ring records. Neither side changes a field name, a status value or the ID format without the other agreeing first.

Status: proposed by the ring service side. Items marked **to confirm** need a yes from the Vault side.

## Who does what

| | Ring service (Shopify app) | Vault app (Next.js) |
|---|---|---|
| Creates rings | Yes, when an order is paid | No |
| Sets `UNCLAIMED` | Yes, at creation | No |
| Sets `VOID` | Yes, when an order is cancelled, only if the ring is still `UNCLAIMED` | No |
| Sets `SEALED_GIFT`, `ACTIVE_CLAIMED` | Never | Yes |
| Changes a ring that is `SEALED_GIFT` or `ACTIVE_CLAIMED` | Never | Yes |
| Deletes rings | Never | Never |

## Scan URL

```
{VAULT_BASE_URL}/r/{ringId}
```

No query string and no trailing slash. This exact string is engraved on the ring and cannot change afterwards, so the Vault app must serve `/r/{ringId}` on the final production domain for as long as rings exist. **To confirm:** the final domain.

## Ring ID

- 12 characters, uppercase
- Alphabet: `23456789ABCDEFGHJKMNPQRSTVWXYZ` (30 symbols; no `0 O 1 I L U`)
- Validation regex: `^[2-9A-HJKMNP-TV-Z]{12}$`
- Random, not sequential, not derived from the order

The Vault app should reject anything that does not match the regex before querying, and should answer an unknown ID exactly like a void one, so the page does not reveal which IDs exist. **To confirm:** this alphabet, before the first production ring is made.

## Database

MongoDB, one database shared by both apps. **To confirm:** the Vault app uses this same database (not Firebase) for ring status, so `status` has a single source of truth.

### Collection `rings`

```js
{
  _id: "K7M9XQ2PR4TB",            // the ring ID
  status: "UNCLAIMED",             // UNCLAIMED | SEALED_GIFT | ACTIVE_CLAIMED | VOID
  shop: "xxx.myshopify.com",
  order: {
    id: "gid://shopify/Order/123",
    name: "#1001",
    lineItemId: "gid://shopify/LineItem/456",
    unitIndex: 0                   // quantity 3 gives 0, 1, 2
  },
  qr: { png: null, svg: null },    // reserved, currently always null
  createdAt: ISODate, updatedAt: ISODate
}
```

Indexes (created by the ring service): unique `(order.lineItemId, order.unitIndex)`, `(order.id)`, `(status)`.

The fields above are owned by the ring service; the Vault app reads them and writes only `status` and `updatedAt`. Everything the Vault app needs to store (giver name, occasion, video URL, claim details, timeline) goes in the Vault app's own collections keyed by ring ID, or in a sub-document named `vault` on the ring. The ring service never reads or writes `vault`.

Videos are never stored in MongoDB: object storage only, with the URL in the record.

### Status changes must be conditional

Both sides change status with a filter on the expected current status, in one operation:

```js
// Vault app: seal a gift
db.rings.updateOne(
  { _id: ringId, status: "UNCLAIMED" },
  { $set: { status: "SEALED_GIFT", updatedAt: new Date() } }
)
// modifiedCount 0 means the ring was not UNCLAIMED any more: show the right page for its real status
```

Allowed transitions: `UNCLAIMED -> SEALED_GIFT`, `UNCLAIMED -> ACTIVE_CLAIMED`, `SEALED_GIFT -> ACTIVE_CLAIMED`, `UNCLAIMED -> VOID`. Never read the status and then write in a second step: an order cancellation and a claim can happen at the same moment, and only a conditional update guarantees exactly one of them wins.

### Other collections

`ring_orders`, `webhook_events` and `shopify_sessions` belong to the ring service. The Vault app must not read or write them. `shopify_sessions` holds encrypted Shopify credentials.

## What `/r/{ringId}` shows

| Ring | Page |
|---|---|
| not found, or `VOID` | "This ring is not active" |
| `UNCLAIMED` | `/choose-your-journey` |
| `SEALED_GIFT` | The giver's video, then "Claim Your Vault" |
| `ACTIVE_CLAIMED` | Sign in / vault dashboard |

## Optional HTTP API

If the Vault app cannot read MongoDB directly, the ring service offers a read-only lookup, off by default:

```
GET {ring service URL}/api/rings/{ringId}
Authorization: Bearer {VAULT_API_KEY}

200 { "id": "K7M9XQ2PR4TB", "status": "UNCLAIMED" }
404 { "status": "NOT_FOUND" }
401 (missing or wrong key)
```

Call it from the Vault app's server only. The key must never be sent to a browser. There is no write API: status changes go through the database as described above.

## Security rules for both sides

- Until a ring is claimed, whoever has the scan URL can claim it. The URL appears only on the physical ring and in the Shopify admin. Never put it in an email, an SMS, the order confirmation, analytics, or logs.
- Do not log ring IDs in full.

## Not defined yet

Passing a bag on to a new family (the client's "traveling bag" requirement) has no state after `ACTIVE_CLAIMED` and no reset rule. Neither side should invent one alone; it needs a decision from the client.
