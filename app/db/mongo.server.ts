import { MongoClient, type Collection, type Db } from "mongodb";
import { getConfig } from "../config.server";
import type { RingDoc, RingOrderDoc, WebhookEventDoc } from "../rings/types";

export interface SessionDoc {
  _id: string;
  shop: string;
  /** AES-256-GCM encrypted session (see crypto.server.ts). */
  data: string;
  updatedAt: Date;
}

export interface Collections {
  rings: Collection<RingDoc>;
  ringOrders: Collection<RingOrderDoc>;
  webhookEvents: Collection<WebhookEventDoc>;
  sessions: Collection<SessionDoc>;
}

const WEBHOOK_EVENT_TTL_SECONDS = 30 * 24 * 60 * 60;

export function collectionsOf(db: Db): Collections {
  return {
    rings: db.collection<RingDoc>("rings"),
    ringOrders: db.collection<RingOrderDoc>("ring_orders"),
    webhookEvents: db.collection<WebhookEventDoc>("webhook_events"),
    sessions: db.collection<SessionDoc>("shopify_sessions"),
  };
}

/** Idempotent: safe to run on every process start. */
export async function ensureIndexes(db: Db): Promise<void> {
  const c = collectionsOf(db);
  await Promise.all([
    // The real duplicate guard: one ring per purchased unit, whatever
    // Shopify re-delivers.
    c.rings.createIndex(
      { "order.lineItemId": 1, "order.unitIndex": 1 },
      { unique: true, name: "order_unit_unique" },
    ),
    c.rings.createIndex({ "order.id": 1 }, { name: "order_id" }),
    c.rings.createIndex({ status: 1 }, { name: "status" }),
    c.ringOrders.createIndex({ shop: 1, createdAt: -1 }, { name: "shop_recent" }),
    c.ringOrders.createIndex(
      { writeback: 1, nextAttemptAt: 1 },
      { name: "writeback_queue" },
    ),
    c.webhookEvents.createIndex(
      { receivedAt: 1 },
      { expireAfterSeconds: WEBHOOK_EVENT_TTL_SECONDS, name: "received_ttl" },
    ),
    c.sessions.createIndex({ shop: 1 }, { name: "shop" }),
  ]);
}

interface MongoState {
  client: MongoClient;
  ready: Promise<Collections>;
}

declare global {
  // Survives Vite HMR in development so we do not leak connections.
  // eslint-disable-next-line no-var
  var __ringMongo: MongoState | undefined;
}

function connect(): MongoState {
  const config = getConfig();
  const client = new MongoClient(config.databaseUrl, {
    serverSelectionTimeoutMS: 5000,
    retryWrites: true,
  });
  const ready = (async () => {
    await client.connect();
    const db = client.db(config.databaseName);
    await ensureIndexes(db);
    return collectionsOf(db);
  })();
  // A failed first connection must not poison the process forever.
  ready.catch(() => {
    if (globalThis.__ringMongo?.client === client) {
      globalThis.__ringMongo = undefined;
    }
  });
  return { client, ready };
}

export function getCollections(): Promise<Collections> {
  globalThis.__ringMongo ??= connect();
  return globalThis.__ringMongo.ready;
}
