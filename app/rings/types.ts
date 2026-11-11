/**
 * Shared contract with the Vault app. Field names and status values must not
 * change without agreement from both sides (see docs/RING_CONTRACT.md).
 */
export const RING_STATUSES = [
  "UNCLAIMED",
  "SEALED_GIFT",
  "ACTIVE_CLAIMED",
  "VOID",
] as const;

export type RingStatus = (typeof RING_STATUSES)[number];

export interface RingOrderRef {
  /** gid://shopify/Order/... */
  id: string;
  /** Human order name, e.g. #1001 */
  name: string;
  /** gid://shopify/LineItem/... */
  lineItemId: string;
  /** 0-based index within the line item's quantity. */
  unitIndex: number;
}

export interface RingDoc {
  /** The ring ID itself. */
  _id: string;
  status: RingStatus;
  shop: string;
  order: RingOrderRef;
  /**
   * Reserved for object-storage keys. QR images are currently rendered on
   * demand from the ring ID, so these stay null.
   */
  qr: { png: string | null; svg: string | null };
  createdAt: Date;
  updatedAt: Date;
}

export type WritebackState = "PENDING" | "DONE" | "FAILED";

/**
 * One document per order that has rings. Owned by this app only (the Vault
 * app does not read it). It is the durable queue for writing ring data back
 * to the Shopify order.
 */
export interface RingOrderDoc {
  /** gid://shopify/Order/... */
  _id: string;
  shop: string;
  orderName: string;
  writeback: WritebackState;
  attempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WebhookEventDoc {
  /** X-Shopify-Webhook-Id */
  _id: string;
  topic: string;
  receivedAt: Date;
}

/** A purchased unit that should have a ring. */
export interface RingUnit {
  lineItemId: string;
  unitIndex: number;
}
