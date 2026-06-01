import { createHmac } from "node:crypto";

export const SECRET = "test-secret";

export function oauthQuery(params: Record<string, string>, secret = SECRET): Record<string, string> {
  const message = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return { ...params, hmac: createHmac("sha256", secret).update(message).digest("hex") };
}

export function signBody(body: Buffer | string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body).digest("base64");
}

export function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}
