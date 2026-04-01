import { createHash } from "node:crypto";
import type { GraphqlClient } from "./graphql-client.js";

export const METAFIELDS_SET = `mutation SetMetafield($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { id }
    userErrors { field message }
  }
}`;

interface BulkOperation {
  id: string;
  status: string;
  errorCode?: string | null;
  url?: string | null;
}
interface UserError {
  field?: string[] | null;
  message: string;
}

export interface BulkQueryOptions {
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  maxPolls?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Starts a bulk query, polls until done, and yields the JSONL rows. Child rows carry `__parentId`. */
export async function runBulkQuery(client: GraphqlClient, query: string, opts: BulkQueryOptions = {}): Promise<AsyncIterable<object>> {
  const sleep = opts.sleep ?? defaultSleep;
  const started = await client.query<{ bulkOperationRunQuery: { bulkOperation: BulkOperation | null; userErrors: UserError[] } }>(
    `mutation Start($q: String!) {
      bulkOperationRunQuery(query: $q) { bulkOperation { id status } userErrors { field message } }
    }`,
    { q: query },
  );
  const { bulkOperation, userErrors } = started.bulkOperationRunQuery;
  if (userErrors.length || !bulkOperation) throw new Error(`bulk query not started: ${userErrors.map((e) => e.message).join("; ")}`);

  const maxPolls = opts.maxPolls ?? 120;
  for (let i = 0; i < maxPolls; i++) {
    const { currentBulkOperation: op } = await client.query<{ currentBulkOperation: BulkOperation | null }>(
      `query Poll { currentBulkOperation(type: QUERY) { id status errorCode url } }`,
    );
    if (op && op.id === bulkOperation.id) {
      if (op.status === "COMPLETED") return rowsFrom(client, op.url ?? null);
      if (op.status === "FAILED" || op.status === "CANCELED" || op.status === "EXPIRED") {
        throw new Error(`bulk query ${op.status}${op.errorCode ? ` (${op.errorCode})` : ""}`);
      }
    }
    await sleep(opts.pollIntervalMs ?? 1000);
  }
  throw new Error("bulk query did not finish within the polling budget");
}

async function* rowsFrom(client: GraphqlClient, url: string | null): AsyncGenerator<object> {
  if (!url) return; // no results means Shopify gives a null url
  const text = await client.download(url);
  for (const line of text.split("\n")) {
    if (line.trim()) yield JSON.parse(line) as object;
  }
}

export interface BulkMutationOptions {
  /** Keys of rows already applied. Reuse the same Set on a re-run to skip them. Fresh Set by default. */
  ledger?: Set<string>;
}

export function rowKey(mutation: string, row: object): string {
  return createHash("sha256").update(mutation).update("\0").update(JSON.stringify(row)).digest("hex");
}

/**
 * Applies `mutation` once per row. A row only goes in the ledger once Shopify confirms it.
 * Failed rows come back in `failed`, so a re-run with the same ledger retries just those.
 */
export async function runBulkMutation(
  client: GraphqlClient,
  mutation: string,
  rows: object[],
  opts: BulkMutationOptions = {},
): Promise<{ ok: number; failed: object[] }> {
  const ledger = opts.ledger ?? new Set<string>();
  let ok = 0;
  const failed: object[] = [];
  for (const row of rows) {
    const key = rowKey(mutation, row);
    if (ledger.has(key)) {
      ok++;
      continue;
    }
    try {
      const data = await client.query<Record<string, { userErrors?: UserError[] }>>(mutation, { metafields: [row] });
      const errors = Object.values(data)[0]?.userErrors ?? [];
      if (errors.length) {
        failed.push({ row, errors });
        continue;
      }
      ledger.add(key);
      ok++;
    } catch (e) {
      failed.push({ row, errors: [{ message: e instanceof Error ? e.message : String(e) }] });
    }
  }
  return { ok, failed };
}
