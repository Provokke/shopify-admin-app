import { describe, expect, it } from "vitest";
import { MemorySessionStore } from "../src/session-store.js";
import { createWebhookHandler } from "../src/webhooks.js";
import { SECRET, signBody } from "./helpers.js";

const shop = "demo-shop.myshopify.com";
const session = { shop, accessToken: "tok", scope: "read_products", installedAt: Date.parse("2026-01-02T00:00:00Z") };

function setup() {
  const sessions = new MemorySessionStore();
  const gdpr: string[] = [];
  const handle = createWebhookHandler({ sessions, onGdpr: async (topic) => void gdpr.push(topic) });
  return { sessions, gdpr, handle };
}
const body = (o: object) => Buffer.from(JSON.stringify(o));

describe("webhooks", () => {
  it("rejects a bad signature", async () => {
    const { handle } = setup();
    const b = body({ myshopify_domain: shop });
    expect(await handle("app/uninstalled", b, signBody(b, "wrong"), SECRET, "w0")).toBe("rejected");
  });

  it("app/uninstalled deletes the session", async () => {
    const { sessions, handle } = setup();
    await sessions.save(session);
    const b = body({ myshopify_domain: shop });
    expect(await handle("app/uninstalled", b, signBody(b), SECRET, "w1")).toBe("processed");
    expect(await sessions.get(shop)).toBeUndefined();
  });

  it("duplicate webhook id returns duplicate", async () => {
    const { handle, gdpr } = setup();
    const b = body({ shop_domain: shop });
    expect(await handle("shop/redact", b, signBody(b), SECRET, "w2")).toBe("processed");
    expect(await handle("shop/redact", b, signBody(b), SECRET, "w2")).toBe("duplicate");
    expect(gdpr).toEqual(["shop/redact"]);
  });

  it("a stale uninstall delivered after a reinstall does not delete the new session", async () => {
    const { sessions, handle } = setup();
    await sessions.save(session);
    const b = body({ myshopify_domain: shop });
    const stale = await handle("app/uninstalled", b, signBody(b), SECRET, "w3", "2026-01-01T00:00:00Z");
    expect(stale).toBe("processed");
    expect(await sessions.get(shop)).toBeDefined();
  });

  it("gdpr shop/redact is acknowledged", async () => {
    const { sessions, handle, gdpr } = setup();
    await sessions.save(session);
    const b = body({ shop_id: 1, shop_domain: shop });
    expect(await handle("shop/redact", b, signBody(b), SECRET, "w4")).toBe("processed");
    expect(gdpr).toEqual(["shop/redact"]);
    expect(await sessions.get(shop)).toBeUndefined();
    for (const [i, t] of ["customers/data_request", "customers/redact"].entries()) {
      const cb = body({ shop_domain: shop, customer: { id: 9 } });
      expect(await handle(t, cb, signBody(cb), SECRET, `g${i}`)).toBe("processed");
    }
    expect(gdpr).toHaveLength(3);
  });

  it("releases the idempotency claim when processing throws so the retry is processed", async () => {
    const sessions = new MemorySessionStore();
    let fail = true;
    const handle = createWebhookHandler({
      sessions,
      onGdpr: async () => {
        if (fail) throw new Error("db down");
      },
    });
    const b = body({ shop_domain: shop });
    await expect(handle("shop/redact", b, signBody(b), SECRET, "w5")).rejects.toThrow("db down");
    fail = false;
    expect(await handle("shop/redact", b, signBody(b), SECRET, "w5")).toBe("processed");
  });
});
