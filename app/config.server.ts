/**
 * Environment configuration, validated once.
 *
 * Nothing here has a "works anyway" fallback for values that end up engraved
 * on metal or protect access tokens: a missing value stops the server at
 * startup instead of producing a wrong QR code later.
 */

export interface AppConfig {
  /** Origin of the Vault app, no trailing slash, e.g. https://vault.example.com */
  vaultBaseUrl: string;
  /** Public URL of this app (used for QR download links). */
  appUrl: string;
  databaseUrl: string;
  /** Optional; when unset the database name in DATABASE_URL is used. */
  databaseName: string | undefined;
  /** Products carrying this tag get a ring. Compared case-insensitively. */
  ringProductTag: string;
  /** 32-byte key for encrypting Shopify tokens at rest. */
  tokenEncryptionKey: Buffer;
  apiSecret: string;
  /** Optional bearer secret for POST /internal/sweep. */
  cronSecret: string | undefined;
  /** Optional bearer secret for the Vault app's read API. */
  vaultApiKey: string | undefined;
}

export class ConfigError extends Error {}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`Missing environment variable ${name}`);
  return value;
}

function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name]?.trim() || undefined;
}

export function parseVaultBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("VAULT_BASE_URL is not a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new ConfigError("VAULT_BASE_URL must use https://");
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username) {
    throw new ConfigError(
      "VAULT_BASE_URL must be an origin only (no path, query or credentials)",
    );
  }
  return url.origin;
}

export function parseEncryptionKey(raw: string): Buffer {
  const key = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new ConfigError(
      "TOKEN_ENCRYPTION_KEY must be 32 bytes (64 hex characters or base64)",
    );
  }
  return key;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = required(env, "DATABASE_URL");
  if (!/^mongodb(\+srv)?:\/\//.test(databaseUrl)) {
    throw new ConfigError("DATABASE_URL must be a mongodb:// or mongodb+srv:// URI");
  }

  return {
    vaultBaseUrl: parseVaultBaseUrl(required(env, "VAULT_BASE_URL")),
    appUrl: required(env, "SHOPIFY_APP_URL").replace(/\/+$/, ""),
    databaseUrl,
    databaseName: optional(env, "DATABASE_NAME"),
    ringProductTag: optional(env, "RING_PRODUCT_TAG") ?? "has_vault_ring",
    tokenEncryptionKey: parseEncryptionKey(required(env, "TOKEN_ENCRYPTION_KEY")),
    apiSecret: required(env, "SHOPIFY_API_SECRET"),
    cronSecret: optional(env, "CRON_SECRET"),
    vaultApiKey: optional(env, "VAULT_API_KEY"),
  };
}

let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  cached ??= loadConfig();
  return cached;
}
