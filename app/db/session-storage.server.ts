import { Session } from "@shopify/shopify-app-react-router/server";
import type { SessionStorage } from "@shopify/shopify-app-session-storage";
import type { Collection } from "mongodb";
import { getConfig } from "../config.server";
import { decrypt, encrypt } from "./crypto.server";
import { getCollections, type SessionDoc } from "./mongo.server";

/**
 * Shopify session storage on MongoDB.
 *
 * The whole session (access token, refresh token, user details) is stored as
 * one encrypted blob, so a database dump alone does not give Admin API access
 * to the store. Only `shop` is kept in the clear, for lookups.
 */
export class EncryptedMongoSessionStorage implements SessionStorage {
  constructor(
    private readonly collection: () => Promise<Collection<SessionDoc>>,
    private readonly key: () => Buffer,
  ) {}

  async storeSession(session: Session): Promise<boolean> {
    const sessions = await this.collection();
    const data = encrypt(
      JSON.stringify(session.toPropertyArray(true)),
      this.key(),
    );
    await sessions.updateOne(
      { _id: session.id },
      { $set: { shop: session.shop, data, updatedAt: new Date() } },
      { upsert: true },
    );
    return true;
  }

  async loadSession(id: string): Promise<Session | undefined> {
    const sessions = await this.collection();
    const doc = await sessions.findOne({ _id: id });
    return doc ? this.toSession(doc) : undefined;
  }

  async deleteSession(id: string): Promise<boolean> {
    const sessions = await this.collection();
    await sessions.deleteOne({ _id: id });
    return true;
  }

  async deleteSessions(ids: string[]): Promise<boolean> {
    const sessions = await this.collection();
    await sessions.deleteMany({ _id: { $in: ids } });
    return true;
  }

  async findSessionsByShop(shop: string): Promise<Session[]> {
    const sessions = await this.collection();
    const docs = await sessions.find({ shop }).toArray();
    return docs.map((doc) => this.toSession(doc));
  }

  async deleteSessionsByShop(shop: string): Promise<void> {
    const sessions = await this.collection();
    await sessions.deleteMany({ shop });
  }

  private toSession(doc: SessionDoc): Session {
    const entries = JSON.parse(decrypt(doc.data, this.key()));
    return Session.fromPropertyArray(entries, true);
  }
}

export const mongoSessionStorage = new EncryptedMongoSessionStorage(
  async () => (await getCollections()).sessions,
  () => getConfig().tokenEncryptionKey,
);
