import jsQR from "jsqr";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseVaultBaseUrl } from "../app/config.server";
import { decrypt, encrypt } from "../app/db/crypto.server";
import { buildQrLink, parseQrFile, verifyQrSignature } from "../app/rings/qr-links.server";
import { renderQrPng, renderQrSvg } from "../app/rings/qr.server";
import {
  generateRingId,
  isRingId,
  RING_ID_ALPHABET,
  RING_ID_PATTERN,
} from "../app/rings/ring-id";
import { buildScanUrl } from "../app/rings/vault-url";

const BASE = "https://vault.example.com";
const RING = "K7M9XQ2PR4TB";

describe("ring ID", () => {
  it("is 12 characters from the alphabet, with no ambiguous symbols", () => {
    expect(RING_ID_ALPHABET).toHaveLength(30);
    expect(RING_ID_ALPHABET).not.toMatch(/[01ILOU]/);
    for (let i = 0; i < 2000; i++) {
      expect(generateRingId()).toMatch(RING_ID_PATTERN);
    }
  });

  it("does not repeat and uses the whole alphabet", () => {
    const ids = new Set<string>();
    const seen = new Set<string>();
    for (let i = 0; i < 20000; i++) {
      const id = generateRingId();
      ids.add(id);
      for (const ch of id) seen.add(ch);
    }
    expect(ids.size).toBe(20000);
    expect(seen.size).toBe(RING_ID_ALPHABET.length);
  });

  it("rejects malformed IDs", () => {
    for (const bad of ["", "K7M9XQ2PR4T", "K7M9XQ2PR4TBB", "k7m9xq2pr4tb", "K7M9XQ2PR4T0", "K7M9XQ2PR4TI", 12, null]) {
      expect(isRingId(bad)).toBe(false);
    }
    expect(isRingId(RING)).toBe(true);
  });
});

describe("scan URL", () => {
  it("is base + /r/ + id, nothing else", () => {
    expect(buildScanUrl(BASE, RING)).toBe(`${BASE}/r/${RING}`);
  });

  it("refuses bad ring IDs and non-https bases", () => {
    expect(() => buildScanUrl(BASE, "nope")).toThrow();
    expect(() => buildScanUrl("http://vault.example.com", RING)).toThrow();
    expect(() => buildScanUrl(`${BASE}/app`, RING)).toThrow();
  });
});

describe("config", () => {
  const env = {
    DATABASE_URL: "mongodb://localhost/test",
    VAULT_BASE_URL: "https://vault.example.com/",
    SHOPIFY_APP_URL: "https://app.example.com/",
    SHOPIFY_API_SECRET: "secret",
    TOKEN_ENCRYPTION_KEY: "ab".repeat(32),
  };

  it("normalises a valid environment", () => {
    const config = loadConfig(env);
    expect(config.vaultBaseUrl).toBe("https://vault.example.com");
    expect(config.appUrl).toBe("https://app.example.com");
    expect(config.ringProductTag).toBe("has_vault_ring");
    expect(config.tokenEncryptionKey).toHaveLength(32);
  });

  it("has no fallback for the vault domain", () => {
    expect(() => loadConfig({ ...env, VAULT_BASE_URL: "" })).toThrow(ConfigError);
  });

  it("rejects insecure or path-carrying vault URLs and weak keys", () => {
    expect(() => parseVaultBaseUrl("http://vault.example.com")).toThrow(ConfigError);
    expect(() => parseVaultBaseUrl("https://vault.example.com/x")).toThrow(ConfigError);
    expect(() => parseVaultBaseUrl("https://vault.example.com/?a=1")).toThrow(ConfigError);
    expect(() => loadConfig({ ...env, TOKEN_ENCRYPTION_KEY: "short" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...env, DATABASE_URL: "file:dev.sqlite" })).toThrow(ConfigError);
  });
});

