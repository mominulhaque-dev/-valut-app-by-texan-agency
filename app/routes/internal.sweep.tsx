import type { ActionFunctionArgs } from "react-router";
import { getConfig } from "../config.server";
import { hasBearer } from "../rings/bearer.server";
import { sweepWritebacks } from "../rings/runner.server";

/**
 * POST /internal/sweep  (Authorization: Bearer CRON_SECRET)
 *
 * Processes the write-back queue. Needed only on hosts where the in-process
 * timer does not run (serverless): point a scheduler at it every minute or
 * so. Disabled (404) until CRON_SECRET is set.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { cronSecret } = getConfig();
  if (!cronSecret) return new Response(null, { status: 404 });
  if (!hasBearer(request, cronSecret)) return new Response(null, { status: 401 });

  const result = await sweepWritebacks();
  return new Response(JSON.stringify(result), {
    headers: { "Content-Type": "application/json" },
  });
};
