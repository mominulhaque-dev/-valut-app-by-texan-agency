import { MongoServerError, type MongoBulkWriteError } from "mongodb";
import { getCollections, type Collections } from "../db/mongo.server";
import { generateRingId } from "./ring-id";
import type { RingDoc, RingOrderDoc, RingUnit } from "./types";

/**
 * The only place that talks to the database about rings. Routes and services
 * depend on this interface, so replacing MongoDB means writing one new
 * implementation.
 */
export interface RingRepository {
  /** Returns false when this webhook ID was already recorded. */
  recordWebhookEvent(id: string, topic: string): Promise<boolean>;
  /** Undo recordWebhookEvent after a failure, so Shopify's retry is processed. */
  forgetWebhookEvent(id: string): Promise<void>;

  /**
   * Makes sure exactly one ring exists for each unit. Safe to call any number
   * of times for the same order. Returns every ring of the order.
   */
  ensureRingsForOrder(input: {
    shop: string;
    orderId: string;
    orderName: string;
    units: RingUnit[];
  }): Promise<RingDoc[]>;

  findRingById(id: string): Promise<RingDoc | null>;
  findRingsByOrderId(orderId: string): Promise<RingDoc[]>;
  findRingsByOrderIds(orderIds: string[]): Promise<RingDoc[]>;

  /** Voids rings that are still UNCLAIMED. Never touches claimed rings. */
  voidUnclaimedByOrderId(orderId: string): Promise<number>;

  /** Puts the order in the write-back queue (again). */
  queueWriteback(input: {
    shop: string;
    orderId: string;
    orderName: string;
  }): Promise<void>;
  /** Re-queues an existing order of this shop. False when there is none. */
  requeueWriteback(shop: string, orderId: string): Promise<boolean>;
  /** Takes up to `limit` due orders, leasing each so no other worker takes it. */
  claimDueWritebacks(limit: number, now?: Date): Promise<RingOrderDoc[]>;
  /** Takes one specific order if it is pending, whatever its due time. */
  claimWriteback(orderId: string, now?: Date): Promise<RingOrderDoc | null>;
  completeWriteback(orderId: string, claimedAttempts: number): Promise<void>;
  failWriteback(orderId: string, error: string, permanent: boolean): Promise<void>;

  listOrders(
    shop: string,
    options: { search?: string; limit: number },
  ): Promise<RingOrderDoc[]>;
}

export const MAX_WRITEBACK_ATTEMPTS = 8;
const MAX_ID_RETRIES = 5;
const DUPLICATE_KEY = 11000;

function isDuplicateKeyError(error: unknown): boolean {
  if (!(error instanceof MongoServerError)) return false;
  // A bulk error can mix duplicates with real failures; only swallow it when
  // every individual write failed for being a duplicate.
  const writeErrors = (error as MongoBulkWriteError).writeErrors;
  if (Array.isArray(writeErrors) && writeErrors.length > 0) {
    return writeErrors.every((e) => e.code === DUPLICATE_KEY);
  }
  return error.code === DUPLICATE_KEY;
}