describe("token encryption", () => {
  const key = Buffer.alloc(32, 7);

  it("round-trips and hides the plaintext", () => {
    const sealed = encrypt("shpat_secret_token", key);
    expect(sealed).not.toContain("shpat_secret_token");
    expect(decrypt(sealed, key)).toBe("shpat_secret_token");
    expect(encrypt("shpat_secret_token", key)).not.toBe(sealed);
  });

  it("fails on a tampered value or the wrong key", () => {
    const sealed = encrypt("token", key);
    const parts = sealed.split(".");
    parts[3] = Buffer.from("other").toString("base64url");
    expect(() => decrypt(parts.join("."), key)).toThrow();
    expect(() => decrypt(sealed, Buffer.alloc(32, 8))).toThrow();
  });
});

describe("QR links", () => {
  const config = { appUrl: "https://app.example.com", apiSecret: "secret" };

  it("verifies its own links and nothing else", () => {
    const link = new URL(buildQrLink(config, RING, "svg"));
    const sig = link.searchParams.get("sig");
    expect(link.pathname).toBe(`/qr/${RING}.svg`);
    expect(verifyQrSignature("secret", RING, "svg", sig)).toBe(true);
    expect(verifyQrSignature("secret", RING, "png", sig)).toBe(false);
    expect(verifyQrSignature("secret", "K7M9XQ2PR4TC", "svg", sig)).toBe(false);
    expect(verifyQrSignature("other", RING, "svg", sig)).toBe(false);
    expect(verifyQrSignature("secret", RING, "svg", null)).toBe(false);
    expect(verifyQrSignature("secret", RING, "svg", "")).toBe(false);
  });

  it("parses only <ringId>.<png|svg>", () => {
    expect(parseQrFile(`${RING}.png`)).toEqual({ ringId: RING, format: "png" });
    expect(parseQrFile(`${RING}.gif`)).toBeNull();
    expect(parseQrFile("../etc/passwd.svg")).toBeNull();
    expect(parseQrFile(undefined)).toBeNull();
  });
});

describe("QR rendering", () => {
  const url = buildScanUrl(BASE, RING);

  it("PNG decodes to exactly the scan URL and is large enough", async () => {
    const png = PNG.sync.read(await renderQrPng(url));
    expect(png.width).toBeGreaterThanOrEqual(1024);
    expect(png.width).toBe(png.height);
    const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    expect(decoded?.data).toBe(url);
  });

  it("SVG is pure vector and decodes to exactly the scan URL", () => {
    const svg = renderQrSvg(url);
    expect(svg).not.toMatch(/<image|<text|<foreignObject|href=/);
    expect(svg).toContain('shape-rendering="crispEdges"');

    // Rasterise the path ourselves, so the SVG output is checked on its own
    // rather than against the library that produced it.
    const total = Number(/viewBox="0 0 (\d+) \d+"/.exec(svg)![1]);
    const scale = 8;
    const width = total * scale;
    const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
    const d = /<path d="([^"]+)"/.exec(svg)![1];
    for (const [, x, y, w] of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
      for (let py = Number(y) * scale; py < (Number(y) + 1) * scale; py++) {
        for (let px = Number(x) * scale; px < (Number(x) + Number(w)) * scale; px++) {
          const i = (py * width + px) * 4;
          pixels[i] = pixels[i + 1] = pixels[i + 2] = 0;
        }
      }
    }
    expect(jsQR(pixels, width, width)?.data).toBe(url);
  });

  it("keeps a 4-module quiet zone in the SVG", () => {
    const svg = renderQrSvg(url);
    const total = Number(/viewBox="0 0 (\d+) \d+"/.exec(svg)![1]);
    const d = /<path d="([^"]+)"/.exec(svg)![1];
    for (const [, x, y, w] of d.matchAll(/M(\d+) (\d+)h(\d+)/g)) {
      expect(Number(x)).toBeGreaterThanOrEqual(4);
      expect(Number(y)).toBeGreaterThanOrEqual(4);
      expect(Number(x) + Number(w)).toBeLessThanOrEqual(total - 4);
      expect(Number(y)).toBeLessThan(total - 4);
    }
  });
});
