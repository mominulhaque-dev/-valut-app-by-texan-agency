import { createHmac, timingSafeEqual } from "node:crypto";
import { isRingId } from "./ring-id";
import type { QrFormat } from "./qr.server";

/**
 * Signed, stable download links for QR images.
 *
 * QR images are rendered on demand, so there is no bucket to protect; instead
 * the download route only answers when the link carries a valid signature.
 * That stops anyone from probing /qr/<guess>. A signed link is as sensitive
 * as the scan URL itself and belongs only in the Shopify admin.
 */
function signingKey(apiSecret: string): Buffer {
  // Derived, so the raw API secret is never used for a second purpose.
  return createHmac("sha256", apiSecret).update("ring-qr-link:v1").digest();
}

function sign(apiSecret: string, ringId: string, format: QrFormat): string {
  return createHmac("sha256", signingKey(apiSecret))
    .update(`${ringId}.${format}`)
    .digest("base64url");
}

export function buildQrLink(
  config: { appUrl: string; apiSecret: string },
  ringId: string,
  format: QrFormat,
): string {
  if (!isRingId(ringId)) throw new Error("Invalid ring ID");
  const sig = sign(config.apiSecret, ringId, format);
  return `${config.appUrl}/qr/${ringId}.${format}?sig=${sig}`;
}

export function parseQrFile(file: string | undefined): { ringId: string; format: QrFormat } | null {
  const match = /^([^.]+)\.(png|svg)$/.exec(file ?? "");
  if (!match || !isRingId(match[1])) return null;
  return { ringId: match[1], format: match[2] as QrFormat };
}

export function verifyQrSignature(
  apiSecret: string,
  ringId: string,
  format: QrFormat,
  sig: string | null,
): boolean {
  if (!sig) return false;
  const expected = Buffer.from(sign(apiSecret, ringId, format));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
