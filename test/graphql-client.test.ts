import { describe, expect, it } from "vitest";
import { createGraphqlClient } from "../src/graphql-client.js";
import { jsonResponse } from "./helpers.js";

const session = { shop: "demo-shop.myshopify.com", accessToken: "tok", scope: "read_products", installedAt: 0 };
const cost = (requested: number, available: number) => ({
  requestedQueryCost: requested,
  actualQueryCost: null,
  throttleStatus: { maximumAvailable: 1000, currentlyAvailable: available, restoreRate: 50 },
});

describe("graphql client", () => {
  it("client waits and retries on THROTTLED then succeeds", async () => {
    const responses = [
      jsonResponse({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }], extensions: { cost: cost(100, 20) } }),
      jsonResponse({ data: { shop: { name: "Demo" } }, extensions: { cost: cost(100, 900) } }),
    ];
    let calls = 0;
    const waits: number[] = [];
    const client = createGraphqlClient(session, {
      baseUrl: "http://shopify.test",
      fetch: async () => responses[calls++]!,
      sleep: async (ms) => void waits.push(ms),
    });
    const data = await client.query<{ shop: { name: string } }>("{ shop { name } }");
    expect(data.shop.name).toBe("Demo");
    expect(calls).toBe(2);
    // (100 requested - 20 available) / 50 per second = 1.6 s
    expect(waits).toEqual([1600]);
  });

  it("honours Retry-After on HTTP 429 and gives up after maxRetries", async () => {
    const waits: number[] = [];
    let calls = 0;
    const client = createGraphqlClient(session, {
      baseUrl: "http://shopify.test",
      maxRetries: 2,
      fetch: async () => (calls++, new Response("", { status: 429, headers: { "retry-after": "2" } })),
      sleep: async (ms) => void waits.push(ms),
    });
    await expect(client.query("{ shop { name } }")).rejects.toThrow(/throttl/i);
    expect(calls).toBe(3);
    expect(waits).toEqual([2000, 2000]);
  });

  it("throws on non-throttle GraphQL errors without retrying", async () => {
    let calls = 0;
    const client = createGraphqlClient(session, {
      baseUrl: "http://shopify.test",
      fetch: async () => (calls++, jsonResponse({ errors: [{ message: "Field 'x' doesn't exist" }] })),
      sleep: async () => {},
    });
    await expect(client.query("{ x }")).rejects.toThrow(/doesn't exist/);
    expect(calls).toBe(1);
  });
});
