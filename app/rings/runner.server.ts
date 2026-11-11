import { getConfig } from "../config.server";
import { unauthenticated } from "../shopify.server";
import { ringRepository } from "./ring-repository.server";
import {
  processDueWritebacks,
  processWritebackNow,
  type GetAdmin,
} from "./writeback.server";

/**
 * Wires the write-back queue to the real Shopify client and database.
 *
 * The queue lives in MongoDB (ring_orders), so nothing is lost if the process
 * dies between answering a webhook and writing to the order: the next sweep,
 * from any process, picks the order up again.
 */
const getAdmin: GetAdmin = async (shop) => {
  // Throws when the shop has no stored session (app uninstalled); the order
  // then stays queued and is retried later.
  const { admin } = await unauthenticated.admin(shop);
  return admin;
};

const deps = () => ({ repo: ringRepository, getAdmin, config: getConfig() });

export function sweepWritebacks() {
  return processDueWritebacks(deps());
}

export function retryWritebackNow(orderId: string) {
  return processWritebackNow(orderId, deps());
}

/**
 * Fire-and-forget trigger used after a webhook has been answered. It must
 * never throw into the request; failures are already recorded on the order.
 */
export function kickWritebacks(): void {
  void sweepWritebacks().catch((error) => {
    console.error(
      `Ring write-back sweep failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  });
}

const SWEEP_INTERVAL_MS = 60_000;

declare global {
  // eslint-disable-next-line no-var
  var __ringSweeper: NodeJS.Timeout | undefined;
}

/**
 * Background sweep for long-running servers (Docker, VPS). On serverless
 * hosts timers do not survive between requests; call POST /internal/sweep
 * from a scheduler there instead.
 */
export function startWritebackSweeper(): void {
  if (globalThis.__ringSweeper) return;
  globalThis.__ringSweeper = setInterval(kickWritebacks, SWEEP_INTERVAL_MS);
  globalThis.__ringSweeper.unref();
}
