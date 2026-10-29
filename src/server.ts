import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  buildInstallUrl,
  createState,
  exchangeCodeForSession,
  isValidShop,
  verifyOAuthHmac,
  type OAuthConfig,
} from "./oauth.js";
import type { SessionStore } from "./session-store.js";
import { createWebhookHandler, type WebhookHandler } from "./webhooks.js";

export interface AppServerOptions {
  config: OAuthConfig;
  sessions: SessionStore;
  /** Defaults to createWebhookHandler({ sessions }). */
  webhookHandler?: WebhookHandler;
  fetch?: typeof fetch;
  port?: number;
}

export interface AppServer {
  url: string;
  server: Server;
  close(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const header = (req: IncomingMessage, name: string): string => {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v) ?? "";
};

export async function createAppServer(opts: AppServerOptions): Promise<AppServer> {
  const { config, sessions } = opts;
  const handleWebhook = opts.webhookHandler ?? createWebhookHandler({ sessions });
  const pendingStates = new Set<string>(); // production: per-session cookie or shared store

  let baseUrl = "";
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, "ok");

      if (req.method === "GET" && url.pathname === "/auth") {
        const shop = url.searchParams.get("shop") ?? "";
        if (!isValidShop(shop)) return send(res, 400, "invalid shop");
        const state = createState();
        pendingStates.add(state);
        return send(res, 302, "", { location: buildInstallUrl(config, shop, `${baseUrl}/auth/callback`, state) });
      }

      if (req.method === "GET" && url.pathname === "/auth/callback") {
        const query = Object.fromEntries(url.searchParams.entries());
        const { shop = "", code = "", state = "" } = query;
        if (!isValidShop(shop) || !code) return send(res, 400, "invalid callback");
        if (!verifyOAuthHmac(query, config.apiSecret)) return send(res, 400, "bad hmac");
        if (!pendingStates.delete(state)) return send(res, 400, "unknown state");
        const session = await exchangeCodeForSession(config, shop, code, opts.fetch ? { fetch: opts.fetch } : {});
        await sessions.save(session); // reinstall simply overwrites
        return send(res, 200, `installed ${shop}`);
      }

      if (req.method === "POST" && url.pathname === "/webhooks") {
        const raw = await readBody(req); // raw bytes: HMAC is over the exact body
        const result = await handleWebhook(
          header(req, "x-shopify-topic"),
          raw,
          header(req, "x-shopify-hmac-sha256"),
          config.apiSecret,
          header(req, "x-shopify-webhook-id"),
          header(req, "x-shopify-triggered-at") || undefined,
        );
        return send(res, result === "rejected" ? 401 : 200, result);
      }

      send(res, 404, "not found");
    } catch (e) {
      send(res, 500, e instanceof Error ? e.message : "error"); // 5xx makes Shopify retry the webhook
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: baseUrl,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
