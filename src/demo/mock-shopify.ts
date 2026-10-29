import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockShopifyOptions {
  shop?: string;
  apiKey?: string;
  apiSecret?: string;
  productCount?: number;
  /** Leaky bucket: capacity and refill per second. */
  bucketMax?: number;
  restoreRate?: number;
}

export interface MockShopify {
  url: string;
  shop: string;
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  /** "ownerId/namespace/key" -> number of times the mutation was actually applied */
  appliedMetafields: Map<string, number>;
  throttledCount: number;
  /** Make the nth metafieldsSet request (1-based) return THROTTLED once, without applying it. */
  throttleMutationCall(n: number): void;
  close(): Promise<void>;
}

const QUERY_COST = 50;
const MUTATION_COST = 10;

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** A tiny stand-in for Shopify: OAuth, Admin GraphQL with a cost bucket, bulk operations, metafieldsSet. */
export async function createMockShopify(opts: MockShopifyOptions = {}): Promise<MockShopify> {
  const shop = opts.shop ?? "demo-shop.myshopify.com";
  const apiKey = opts.apiKey ?? "mock-api-key";
  const apiSecret = opts.apiSecret ?? "mock-api-secret";
  const accessToken = "shpat_mock_token";
  const max = opts.bucketMax ?? 1000;
  const restore = opts.restoreRate ?? 1000; // fast refill so the demo does not sit around

  let available = max;
  let last = Date.now();
  const refill = () => {
    const now = Date.now();
    available = Math.min(max, available + ((now - last) / 1000) * restore);
    last = now;
  };

  const productCount = opts.productCount ?? 5;
  const throttleCalls = new Set<number>();
  let mutationCalls = 0;
  let bulkPolls = 0;
  let bulkId = "";
  const codes = new Set<string>();

  const mock = {
    shop,
    apiKey,
    apiSecret,
    accessToken,
    appliedMetafields: new Map<string, number>(),
    throttledCount: 0,
    throttleMutationCall: (n: number) => void throttleCalls.add(n),
  } as MockShopify;

  const costExt = (requested: number, actual: number | null) => ({
    cost: { requestedQueryCost: requested, actualQueryCost: actual, throttleStatus: { maximumAvailable: max, currentlyAvailable: Math.floor(available), restoreRate: restore } },
  });

  const jsonl = () => {
    const lines: string[] = [];
    for (let i = 1; i <= productCount; i++) {
      lines.push(JSON.stringify({ id: `gid://shopify/Product/${i}`, title: `Product ${i}` }));
      lines.push(JSON.stringify({ id: `gid://shopify/ProductVariant/${i}01`, sku: `SKU-${i}`, __parentId: `gid://shopify/Product/${i}` }));
    }
    return lines.join("\n") + "\n";
  };

  const handleGraphql = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.headers["x-shopify-access-token"] !== accessToken) return json(res, 401, { errors: "[API] Invalid API key or access token" });
    const body = await readJson(req);
    const q = String(body.query ?? "");
    const vars = (body.variables ?? {}) as Record<string, unknown>;
    const isMutation = q.includes("metafieldsSet");
    const requested = isMutation ? MUTATION_COST : QUERY_COST;

    refill();
    const forced = isMutation && throttleCalls.has(mutationCalls + 1);
    if (isMutation) mutationCalls++;
    if (forced || available < requested) {
      const real = available;
      if (forced) {
        throttleCalls.delete(mutationCalls);
        available = requested / 2; // report a low bucket so the client's wait is visible
      }
      const ext = costExt(requested, null);
      available = real; // nothing was consumed
      mock.throttledCount++;
      return json(res, 200, { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }], extensions: ext });
    }
    available -= requested;

    if (q.includes("bulkOperationRunQuery")) {
      bulkId = `gid://shopify/BulkOperation/${Date.now()}`;
      bulkPolls = 0;
      return json(res, 200, { data: { bulkOperationRunQuery: { bulkOperation: { id: bulkId, status: "CREATED" }, userErrors: [] } }, extensions: costExt(requested, requested) });
    }
    if (q.includes("currentBulkOperation")) {
      const done = ++bulkPolls >= 2; // first poll says RUNNING
      const op = { id: bulkId, status: done ? "COMPLETED" : "RUNNING", errorCode: null, url: done ? `${mock.url}/bulk/result.jsonl` : null };
      return json(res, 200, { data: { currentBulkOperation: op }, extensions: costExt(requested, requested) });
    }
    if (isMutation) {
      const input = ((vars.metafields as Array<Record<string, string>> | undefined) ?? [])[0];
      if (!input || !input.value) {
        return json(res, 200, { data: { metafieldsSet: { metafields: [], userErrors: [{ field: ["metafields", "0", "value"], message: "Value can't be blank" }] } }, extensions: costExt(requested, requested) });
      }
      const key = `${input.ownerId}/${input.namespace}/${input.key}`;
      mock.appliedMetafields.set(key, (mock.appliedMetafields.get(key) ?? 0) + 1);
      return json(res, 200, { data: { metafieldsSet: { metafields: [{ id: key }], userErrors: [] } }, extensions: costExt(requested, requested) });
    }
    if (q.includes("shop")) return json(res, 200, { data: { shop: { name: "Demo Shop" } }, extensions: costExt(requested, requested) });
    return json(res, 200, { errors: [{ message: "mock does not implement this query" }] });
  };

  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/admin/oauth/authorize") {
        if (url.searchParams.get("client_id") !== apiKey) return json(res, 400, { error: "bad client_id" });
        const code = `code-${codes.size + 1}`;
        codes.add(code);
        const params: Record<string, string> = { code, shop, state: url.searchParams.get("state") ?? "", timestamp: String(Math.floor(Date.now() / 1000)) };
        const message = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
        const hmac = createHmac("sha256", apiSecret).update(message).digest("hex");
        const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
        for (const [k, v] of Object.entries({ ...params, hmac })) redirect.searchParams.set(k, v);
        res.writeHead(302, { location: redirect.toString() });
        return void res.end();
      }
      if (req.method === "POST" && url.pathname === "/admin/oauth/access_token") {
        const b = await readJson(req);
        if (b.client_id !== apiKey || b.client_secret !== apiSecret || !codes.delete(String(b.code))) return json(res, 400, { error: "invalid_request" });
        return json(res, 200, { access_token: accessToken, scope: "read_products,write_products" });
      }
      if (req.method === "POST" && /^\/admin\/api\/[^/]+\/graphql\.json$/.test(url.pathname)) return await handleGraphql(req, res);
      if (req.method === "GET" && url.pathname === "/bulk/result.jsonl") {
        res.writeHead(200, { "content-type": "application/jsonl" });
        return void res.end(jsonl());
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : "error" });
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  mock.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  mock.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return mock;
}
