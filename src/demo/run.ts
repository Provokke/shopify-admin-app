import { createHmac } from "node:crypto";
import { METAFIELDS_SET, runBulkMutation, runBulkQuery } from "../bulk-ops.js";
import { createGraphqlClient } from "../graphql-client.js";
import { createAppServer } from "../server.js";
import { MemorySessionStore } from "../session-store.js";
import { createMockShopify } from "./mock-shopify.js";

const step = (n: number, title: string) => console.log(`\n[${n}] ${title}`);

async function main(): Promise<void> {
  const mock = await createMockShopify({ productCount: 5 });
  const sessions = new MemorySessionStore();
  const app = await createAppServer({
    config: { apiKey: mock.apiKey, apiSecret: mock.apiSecret, scopes: "read_products,write_products", shopBaseUrl: () => mock.url },
    sessions,
  });
  console.log(`mock Shopify on ${mock.url}, app on ${app.url} (all local, no accounts)`);

  try {
    step(1, "install: merchant opens /auth, is sent through OAuth, callback is HMAC-verified");
    const installed = await fetch(`${app.url}/auth?shop=${mock.shop}`);
    console.log(`  app answered ${installed.status}: ${await installed.text()}`);
    const session = await sessions.get(mock.shop);
    if (!session) throw new Error("no session saved");
    console.log(`  session stored for ${session.shop} (scope ${session.scope})`);

    const client = createGraphqlClient(session, {
      baseUrl: mock.url,
      sleep: async (ms) => {
        console.log(`  ... client waiting ${ms} ms for the cost bucket to refill`);
        await new Promise((r) => setTimeout(r, ms));
      },
    });

    step(2, "bulk export: products + variants via bulkOperationRunQuery -> JSONL");
    const exported: Array<Record<string, unknown>> = [];
    for await (const row of await runBulkQuery(client, "{ products { edges { node { id title variants { edges { node { id sku } } } } } } }", { pollIntervalMs: 20 })) {
      exported.push(row as Record<string, unknown>);
    }
    const products = exported.filter((r) => !("__parentId" in r));
    console.log(`  ${exported.length} JSONL rows, ${products.length} products (child rows carry __parentId)`);

    step(3, "bulk import: metafield per product; the 3rd request is THROTTLED mid-run");
    mock.throttleMutationCall(3);
    const rows = products.map((p, i) => ({ ownerId: String(p.id), namespace: "app", key: "tier", type: "single_line_text_field", value: `tier-${i + 1}` }));
    const result = await runBulkMutation(client, METAFIELDS_SET, rows);
    const applied = [...mock.appliedMetafields.values()];
    console.log(`  ok=${result.ok} failed=${result.failed.length} throttled=${mock.throttledCount}`);
    console.log(`  server applied each row exactly once: ${applied.every((n) => n === 1) && applied.length === rows.length}`);

    step(4, "uninstall: signed app/uninstalled webhook, delivered twice");
    const body = Buffer.from(JSON.stringify({ myshopify_domain: mock.shop }));
    const sig = createHmac("sha256", mock.apiSecret).update(body).digest("base64");
    const deliver = () =>
      fetch(`${app.url}/webhooks`, {
        method: "POST",
        body,
        headers: { "x-shopify-topic": "app/uninstalled", "x-shopify-hmac-sha256": sig, "x-shopify-webhook-id": "wh-1" },
      });
    console.log(`  first delivery: ${await (await deliver()).text()}`);
    console.log(`  second delivery: ${await (await deliver()).text()}`);
    console.log(`  session after uninstall: ${(await sessions.get(mock.shop)) ? "STILL PRESENT" : "deleted"}`);
    console.log("\ndemo complete");
  } finally {
    await app.close();
    await mock.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
