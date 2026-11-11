import { Session } from "@shopify/shopify-app-react-router/server";
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { collectionsOf, ensureIndexes, type Collections } from "../app/db/mongo.server";
import { EncryptedMongoSessionStorage } from "../app/db/session-storage.server";
import { handleOrderCancelled, handleOrderPaid } from "../app/rings/order-events.server";
import { MAX_WRITEBACK_ATTEMPTS, MongoRingRepository } from "../app/rings/ring-repository.server";
import { RING_ID_PATTERN } from "../app/rings/ring-id";
import {
  processDueWritebacks,
  processWritebackNow,
  READY_TAG,
  type AdminGraphql,
} from "../app/rings/writeback.server";

const SHOP = "dev-store.myshopify.com";
const TAG = "has_vault_ring";
const RING_PRODUCT = 111;
const PLAIN_PRODUCT = 222;
const config = {
  vaultBaseUrl: "https://vault.example.com",
  appUrl: "https://app.example.com",
  apiSecret: "secret",
};

let server: MongoMemoryServer;
let client: MongoClient;
let c: Collections;
let repo: MongoRingRepository;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await MongoClient.connect(server.getUri());
  const db = client.db("rings_test");
  await ensureIndexes(db);
  c = collectionsOf(db);
  repo = new MongoRingRepository(async () => c);
});

afterAll(async () => {
  await client?.close();
  await server?.stop();
});

beforeEach(async () => {
  await Promise.all([
    c.rings.deleteMany({}),
    c.ringOrders.deleteMany({}),
    c.webhookEvents.deleteMany({}),
    c.sessions.deleteMany({}),
  ]);
});

const fetchProductTags = async (ids: string[]) =>
  new Map(
    ids.map((id) => [id, id.endsWith(`/${RING_PRODUCT}`) ? [TAG] : ["other"]] as [string, string[]]),
  );

function order(
  n: number,
  items: { id: number; product: number | null; quantity: number }[],
  extra: Record<string, unknown> = {},
) {
  return {
    admin_graphql_api_id: `gid://shopify/Order/${n}`,
    name: `#${n}`,
    cancelled_at: null,
    line_items: items.map((item) => ({
      id: item.id,
      admin_graphql_api_id: `gid://shopify/LineItem/${item.id}`,
      product_id: item.product,
      quantity: item.quantity,
    })),
    ...extra,
  };
}

const paid = (payload: unknown) =>
  handleOrderPaid({ shop: SHOP, payload, ringProductTag: TAG, fetchProductTags, repo });

/** Records every Admin API call and can be told to fail. */
function fakeAdmin(options: { userError?: string; throwOnce?: boolean } = {}) {
  const calls: { root: string; variables: Record<string, unknown> }[] = [];
  let shouldThrow = options.throwOnce ?? false;
  const admin: AdminGraphql = {
    async graphql(query, opts) {
      const root = /(metafieldsSet|tagsAdd|tagsRemove)\(/.exec(query)![1];
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error("network down");
      }
      calls.push({ root, variables: opts?.variables ?? {} });
      const userErrors = options.userError ? [{ field: null, message: options.userError }] : [];
      return { json: async () => ({ data: { [root]: { userErrors } } }) };
    },
  };
  return { admin, calls };
}

