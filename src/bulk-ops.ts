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

/**
 * Starts a bulk query, polls until it completes, and yields the JSONL result rows.
 * Child rows carry `__parentId`, as in Shopify's real output.
 */
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
  if (!url) return; // zero results: Shopify returns a null url
  const text = await client.download(url);
  for (const line of text.split("\n")) {
    if (line.trim()) yield JSON.parse(line) as object;
  }
}

export interface BulkMutationOptions {
  /**
   * Keys of rows already applied. Pass the same Set when re-running after a crash or a partial
   * failure and those rows are skipped, never re-sent. Defaults to a fresh Set per call.
   */
  ledger?: Set<string>;
}

export function rowKey(mutation: string, row: object): string {
  return createHash("sha256").update(mutation).update("\0").update(JSON.stringify(row)).digest("hex");
}

/**
 * Applies `mutation` once per row (variables: { metafields: [row] }).
 *
 * Idempotency: a row is recorded in the ledger only after Shopify confirms it (no userErrors).
 * Throttling is absorbed inside the client (a THROTTLED request was not executed, so its retry is
 * the first and only application). A row that fails stays out of the ledger and is returned in
 * `failed`, so a re-run with the same ledger retries only those.
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