const unitKey = (unit: RingUnit) => `${unit.lineItemId}#${unit.unitIndex}`;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class MongoRingRepository implements RingRepository {
  constructor(private readonly collections: () => Promise<Collections>) {}

  async recordWebhookEvent(id: string, topic: string): Promise<boolean> {
    const { webhookEvents } = await this.collections();
    try {
      await webhookEvents.insertOne({ _id: id, topic, receivedAt: new Date() });
      return true;
    } catch (error) {
      if (isDuplicateKeyError(error)) return false;
      throw error;
    }
  }

  async forgetWebhookEvent(id: string): Promise<void> {
    const { webhookEvents } = await this.collections();
    await webhookEvents.deleteOne({ _id: id });
  }

  async ensureRingsForOrder(input: {
    shop: string;
    orderId: string;
    orderName: string;
    units: RingUnit[];
  }): Promise<RingDoc[]> {
    const { rings } = await this.collections();

    // The unique index decides who wins a race; this loop only works out what
    // is still missing and retries with fresh IDs after any duplicate-key
    // error (a concurrent delivery, or the very unlikely ring ID collision).
    for (let attempt = 0; ; attempt++) {
      const existing = await rings.find({ "order.id": input.orderId }).toArray();
      const have = new Set(existing.map((ring) => unitKey(ring.order)));
      const missing = input.units.filter((unit) => !have.has(unitKey(unit)));
      if (missing.length === 0) return existing;
      if (attempt >= MAX_ID_RETRIES) {
        throw new Error("Could not create rings after repeated key conflicts");
      }

      const now = new Date();
      const docs: RingDoc[] = missing.map((unit) => ({
        _id: generateRingId(),
        status: "UNCLAIMED",
        shop: input.shop,
        order: {
          id: input.orderId,
          name: input.orderName,
          lineItemId: unit.lineItemId,
          unitIndex: unit.unitIndex,
        },
        qr: { png: null, svg: null },
        createdAt: now,
        updatedAt: now,
      }));

      try {
        await rings.insertMany(docs, { ordered: false });
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
      }
    }
  }

  async findRingById(id: string): Promise<RingDoc | null> {
    const { rings } = await this.collections();
    return rings.findOne({ _id: id });
  }

  async findRingsByOrderId(orderId: string): Promise<RingDoc[]> {
    return this.findRingsByOrderIds([orderId]);
  }

  async findRingsByOrderIds(orderIds: string[]): Promise<RingDoc[]> {
    if (orderIds.length === 0) return [];
    const { rings } = await this.collections();
    return rings
      .find({ "order.id": { $in: orderIds } })
      .sort({ "order.lineItemId": 1, "order.unitIndex": 1 })
      .toArray();
  }

  async voidUnclaimedByOrderId(orderId: string): Promise<number> {
    const { rings } = await this.collections();
    // One conditional update. Reading first and writing after would race with
    // the Vault app claiming the ring in between.
    const result = await rings.updateMany(
      { "order.id": orderId, status: "UNCLAIMED" },
      { $set: { status: "VOID", updatedAt: new Date() } },
    );
    return result.modifiedCount;
  }

  async queueWriteback(input: {
    shop: string;
    orderId: string;
    orderName: string;
  }): Promise<void> {
    const { ringOrders } = await this.collections();
    const now = new Date();
    await ringOrders.updateOne(
      { _id: input.orderId },
      {
        $set: {
          writeback: "PENDING",
          attempts: 0,
          nextAttemptAt: now,
          lastError: null,
          updatedAt: now,
        },
        $setOnInsert: {
          shop: input.shop,
          orderName: input.orderName,
          createdAt: now,
        },
      },
      { upsert: true },
    );
  }

  async requeueWriteback(shop: string, orderId: string): Promise<boolean> {
    const { ringOrders } = await this.collections();
    const now = new Date();
    const result = await ringOrders.updateOne(
      { _id: orderId, shop },
      {
        $set: {
          writeback: "PENDING",
          attempts: 0,
          nextAttemptAt: now,
          lastError: null,
          updatedAt: now,
        },
      },
    );
    return result.matchedCount === 1;
  }

  async claimDueWritebacks(limit: number, now = new Date()): Promise<RingOrderDoc[]> {
    const claimed: RingOrderDoc[] = [];
    while (claimed.length < limit) {
      const doc = await this.claim({ nextAttemptAt: { $lte: now } }, now);
      if (!doc) break;
      claimed.push(doc);
    }
    return claimed;
  }

  async claimWriteback(orderId: string, now = new Date()): Promise<RingOrderDoc | null> {
    return this.claim({ _id: orderId }, now);
  }

  /**
   * Lease: pushing nextAttemptAt into the future is what stops a second
   * worker (or a crashed-and-restarted one) from taking the same order until
   * the backoff has passed.
   */
  private async claim(
    filter: Record<string, unknown>,
    now: Date,
  ): Promise<RingOrderDoc | null> {
    const { ringOrders } = await this.collections();
    return ringOrders.findOneAndUpdate(
      { ...filter, writeback: "PENDING" },
      [
        {
          $set: {
            attempts: { $add: ["$attempts", 1] },
            updatedAt: now,
            nextAttemptAt: {
              $add: [
                now,
                {
                  $min: [
                    3_600_000,
                    { $multiply: [30_000, { $pow: [2, "$attempts"] }] },
                  ],
                },
              ],
            },
          },
        },
      ],
      { returnDocument: "after", sort: { nextAttemptAt: 1 } },
    );
  }

  async completeWriteback(orderId: string, claimedAttempts: number): Promise<void> {
    const { ringOrders } = await this.collections();
    // If the order was re-queued while we were writing (attempts reset to 0),
    // leave it pending so the newer state gets written too.
    await ringOrders.updateOne(
      { _id: orderId, writeback: "PENDING", attempts: claimedAttempts },
      { $set: { writeback: "DONE", lastError: null, updatedAt: new Date() } },
    );
  }

  async failWriteback(orderId: string, error: string, permanent: boolean): Promise<void> {
    const { ringOrders } = await this.collections();
    const now = new Date();
    await ringOrders.updateOne(
      { _id: orderId, writeback: "PENDING" },
      { $set: { lastError: error.slice(0, 500), updatedAt: now } },
    );
    await ringOrders.updateOne(
      {
        _id: orderId,
        writeback: "PENDING",
        ...(permanent ? {} : { attempts: { $gte: MAX_WRITEBACK_ATTEMPTS } }),
      },
      { $set: { writeback: "FAILED", updatedAt: now } },
    );
  }

  async listOrders(
    shop: string,
    options: { search?: string; limit: number },
  ): Promise<RingOrderDoc[]> {
    const { ringOrders } = await this.collections();
    const search = options.search?.trim();
    return ringOrders
      .find({
        shop,
        ...(search
          ? { orderName: { $regex: escapeRegex(search), $options: "i" } }
          : {}),
      })
      .sort({ createdAt: -1 })
      .limit(options.limit)
      .toArray();
  }
}

export const ringRepository: RingRepository = new MongoRingRepository(getCollections);
