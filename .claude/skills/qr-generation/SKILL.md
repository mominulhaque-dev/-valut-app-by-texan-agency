---
name: qr-generation
description: Rules for generating and storing ring QR codes (PNG and SVG) that will be laser-engraved on a small metal disc. Load before writing or changing QR rendering, QR storage/upload code, QR download links, or anything that builds the scan URL.
---

# QR generation

The QR is engraved on metal and cannot be corrected after production. A wrong URL or an unscannable code is a recall, so this code is tested harder than the rest.

## The encoded value

`${VAULT_BASE_URL}/r/${ringId}`, built by the single URL helper described in the `ring-domain` skill.

- No query string, no trailing slash, no tracking parameters. Every extra character makes the modules smaller on the disc.
- Before rendering, assert the result matches `^https://[^/]+/r/[2-9A-HJKMNP-TV-Z]{12}$`. Refuse to render otherwise.
- Until the production domain is confirmed (brief open item 3), every generated QR is a test artifact. Do not let anything from a non-production `VAULT_BASE_URL` reach the engraver: keep the base URL's host visible in the admin page next to each QR.

## Render settings

| Setting | Value | Why |
|---|---|---|
| Error correction | `M` | `H` adds modules; a denser pattern engraves and scans worse at this size |
| Quiet zone | 4 modules | Required by the spec; scanners fail on metal without it |
| Colours | pure black on pure white | No transparency, no brand colours |
| SVG | vector paths only, `shape-rendering="crispEdges"`, no embedded raster, no fonts | The engraver needs clean geometry |
| PNG | at least 1024 px wide, integer pixels per module | Admin preview and proofs only; never sent to the engraver |

Both formats are rendered from the same matrix in the same call, so they cannot disagree.

Implementation: `app/rings/qr.server.ts`. The SVG is built by this app from the QR matrix (one path of merged horizontal runs) so its geometry is under our control; the PNG comes from the `qrcode` package with the same settings.

## No stored images

QR images are not stored. They are rendered on demand from the ring ID and the current `VAULT_BASE_URL` by `app/routes/qr.$file.tsx`. A QR is a pure function of those two values, so storing it would only create copies that go stale when the domain changes. The ring's `qr.png` / `qr.svg` fields stay `null`; they are reserved in the shared record shape.

If a bucket is ever introduced (`STORAGE_BUCKET`), keys must be deterministic (`qr/{ringId}.svg`), the bucket private, and the record must hold keys, not URLs.

## Download links

`/qr/{ringId}.{png|svg}?sig=...`, built by `buildQrLink` in `app/rings/qr-links.server.ts`.

- The signature is an HMAC over ring ID and format, with a key derived from `SHOPIFY_API_SECRET`. The route answers 404 for a missing or wrong signature, an unknown ring and a `VOID` ring, so it cannot be used to probe for ring IDs.
- A signed link is as sensitive as the scan URL. It appears only in the admin page and in the app-owned order metafield.
- Links do not expire, because the packing team may open an order days later. Rotating `SHOPIFY_API_SECRET` invalidates them; re-queue the orders' write-back to refresh the metafield.
- Responses are `Cache-Control: private, no-store`.

## Tests that must exist

These exist in `test/unit.test.ts` and `test/routes.test.ts`; keep them passing and extend them when render settings change:

- The PNG decodes (with `jsqr`) to exactly the expected URL.
- The SVG, rasterised by the test itself, decodes to exactly the expected URL, contains no `<image>` or `<text>`, and keeps the quiet zone.
- A malformed ring ID and a non-https base URL are rejected.
- The download route returns 404 without a valid signature and for void rings.

A passing decode test does not replace the physical check in brief Phase 8: a real phone, poor light, printed at the real disc size. Report that check as not done until the developer confirms he did it.
