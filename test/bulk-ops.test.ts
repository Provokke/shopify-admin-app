import { afterEach, describe, expect, it } from "vitest";
import { createGraphqlClient } from "../src/graphql-client.js";
import { runBulkMutation, runBulkQuery, METAFIELDS_SET } from "../src/bulk-ops.js";
import { createMockShopify, type MockShopify } from "../src/demo/mock-shopify.js";

let mock: MockShopify | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

async function setup() {
  const m = await createMockShopify({ productCount: 3 });
  mock = m;
  const client = createGraphqlClient(
    { shop: m.shop, accessToken: m.accessToken, scope: "read_products", installedAt: 0 },
    { baseUrl: m.url, sleep: async () => {} },
  );
  return { mock: m, client };
}

const row = (n: number, value = `v${n}`) => ({
  ownerId: `gid://shopify/Product/${n}`,
  namespace: "app",
  key: "tier",
  type: "single_line_text_field",
  value,
});

describe("bulk operations", () => {
  it("exports products as JSONL rows", async () => {
    const { client } = await setup();
    const rows: Array<Record<string, unknown>> = [];
    for await (const r of await runBulkQuery(client, "{ products { edges { node { id title } } } }", { sleep: async () => {} })) {
      rows.push(r as Record<string, unknown>);
    }
    expect(rows.filter((r) => !("__parentId" in r))).toHaveLength(3);
    expect(rows.filter((r) => "__parentId" in r).length).toBeGreaterThan(0);
  });

  it("bulk mutation does not re-apply rows after a retry", async () => {
    const { mock, client } = await setup();
    // the 2nd mutation request is THROTTLED once; the client waits and retries it
    mock.throttleMutationCall(2);
    const result = await runBulkMutation(client, METAFIELDS_SET, [1, 2, 3, 4].map((n) => row(n)));
    expect(result).toEqual({ ok: 4, failed: [] });
    expect(mock.throttledCount).toBe(1);
    expect([...mock.appliedMetafields.values()]).toEqual([1, 1, 1, 1]);
  });

  it("skips rows already in the ledger on a re-run and reports userErrors as failed", async () => {
    const { mock, client } = await setup();
    const ledger = new Set<string>();
    const first = await runBulkMutation(client, METAFIELDS_SET, [row(1), row(2, "")], { ledger });
    expect(first.ok).toBe(1);
    expect(first.failed).toHaveLength(1);
    const second = await runBulkMutation(client, METAFIELDS_SET, [row(1)], { ledger });
    expect(second.ok).toBe(1);
    expect(mock.appliedMetafields.get("gid://shopify/Product/1/app/tier")).toBe(1);
  });
});
