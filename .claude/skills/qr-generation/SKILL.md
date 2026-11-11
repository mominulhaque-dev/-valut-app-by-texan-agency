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

The `qrcode` npm package covers this (`toBuffer` for PNG, `toString({ type: "svg" })` for SVG, options `errorCorrectionLevel: "M"`, `margin: 4`). Adding it is a dependency change: say so when you do it.

## Storage

- Upload to object storage (`STORAGE_BUCKET`), not the database and not the app's local disk.
- Keys are deterministic: `qr/{ringId}.png`, `qr/{ringId}.svg`. Re-running generation overwrites the same objects, which makes it safe to retry.
- Save the keys on the ring (`qr.png`, `qr.svg`), not full URLs.
- The bucket is private. A QR image is as sensitive as the scan URL itself. Admin download links are short-lived signed URLs, or streamed through an `authenticate.admin` route.
- The storage provider is not chosen yet. Put uploads behind a small interface (`put(key, body, contentType)`, `getSignedUrl(key)`), the same way the database is.

## Where it runs

Outside the webhook request (see `shopify-webhooks`). Generation is idempotent: a ring with `qr.png == null` is pending; set the keys only after both uploads succeed.

## Tests that must exist

- Decode the generated PNG in a test (for example with `jsqr`) and assert it equals the expected URL exactly.
- The SVG contains no `<image>` and no `<text>` element.
- Rendering rejects a malformed ring ID and a non-https base URL.

A passing decode test does not replace the physical check in brief Phase 8: a real phone, poor light, printed at the real disc size. Report that check as not done until the developer confirms he did it.
