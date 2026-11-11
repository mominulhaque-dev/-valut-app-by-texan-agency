import { createHmac } from "node:crypto";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Drives the real route modules (real Shopify library, real MongoDB) with
 * hand-built requests, the way Shopify would deliver them.
 */
const SECRET = "test_api_secret";
const SHOP = "dev-store.myshopify.com";
const ORDER = "gid://shopify/Order/9001";

let server: MongoMemoryServer;
let cancelled: typeof import("../app/routes/webhooks.orders.cancelled");
let paidRoute: typeof import("../app/routes/webhooks.orders.paid");
let qrRoute: typeof import("../app/routes/qr.$file");
let apiRoute: typeof import("../app/routes/api.rings.$ringId");
let sweepRoute: typeof import("../app/routes/internal.sweep");
let mongo: typeof import("../app/db/mongo.server");
let links: typeof import("../app/rings/qr-links.server");
let repoModule: typeof import("../app/rings/ring-repository.server");

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  Object.assign(process.env, {
    DATABASE_URL: server.getUri(),
    DATABASE_NAME: "routes_test",
    VAULT_BASE_URL: "https://vault.example.com",
    SHOPIFY_APP_URL: "https://app.example.com",
    SHOPIFY_API_KEY: "test_api_key",
    SHOPIFY_API_SECRET: SECRET,
    SCOPES: "read_orders,write_orders,read_products",
    TOKEN_ENCRYPTION_KEY: "cd".repeat(32),
    VAULT_API_KEY: "vault-key",
    CRON_SECRET: "cron-key",
  });
  mongo = await import("../app/db/mongo.server");
  links = await import("../app/rings/qr-links.server");
  repoModule = await import("../app/rings/ring-repository.server");
  cancelled = await import("../app/routes/webhooks.orders.cancelled");
  paidRoute = await import("../app/routes/webhooks.orders.paid");
  qrRoute = await import("../app/routes/qr.$file");
  apiRoute = await import("../app/routes/api.rings.$ringId");
  sweepRoute = await import("../app/routes/internal.sweep");
});

afterAll(async () => {
  await globalThis.__ringMongo?.client.close();
  await server?.stop();
});