describe("ring creation on orders/paid", () => {
  it("creates one ring for quantity 1", async () => {
    const result = await paid(order(1001, [{ id: 1, product: RING_PRODUCT, quantity: 1 }]));
    expect(result).toEqual({ outcome: "created", ringCount: 1 });

    const [ring] = await c.rings.find().toArray();
    expect(ring._id).toMatch(RING_ID_PATTERN);
    expect(ring).toMatchObject({
      status: "UNCLAIMED",
      shop: SHOP,
      order: {
        id: "gid://shopify/Order/1001",
        name: "#1001",
        lineItemId: "gid://shopify/LineItem/1",
        unitIndex: 0,
      },
      qr: { png: null, svg: null },
    });
    // Only the ID is stored, never a URL.
    expect(JSON.stringify(ring)).not.toContain("http");
  });

  it("creates exactly 3 distinct rings for quantity 3", async () => {
    await paid(order(1002, [{ id: 2, product: RING_PRODUCT, quantity: 3 }]));
    const rings = await c.rings.find().toArray();
    expect(rings).toHaveLength(3);
    expect(new Set(rings.map((r) => r._id)).size).toBe(3);
    expect(rings.map((r) => r.order.unitIndex).sort()).toEqual([0, 1, 2]);
  });

  it("creates rings only for the ring product in a mixed cart", async () => {
    await paid(
      order(1003, [
        { id: 3, product: RING_PRODUCT, quantity: 2 },
        { id: 4, product: PLAIN_PRODUCT, quantity: 5 },
        { id: 5, product: null, quantity: 1 },
      ]),
    );
    const rings = await c.rings.find().toArray();
    expect(rings).toHaveLength(2);
    expect(rings.every((r) => r.order.lineItemId === "gid://shopify/LineItem/3")).toBe(true);
  });

  it("creates nothing and queues nothing without a ring product", async () => {
    const result = await paid(order(1004, [{ id: 6, product: PLAIN_PRODUCT, quantity: 2 }]));
    expect(result).toEqual({ outcome: "skipped", reason: "no_ring_products" });
    expect(await c.rings.countDocuments()).toBe(0);
    expect(await c.ringOrders.countDocuments()).toBe(0);
  });

  it("creates nothing for an order that is already cancelled", async () => {
    const result = await paid(
      order(1005, [{ id: 7, product: RING_PRODUCT, quantity: 1 }], {
        cancelled_at: "2026-11-11T00:00:00Z",
      }),
    );
    expect(result).toEqual({ outcome: "skipped", reason: "cancelled" });
    expect(await c.rings.countDocuments()).toBe(0);
  });

  it("a replayed delivery creates no extra rings and keeps the same IDs", async () => {
    const payload = order(1006, [{ id: 8, product: RING_PRODUCT, quantity: 2 }]);
    await paid(payload);
    const before = (await c.rings.find().toArray()).map((r) => r._id).sort();
    await paid(payload);
    await paid(payload);
    const after = (await c.rings.find().toArray()).map((r) => r._id).sort();
    expect(after).toEqual(before);
  });

  it("concurrent deliveries of the same order still give exactly one ring per unit", async () => {
    const payload = order(1007, [{ id: 9, product: RING_PRODUCT, quantity: 4 }]);
    await Promise.all(Array.from({ length: 8 }, () => paid(payload)));
    const rings = await c.rings.find().toArray();
    expect(rings).toHaveLength(4);
    expect(rings.map((r) => r.order.unitIndex).sort()).toEqual([0, 1, 2, 3]);
  });

  it("the database itself refuses a second ring for the same unit", async () => {
    await paid(order(1008, [{ id: 10, product: RING_PRODUCT, quantity: 1 }]));
    const [ring] = await c.rings.find().toArray();
    await expect(c.rings.insertOne({ ...ring, _id: "ZZZZZZZZZZZZ" })).rejects.toMatchObject({
      code: 11000,
    });
  });
});

describe("webhook de-duplication", () => {
  it("records a webhook ID once", async () => {
    expect(await repo.recordWebhookEvent("wh-1", "orders/paid")).toBe(true);
    expect(await repo.recordWebhookEvent("wh-1", "orders/paid")).toBe(false);
  });

  it("can be forgotten so a retry after a failure is processed", async () => {
    await repo.recordWebhookEvent("wh-2", "orders/paid");
    await repo.forgetWebhookEvent("wh-2");
    expect(await repo.recordWebhookEvent("wh-2", "orders/paid")).toBe(true);
  });

  it("expires events after 30 days", async () => {
    const indexes = await c.webhookEvents.indexes();
    expect(indexes.find((i) => i.name === "received_ttl")?.expireAfterSeconds).toBe(2_592_000);
  });
});

