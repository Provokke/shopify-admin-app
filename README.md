# shopify-admin-app

A TypeScript skeleton for the parts of an embedded Shopify app that tend to get rewritten for every client: OAuth install, session storage, an Admin GraphQL client that respects the cost bucket, bulk operations with idempotent mutations, and webhook handlers (app/uninstalled plus the GDPR topics).

There are no runtime dependencies (it uses Node 20+ `fetch`, `http` and `crypto`). It runs against a bundled mock Shopify server, so you don't need an account to try it.

## What it handles

- OAuth callback: checks the `hmac` (sorted params, constant-time compare), a one-use `state`, and that the shop is a `*.myshopify.com` host.
- Throttling: reads the cost bucket from each response, waits as long as the refill needs (or `Retry-After`), then retries. A throttled request was never executed, so the retry is the only application.
- Bulk import: a per-row ledger keyed by a hash of mutation plus row. A row goes in only after Shopify confirms it, so a re-run with the same ledger skips applied rows.
- Duplicate webhooks: the webhook id is claimed before work and released if the work throws, so Shopify's retry still runs.
- Stale uninstalls: `X-Shopify-Triggered-At` is compared with the session's install time, so an old uninstall can't delete a fresh session.
- GDPR topics (`customers/data_request`, `customers/redact`, `shop/redact`) are acknowledged and passed to an `onGdpr` hook. `shop/redact` also drops the session.

## Run the demo

Needs Node 20+. No Shopify account or network.

```bash
npm install
npm run demo
```

It starts a mock Shopify and the app on localhost, then runs through an OAuth install, a bulk export of products and variants, a bulk metafield import with a THROTTLED response injected part way (each row is still applied once), and an uninstall webhook delivered twice.

```
[3] bulk import: metafield per product; the 3rd request is THROTTLED mid-run
  ... client waiting 5 ms for the cost bucket to refill
  ok=5 failed=0 throttled=1
  server applied each row exactly once: true
```

`npm run check` runs typecheck, lint and tests. `npm run build` compiles.

## Layout

- `src/oauth.ts` HMAC verification, install URL, code-for-token exchange, shop validation
- `src/session-store.ts` `SessionStore` interface and an in-memory version
- `src/graphql-client.ts` `createGraphqlClient(session, opts)`, throttle aware
- `src/bulk-ops.ts` `runBulkQuery` and `runBulkMutation`
- `src/webhooks.ts` `handleWebhook` and `createWebhookHandler`
- `src/server.ts` plain `node:http` routes: `/auth`, `/auth/callback`, `/webhooks`, `/healthz`
- `src/demo/` the mock Shopify and the demo script
- `test/` vitest suites, all offline

## Caveats

- Only tested against the bundled mock, which I wrote from Shopify's docs, so it could share a misunderstanding with the client. No real dev store was used.
- Bulk operations are simplified: import sends one `metafieldsSet` per row (no staged uploads), and exports are read whole into memory.
- The API version (`2025-01`) and cost numbers are placeholders.
- Not implemented: webhook subscription registration, App Bridge session tokens, expiring offline token refresh.
- Sessions are in memory only, with no multi-process safety for the OAuth `state` set or the webhook id claims. The client assumes one request at a time per shop.
- The CI config has not run on GitHub yet.

## Using it for real

Swap `MemorySessionStore` and `MemoryWebhookIdStore` for database-backed stores (a unique-key insert works well for `claim`), leave `shopBaseUrl` unset so it defaults to `https://<shop>`, implement `onGdpr`, and register webhook subscriptions in your app config.

## Licence

MIT, see [LICENSE](LICENSE).
