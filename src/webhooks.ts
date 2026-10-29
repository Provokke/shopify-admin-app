import { createHmac, timingSafeEqual } from "node:crypto";
import { MemorySessionStore, type SessionStore } from "./session-store.js";

export type WebhookResult = "processed" | "duplicate" | "rejected";

/** Claim/release semantics: a delivery id is claimed before processing and released if processing throws. */
export interface WebhookIdStore {
  claim(id: string): Promise<boolean>;
  release(id: string): Promise<void>;
}

export class MemoryWebhookIdStore implements WebhookIdStore {
  private readonly seen = new Set<string>();
  async claim(id: string): Promise<boolean> {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    return true;
  }
  async release(id: string): Promise<void> {
    this.seen.delete(id);
  }
}

export interface WebhookDeps {
  sessions: SessionStore;
  ids?: WebhookIdStore;
  /** Called for customers/data_request, customers/redact and shop/redact. Do your real data work here. */
  onGdpr?: (topic: string, payload: Record<string, unknown>) => Promise<void>;
}

export type WebhookHandler = (
  topic: string,
  rawBody: Buffer,
  hmacHeader: string,
  secret: string,
  webhookId: string,
  /** X-Shopify-Triggered-At, used to ignore uninstall events older than the current install. */
  triggeredAt?: string,
) => Promise<WebhookResult>;

export function verifyWebhookHmac(rawBody: Buffer, hmacHeader: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(hmacHeader, "base64");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const GDPR_TOPICS = new Set(["customers/data_request", "customers/redact", "shop/redact"]);

export function createWebhookHandler(deps: WebhookDeps): WebhookHandler {
  const ids = deps.ids ?? new MemoryWebhookIdStore();

  return async (topic, rawBody, hmacHeader, secret, webhookId, triggeredAt) => {
    // 1. Authenticate on the raw bytes before anything else. Forged requests must not consume ids.
    if (!hmacHeader || !verifyWebhookHmac(rawBody, hmacHeader, secret)) return "rejected";

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
    } catch {
      return "rejected";
    }

    // 2. Shopify delivers at-least-once: claim the id, drop repeats.
    if (!(await ids.claim(webhookId))) return "duplicate";

    try {
      if (topic === "app/uninstalled") {
        const shop = String(payload.myshopify_domain ?? "");
        const session = shop ? await deps.sessions.get(shop) : undefined;
        if (session) {
          // Out-of-order delivery: an uninstall that happened before the current install must not
          // delete the fresh session.
          const at = triggeredAt ? Date.parse(triggeredAt) : NaN;
          if (!Number.isNaN(at) && at < session.installedAt) return "processed";
          await deps.sessions.delete(shop);
        }
      } else if (GDPR_TOPICS.has(topic)) {
        await deps.onGdpr?.(topic, payload);
        if (topic === "shop/redact") {
          const shop = String(payload.shop_domain ?? "");
          if (shop) await deps.sessions.delete(shop);
        }
      }
      // Unknown topics are acknowledged: a 4xx/5xx would make Shopify retry and eventually drop the subscription.
      return "processed";
    } catch (e) {
      await ids.release(webhookId); // let Shopify's retry run the work again
      throw e;
    }
  };
}

const defaultSessions = new MemorySessionStore();
/** Handler wired to an in-memory session store; prefer createWebhookHandler with your own deps. */
export const handleWebhook: WebhookHandler = createWebhookHandler({ sessions: defaultSessions });
