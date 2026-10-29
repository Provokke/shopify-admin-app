# Design note

## Retrying a throttled request is safe, retrying anything else is not
Shopify's `THROTTLED` error (HTTP 200 with `errors[].extensions.code`) and HTTP 429 both mean the request was rejected before execution, so the client retries them, including mutations. Every other failure (network error after send, 5xx, userErrors) is surfaced and never retried blindly, because the mutation may have been applied.

## Cost-aware pacing
Each response carries `extensions.cost.throttleStatus` (`currentlyAvailable`, `restoreRate`). The client keeps the latest values and the last requested cost. Before each call it waits `(lastCost - available) / restoreRate` seconds if the bucket cannot cover it; on THROTTLED it waits for the same arithmetic using the numbers in the rejection. Waiting is injectable (`sleep`) so tests assert the exact wait. Limitation: one in-flight request per client.

## Idempotent bulk mutation
`runBulkMutation` keeps a ledger of `sha256(mutation + row)`. A row is added only after Shopify returns no `userErrors`. Rows that fail or throw stay out of the ledger and come back in `failed`, so re-running with the same ledger retries only those. Persist the ledger (a table or the staged JSONL line number) for crash safety; the in-memory Set only covers re-runs within one process. For true exactly-once on non-idempotent mutations, prefer Shopify mutations that take an idempotency key or are naturally idempotent (`metafieldsSet` is an upsert).

## Webhooks
Order: authenticate raw bytes -> parse -> claim delivery id -> dispatch. Forged requests never claim ids. If dispatch throws, the claim is released and the handler error becomes a 500, so Shopify's retry reprocesses. Uninstall handling compares the event's `X-Shopify-Triggered-At` to the session `installedAt`: an uninstall older than the current install is acknowledged and ignored, which covers install -> uninstall -> install arriving as install, install, uninstall. Unknown topics are acknowledged to avoid Shopify disabling the subscription.

## OAuth
`state` is a one-use random value held in a Set, which suits a single process; use a signed cookie or shared store in production. `shop` is validated against `^[a-z0-9][a-z0-9-]*\.myshopify.com$` before it is ever used to build a URL.

## Mock server
`src/demo/mock-shopify.ts` implements just enough: authorize redirect with a signed callback, token exchange, a leaky bucket (injectable low capacity, forced throttles via `throttleMutationCall`), bulk query start/poll (RUNNING then COMPLETED), a JSONL file with `__parentId` child rows, and `metafieldsSet` that counts applications per key so tests can assert exactly-once.
