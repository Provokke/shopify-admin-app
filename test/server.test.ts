import { afterEach, describe, expect, it } from "vitest";
import { createMockShopify, type MockShopify } from "../src/demo/mock-shopify.js";
import { createAppServer, type AppServer } from "../src/server.js";
import { MemorySessionStore } from "../src/session-store.js";
import { signBody } from "./helpers.js";

let mock: MockShopify | undefined;
let app: AppServer | undefined;
afterEach(async () => {
  await app?.close();
  await mock?.close();
});

async function boot() {
  const m = await createMockShopify({});
  mock = m;
  const sessions = new MemorySessionStore();
  const a = await createAppServer({
    config: { apiKey: m.apiKey, apiSecret: m.apiSecret, scopes: "read_products,write_products", shopBaseUrl: () => m.url },
    sessions,
  });
  app = a;
  return { mock: m, app: a, sessions };
}

describe("app server", () => {
  it("installs through the OAuth flow, then the uninstall webhook removes the session", async () => {
    const { mock, app, sessions } = await boot();
    const res = await fetch(`${app.url}/auth?shop=${mock.shop}`);
    expect(res.status).toBe(200);
    expect((await sessions.get(mock.shop))?.accessToken).toBe(mock.accessToken);

    const body = Buffer.from(JSON.stringify({ myshopify_domain: mock.shop }));
    const send = (id: string, sig = signBody(body, mock.apiSecret)) =>
      fetch(`${app.url}/webhooks`, {
        method: "POST",
        body,
        headers: { "x-shopify-topic": "app/uninstalled", "x-shopify-hmac-sha256": sig, "x-shopify-webhook-id": id },
      });
    expect((await send("u1", "bad")).status).toBe(401);
    expect((await send("u1")).status).toBe(200);
    expect(await sessions.get(mock.shop)).toBeUndefined();
    expect((await send("u1")).status).toBe(200); // duplicate delivery is still acked
  });

  it("refuses a callback with a bad hmac or unknown state", async () => {
    const { mock, app } = await boot();
    const res = await fetch(`${app.url}/auth/callback?shop=${mock.shop}&code=x&state=nope&hmac=00`, { redirect: "manual" });
    expect(res.status).toBe(400);
  });
});
