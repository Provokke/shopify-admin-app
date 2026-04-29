import type { Session } from "./session-store.js";

export interface GraphqlClient {
  query<T>(q: string, vars?: object): Promise<T>;
  /** Fetches a bulk result file (JSONL). Doesn't send the access token to the file host. */
  download(url: string): Promise<string>;
}

export interface GraphqlClientOptions {
  fetch?: typeof fetch;
  /** Defaults to https://<shop>. */
  baseUrl?: string;
  apiVersion?: string;
  /** How many throttle retries before giving up. */
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class GraphqlError extends Error {}
export class ThrottledError extends Error {}

interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}
interface CostExtension {
  requestedQueryCost?: number;
  throttleStatus?: ThrottleStatus;
}
interface GraphqlBody {
  data?: unknown;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
  extensions?: { cost?: CostExtension };
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Admin GraphQL client that tracks the cost bucket and waits when it's too low.
 * Retries THROTTLED and 429 responses (safe, Shopify rejects those before running anything).
 * One request at a time per client, so share one per shop and don't fan out.
 */
export function createGraphqlClient(session: Session, opts: GraphqlClientOptions = {}): GraphqlClient {
  const f = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const maxRetries = opts.maxRetries ?? 6;
  const base = opts.baseUrl ?? `https://${session.shop}`;
  const url = `${base}/admin/api/${opts.apiVersion ?? "2025-01"}/graphql.json`;
  let bucket: ThrottleStatus | undefined;
  let lastCost = 0;

  const absorb = (cost: CostExtension | undefined) => {
    if (!cost) return;
    if (cost.throttleStatus) bucket = cost.throttleStatus;
    if (cost.requestedQueryCost !== undefined) lastCost = cost.requestedQueryCost;
  };

  const waitFor = (requested: number, b: ThrottleStatus | undefined) =>
    b && b.restoreRate > 0 ? Math.max(0, Math.ceil(((requested - b.currentlyAvailable) / b.restoreRate) * 1000)) : 0;

  return {
    async query<T>(q: string, vars?: object): Promise<T> {
      for (let attempt = 0; ; attempt++) {
        const pre = waitFor(lastCost, bucket);
        if (pre > 0) {
          await sleep(pre);
          if (bucket) bucket = { ...bucket, currentlyAvailable: Math.min(bucket.maximumAvailable, bucket.currentlyAvailable + (pre / 1000) * bucket.restoreRate) };
        }

        const res = await f(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-shopify-access-token": session.accessToken },
          body: JSON.stringify({ query: q, variables: vars ?? {} }),
        });

        if (res.status === 429) {
          if (attempt >= maxRetries) throw new ThrottledError("Shopify throttled the request (HTTP 429) and retries are exhausted");
          const retryAfter = Number(res.headers.get("retry-after"));
          await sleep((Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 1) * 1000);
          continue;
        }
        if (!res.ok) throw new GraphqlError(`Shopify HTTP ${res.status}`);

        const body = (await res.json()) as GraphqlBody;
        absorb(body.extensions?.cost);

        if (body.errors?.length) {
          if (body.errors.some((e) => e.extensions?.code === "THROTTLED")) {
            if (attempt >= maxRetries) throw new ThrottledError("Shopify THROTTLED and retries are exhausted");
            const cost = body.extensions?.cost;
            const need = waitFor(cost?.requestedQueryCost ?? lastCost, cost?.throttleStatus);
            await sleep(need > 0 ? need : 1000 * (attempt + 1));
            // we waited, so update the bucket to match
            if (bucket && cost?.requestedQueryCost !== undefined) bucket = { ...bucket, currentlyAvailable: cost.requestedQueryCost };
            continue;
          }
          throw new GraphqlError(body.errors.map((e) => e.message).join("; "));
        }
        return body.data as T;
      }
    },

    async download(fileUrl: string): Promise<string> {
      const res = await f(fileUrl);
      if (!res.ok) throw new GraphqlError(`bulk result download failed: HTTP ${res.status}`);
      return res.text();
    },
  };
}