describe("cancellation", () => {
  it("voids unclaimed rings and leaves sealed and claimed rings untouched", async () => {
    const payload = order(2001, [{ id: 20, product: RING_PRODUCT, quantity: 3 }]);
    await paid(payload);
    const rings = await c.rings.find().sort({ "order.unitIndex": 1 }).toArray();
    // The Vault app has moved two of them on.
    await c.rings.updateOne({ _id: rings[1]._id }, { $set: { status: "SEALED_GIFT" } });
    await c.rings.updateOne({ _id: rings[2]._id }, { $set: { status: "ACTIVE_CLAIMED" } });

    const result = await handleOrderCancelled({ shop: SHOP, payload, repo });
    expect(result).toEqual({ voided: 1 });

    const after = await c.rings.find().sort({ "order.unitIndex": 1 }).toArray();
    expect(after.map((r) => r.status)).toEqual(["VOID", "SEALED_GIFT", "ACTIVE_CLAIMED"]);
  });

  it("does not touch other orders and is safe to replay", async () => {
    await paid(order(2002, [{ id: 21, product: RING_PRODUCT, quantity: 1 }]));
    const other = order(2003, [{ id: 22, product: RING_PRODUCT, quantity: 1 }]);
    await paid(other);

    await handleOrderCancelled({ shop: SHOP, payload: other, repo });
    expect(await handleOrderCancelled({ shop: SHOP, payload: other, repo })).toEqual({ voided: 0 });

    expect(await c.rings.countDocuments({ status: "UNCLAIMED" })).toBe(1);
    expect(await c.rings.countDocuments({ status: "VOID" })).toBe(1);
  });
});

describe("order write-back", () => {
  const deps = (admin: AdminGraphql) => ({ repo, config, getAdmin: async () => admin });

  it("sets the metafield, then the tag, and marks the order done", async () => {
    await paid(order(3001, [{ id: 30, product: RING_PRODUCT, quantity: 2 }]));
    const { admin, calls } = fakeAdmin();

    expect(await processDueWritebacks(deps(admin))).toEqual({ processed: 1, succeeded: 1 });
    expect(calls.map((call) => call.root)).toEqual(["metafieldsSet", "tagsAdd"]);

    const [metafield] = calls[0].variables.metafields as Record<string, string>[];
    expect(metafield).toMatchObject({
      ownerId: "gid://shopify/Order/3001",
      namespace: "$app",
      key: "rings",
      type: "json",
    });
    const value = JSON.parse(metafield.value);
    expect(value.version).toBe(1);
    expect(value.rings).toHaveLength(2);
    for (const ring of value.rings) {
      expect(ring.scanUrl).toBe(`https://vault.example.com/r/${ring.id}`);
      expect(ring.svg).toContain(`/qr/${ring.id}.svg?sig=`);
      expect(ring.png).toContain(`/qr/${ring.id}.png?sig=`);
    }
    expect(calls[1].variables).toEqual({ id: "gid://shopify/Order/3001", tags: [READY_TAG] });

    expect((await c.ringOrders.findOne())?.writeback).toBe("DONE");
    // Nothing left to do on the next sweep.
    expect(await processDueWritebacks(deps(admin))).toEqual({ processed: 0, succeeded: 0 });
  });

  it("does not add the tag when the metafield write is rejected, and marks the order failed", async () => {
    await paid(order(3002, [{ id: 31, product: RING_PRODUCT, quantity: 1 }]));
    const { admin, calls } = fakeAdmin({ userError: "Owner does not exist" });

    expect(await processDueWritebacks(deps(admin))).toEqual({ processed: 1, succeeded: 0 });
    expect(calls.map((call) => call.root)).toEqual(["metafieldsSet"]);

    const queued = await c.ringOrders.findOne();
    expect(queued?.writeback).toBe("FAILED");
    expect(queued?.lastError).toContain("Owner does not exist");
    // The rings are still there: the two steps are not atomic by design.
    expect(await c.rings.countDocuments()).toBe(1);
  });

  it("keeps the order queued with a backoff after a transient error, then succeeds", async () => {
    await paid(order(3003, [{ id: 32, product: RING_PRODUCT, quantity: 1 }]));
    const { admin, calls } = fakeAdmin({ throwOnce: true });

    expect(await processDueWritebacks(deps(admin))).toEqual({ processed: 1, succeeded: 0 });
    const queued = await c.ringOrders.findOne();
    expect(queued?.writeback).toBe("PENDING");
    expect(queued!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 20_000);
    // Not due yet, so an immediate sweep leaves it alone.
    expect(await processDueWritebacks(deps(admin))).toEqual({ processed: 0, succeeded: 0 });

    // The admin "retry" button does not wait for the backoff.
    expect(await processWritebackNow("gid://shopify/Order/3003", deps(admin))).toBe(true);
    expect(calls.map((call) => call.root)).toEqual(["metafieldsSet", "tagsAdd"]);
    expect((await c.ringOrders.findOne())?.writeback).toBe("DONE");
  });

  it("gives up after the maximum number of attempts", async () => {
    await paid(order(3004, [{ id: 33, product: RING_PRODUCT, quantity: 1 }]));
    const admin: AdminGraphql = {
      async graphql() {
        throw new Error("still down");
      },
    };
    for (let i = 0; i < MAX_WRITEBACK_ATTEMPTS; i++) {
      await processWritebackNow("gid://shopify/Order/3004", deps(admin));
    }
    expect((await c.ringOrders.findOne())?.writeback).toBe("FAILED");
  });

  it("keeps a missing shop session queued instead of crashing", async () => {
    await paid(order(3005, [{ id: 34, product: RING_PRODUCT, quantity: 1 }]));
    const result = await processDueWritebacks({
      repo,
      config,
      getAdmin: async () => {
        throw new Error("no session");
      },
    });
    expect(result).toEqual({ processed: 1, succeeded: 0 });
    expect((await c.ringOrders.findOne())?.writeback).toBe("PENDING");
  });

  it("after cancellation rewrites the metafield without void rings and removes the tag", async () => {
    const payload = order(3006, [{ id: 35, product: RING_PRODUCT, quantity: 2 }]);
    await paid(payload);
    await processDueWritebacks(deps(fakeAdmin().admin));

    await handleOrderCancelled({ shop: SHOP, payload, repo });
    const { admin, calls } = fakeAdmin();
    await processDueWritebacks(deps(admin));

    expect(calls.map((call) => call.root)).toEqual(["metafieldsSet", "tagsRemove"]);
    const [metafield] = calls[0].variables.metafields as Record<string, string>[];
    expect(JSON.parse(metafield.value).rings).toEqual([]);
  });

  it("re-queues only orders of the given shop", async () => {
    await paid(order(3007, [{ id: 36, product: RING_PRODUCT, quantity: 1 }]));
    expect(await repo.requeueWriteback("other.myshopify.com", "gid://shopify/Order/3007")).toBe(false);
    expect(await repo.requeueWriteback(SHOP, "gid://shopify/Order/3007")).toBe(true);
    expect(await repo.listOrders("other.myshopify.com", { limit: 10 })).toEqual([]);
    expect(await repo.listOrders(SHOP, { search: "3007", limit: 10 })).toHaveLength(1);
  });
});

