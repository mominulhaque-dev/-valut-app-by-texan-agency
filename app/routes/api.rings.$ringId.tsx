import type { LoaderFunctionArgs } from "react-router";
import { getConfig } from "../config.server";
import { hasBearer } from "../rings/bearer.server";
import { isRingId } from "../rings/ring-id";
import { ringRepository } from "../rings/ring-repository.server";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

/**
 * GET /api/rings/<ringId>  (Authorization: Bearer VAULT_API_KEY)
 *
 * Read-only status lookup for the Vault app's server, for the case where it
 * does not read MongoDB directly. Disabled (404) until VAULT_API_KEY is set.
 * It must only ever be called server-to-server: the key must never reach a
 * browser.
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { vaultApiKey } = getConfig();
  if (!vaultApiKey) return new Response(null, { status: 404 });
  if (!hasBearer(request, vaultApiKey)) return new Response(null, { status: 401 });

  if (!isRingId(params.ringId)) return json({ status: "NOT_FOUND" }, 404);
  const ring = await ringRepository.findRingById(params.ringId);
  if (!ring) return json({ status: "NOT_FOUND" }, 404);

  return json({ id: ring._id, status: ring.status });
};
