import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Session } from "./session-store.js";

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export function isValidShop(shop: string): boolean {
  return SHOP_RE.test(shop);
}

/**
 * Verifies the `hmac` query parameter Shopify adds to OAuth redirects:
 * HMAC-SHA256 (hex) over the other params, sorted by key, joined as k=v with &.
 */
export function verifyOAuthHmac(query: Record<string, string>, secret: string): boolean {
  const { hmac, ...rest } = query;
  if (!hmac) return false;
  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join("&");
  const expected = createHmac("sha256", secret).update(message).digest();
  let given: Buffer;
  try {
    given = Buffer.from(hmac, "hex");
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function createState(): string {
  return randomBytes(16).toString("hex");
}

export interface OAuthConfig {
  apiKey: string;
  apiSecret: string;
  scopes: string;
  /** Where to reach a shop's Shopify host. Defaults to https://<shop>; the demo points it at the mock. */
  shopBaseUrl?: (shop: string) => string;
}

export function shopUrl(cfg: OAuthConfig, shop: string): string {
  return (cfg.shopBaseUrl ?? ((s) => `https://${s}`))(shop);
}

export function buildInstallUrl(cfg: OAuthConfig, shop: string, redirectUri: string, state: string): string {
  const q = new URLSearchParams({ client_id: cfg.apiKey, scope: cfg.scopes, redirect_uri: redirectUri, state });
  return `${shopUrl(cfg, shop)}/admin/oauth/authorize?${q.toString()}`;
}

export async function exchangeCodeForSession(
  cfg: OAuthConfig,
  shop: string,
  code: string,
  opts: { fetch?: typeof fetch; now?: () => number } = {},
): Promise<Session> {
  const f = opts.fetch ?? fetch;
  const res = await f(`${shopUrl(cfg, shop)}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: cfg.apiKey, client_secret: cfg.apiSecret, code }),
  });
  if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status}`);
  const json = (await res.json()) as { access_token?: string; scope?: string };
  if (!json.access_token) throw new Error("token exchange returned no access_token");
  return { shop, accessToken: json.access_token, scope: json.scope ?? cfg.scopes, installedAt: (opts.now ?? Date.now)() };
}