describe("session storage", () => {
  const key = Buffer.alloc(32, 3);
  const storage = () => new EncryptedMongoSessionStorage(async () => c.sessions, () => key);

  const session = () =>
    new Session({
      id: `offline_${SHOP}`,
      shop: SHOP,
      state: "state",
      isOnline: false,
      scope: "read_orders,write_orders",
      accessToken: "shpat_super_secret",
      expires: new Date("2027-01-01T00:00:00Z"),
    });

  it("round-trips a session", async () => {
    await storage().storeSession(session());
    const loaded = await storage().loadSession(`offline_${SHOP}`);
    expect(loaded?.accessToken).toBe("shpat_super_secret");
    expect(loaded?.shop).toBe(SHOP);
    expect(loaded?.scope).toBe("read_orders,write_orders");
    expect(loaded?.expires?.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(await storage().findSessionsByShop(SHOP)).toHaveLength(1);
  });

  it("never stores the access token in the clear", async () => {
    await storage().storeSession(session());
    const raw = JSON.stringify(await c.sessions.find().toArray());
    expect(raw).not.toContain("shpat_super_secret");
  });

  it("deletes by id and by shop", async () => {
    await storage().storeSession(session());
    await storage().deleteSessionsByShop(SHOP);
    expect(await storage().loadSession(`offline_${SHOP}`)).toBeUndefined();
    await storage().storeSession(session());
    await storage().deleteSessions([`offline_${SHOP}`]);
    expect(await c.sessions.countDocuments()).toBe(0);
  });
});
