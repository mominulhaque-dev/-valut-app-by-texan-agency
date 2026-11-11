import { isRingId } from "./ring-id";

const SCAN_URL_PATTERN = /^https:\/\/[^/?#]+\/r\/[2-9A-HJKMNP-TV-Z]{12}$/;

/**
 * The single place a scan URL is built. The database stores ring IDs only;
 * the domain comes from VAULT_BASE_URL at runtime because it will change
 * before production and is permanent once engraved.
 */
export function buildScanUrl(vaultBaseUrl: string, ringId: string): string {
  if (!isRingId(ringId)) throw new Error("Invalid ring ID");
  const url = `${vaultBaseUrl}/r/${ringId}`;
  if (!SCAN_URL_PATTERN.test(url)) {
    throw new Error("Scan URL is malformed; check VAULT_BASE_URL");
  }
  return url;
}