function webhook(topic: string, body: string, options: { id?: string; hmac?: string } = {}) {
  const hmac = options.hmac ?? createHmac("sha256", SECRET).update(body, "utf8").digest("base64");
  return new Request(`https://app.example.com/webhooks/${topic}`, {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Hmac-Sha256": hmac,
      "X-Shopify-Topic": topic,
      "X-Shopify-Shop-Domain": SHOP,
      "X-Shopify-API-Version": "2026-07",
      "X-Shopify-Webhook-Id": options.id ?? "delivery-1",
    },
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const args = (request: Request, params: Record<string, string> = {}) => ({ request, params, context: {} }) as any;

/** Routes signal auth failures by throwing a Response. */
async function status(run: () => Promise<Response>): Promise<number> {
  try {
    return (await run()).status;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown.status;
    throw thrown;
  }
}

async function seedRings() {
  const { rings } = await mongo.getCollections();
  await rings.deleteMany({});
  return repoModule.ringRepository.ensureRingsForOrder({
    shop: SHOP,
    orderId: ORDER,
    orderName: "#9001",
    units: [
      { lineItemId: "gid://shopify/LineItem/1", unitIndex: 0 },
      { lineItemId: "gid://shopify/LineItem/1", unitIndex: 1 },
    ],
  });
}

const cancelBody = JSON.stringify({ admin_graphql_api_id: ORDER, name: "#9001" });

describe("webhook verification", () => {
  it("answers 401 to a tampered body and changes nothing", async () => {
    await seedRings();
    const good = createHmac("sha256", SECRET).update(cancelBody).digest("base64");
    const tampered = cancelBody.replace("9001", "9002");
    const code = await status(() =>
      cancelled.action(args(webhook("orders/cancelled", tampered, { hmac: good, id: "tamper-1" }))),
    );
    expect(code).toBe(401);

    const { rings, webhookEvents } = await mongo.getCollections();
    expect(await rings.countDocuments({ status: "UNCLAIMED" })).toBe(2);
    expect(await webhookEvents.countDocuments({ _id: "tamper-1" })).toBe(0);
  });

  it("answers 401 to a wrong or missing signature on orders/paid", async () => {
    const body = JSON.stringify({ admin_graphql_api_id: ORDER, line_items: [] });
    expect(
      await status(() => paidRoute.action(args(webhook("orders/paid", body, { hmac: "AAAA" })))),
    ).toBe(401);
    const unsigned = webhook("orders/paid", body);
    unsigned.headers.delete("X-Shopify-Hmac-Sha256");
    expect([400, 401]).toContain(await status(() => paidRoute.action(args(unsigned))));
  });
});

describe("orders/cancelled end to end", () => {
  it("voids unclaimed rings, spares a claimed ring, and ignores a replay", async () => {
    const [first, second] = await seedRings();
    const { rings, webhookEvents } = await mongo.getCollections();
    await rings.updateOne({ _id: second._id }, { $set: { status: "ACTIVE_CLAIMED" } });

    const response = await cancelled.action(
      args(webhook("orders/cancelled", cancelBody, { id: "cancel-1" })),
    );
    expect(response.status).toBe(200);
    expect((await rings.findOne({ _id: first._id }))?.status).toBe("VOID");
    expect((await rings.findOne({ _id: second._id }))?.status).toBe("ACTIVE_CLAIMED");
    expect(await webhookEvents.countDocuments({ _id: "cancel-1" })).toBe(1);

    // Same delivery again: put the ring back to prove the replay does nothing.
    await rings.updateOne({ _id: first._id }, { $set: { status: "UNCLAIMED" } });
    const replay = await cancelled.action(
      args(webhook("orders/cancelled", cancelBody, { id: "cancel-1" })),
    );
    expect(replay.status).toBe(200);
    expect((await rings.findOne({ _id: first._id }))?.status).toBe("UNCLAIMED");
  });
});

describe("QR download route", () => {
  const get = (url: string) => {
    const file = new URL(url).pathname.split("/").pop()!;
    return qrRoute.loader(args(new Request(url), { file }));
  };
  const config = { appUrl: "https://app.example.com", apiSecret: SECRET };

  it("serves SVG and PNG for a valid signed link", async () => {
    const [ring] = await seedRings();
    const svg = await get(links.buildQrLink(config, ring._id, "svg"));
    expect(svg.status).toBe(200);
    expect(svg.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(svg.headers.get("Cache-Control")).toContain("no-store");
    expect(await svg.text()).toContain("<path");

    const png = await get(links.buildQrLink(config, ring._id, "png"));
    expect(png.status).toBe(200);
    expect(new Uint8Array(await png.arrayBuffer()).slice(1, 4)).toEqual(
      new Uint8Array([0x50, 0x4e, 0x47]),
    );
  });

  it("answers 404 without a valid signature, for unknown rings and for void rings", async () => {
    const [ring] = await seedRings();
    const good = links.buildQrLink(config, ring._id, "svg");
    expect((await get(good.replace(/sig=.*/, "sig=wrong"))).status).toBe(404);
    expect((await get(good.replace(/\?sig=.*/, ""))).status).toBe(404);
    expect((await get(links.buildQrLink(config, "ZZZZZZZZZZZZ", "svg"))).status).toBe(404);

    const { rings } = await mongo.getCollections();
    await rings.updateOne({ _id: ring._id }, { $set: { status: "VOID" } });
    expect((await get(good)).status).toBe(404);
  });
});

describe("Vault status API", () => {
  const get = (ringId: string, key?: string) =>
    apiRoute.loader(
      args(
        new Request(`https://app.example.com/api/rings/${ringId}`, {
          headers: key ? { Authorization: `Bearer ${key}` } : {},
        }),
        { ringId },
      ),
    );

  it("requires the bearer key", async () => {
    const [ring] = await seedRings();
    expect((await get(ring._id)).status).toBe(401);
    expect((await get(ring._id, "wrong")).status).toBe(401);
  });

  it("returns only the ID and status", async () => {
    const [ring] = await seedRings();
    const response = await get(ring._id, "vault-key");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: ring._id, status: "UNCLAIMED" });
    expect((await get("ZZZZZZZZZZZZ", "vault-key")).status).toBe(404);
    expect((await get("not-an-id", "vault-key")).status).toBe(404);
  });
});

describe("sweep endpoint", () => {
  const post = (key?: string) =>
    sweepRoute.action(
      args(
        new Request("https://app.example.com/internal/sweep", {
          method: "POST",
          headers: key ? { Authorization: `Bearer ${key}` } : {},
        }),
      ),
    );

  it("requires the cron secret", async () => {
    expect((await post()).status).toBe(401);
    expect((await post("wrong")).status).toBe(401);
    expect((await post("cron-key")).status).toBe(200);
  });
});
