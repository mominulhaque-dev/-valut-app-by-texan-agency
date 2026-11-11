import type { LoaderFunctionArgs } from "react-router";
import { getConfig } from "../config.server";
import { parseQrFile, verifyQrSignature } from "../rings/qr-links.server";
import { renderQrPng, renderQrSvg } from "../rings/qr.server";
import { ringRepository } from "../rings/ring-repository.server";
import { buildScanUrl } from "../rings/vault-url";

const notFound = () => new Response(null, { status: 404 });

/**
 * GET /qr/<ringId>.<png|svg>?sig=...
 *
 * Renders the QR on demand from the ring ID and the current VAULT_BASE_URL,
 * so a domain change never leaves stale images behind. Every failure answers
 * 404 so the route reveals nothing about which ring IDs exist.
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const config = getConfig();
  const file = parseQrFile(params.file);
  if (!file) return notFound();

  const sig = new URL(request.url).searchParams.get("sig");
  if (!verifyQrSignature(config.apiSecret, file.ringId, file.format, sig)) {
    return notFound();
  }

  const ring = await ringRepository.findRingById(file.ringId);
  if (!ring || ring.status === "VOID") return notFound();

  const scanUrl = buildScanUrl(config.vaultBaseUrl, ring._id);
  const filename = `ring-${ring.order.name.replace(/[^A-Za-z0-9]/g, "")}-${ring.order.unitIndex + 1}-${ring._id}.${file.format}`;
  const disposition =
    new URL(request.url).searchParams.get("inline") === "1" ? "inline" : "attachment";

  const body =
    file.format === "svg" ? renderQrSvg(scanUrl) : new Uint8Array(await renderQrPng(scanUrl));

  return new Response(body, {
    headers: {
      "Content-Type": file.format === "svg" ? "image/svg+xml" : "image/png",
      "Content-Disposition": `${disposition}; filename="${filename}"`,
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "Referrer-Policy": "no-referrer",
    },
  });
};
