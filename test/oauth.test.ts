import { describe, expect, it } from "vitest";
import { isValidShop, verifyOAuthHmac } from "../src/oauth.js";
import { SECRET, oauthQuery } from "./helpers.js";

const base = { shop: "demo-shop.myshopify.com", code: "abc", state: "s1", timestamp: "1700000000" };

describe("oauth", () => {
  it("accepts a correctly signed callback", () => {
    expect(verifyOAuthHmac(oauthQuery(base), SECRET)).toBe(true);
  });

  it("rejects tampered oauth hmac", () => {
    const q = oauthQuery(base);
    expect(verifyOAuthHmac({ ...q, shop: "evil.myshopify.com" }, SECRET)).toBe(false);
    expect(verifyOAuthHmac({ ...q, hmac: "00" }, SECRET)).toBe(false);
    expect(verifyOAuthHmac(base, SECRET)).toBe(false);
    expect(verifyOAuthHmac(oauthQuery(base, "other"), SECRET)).toBe(false);
  });

  it("validates shop domains", () => {
    expect(isValidShop("demo-shop.myshopify.com")).toBe(true);
    expect(isValidShop("evil.com/x.myshopify.com")).toBe(false);
    expect(isValidShop("demo-shop.myshopify.com.evil.com")).toBe(false);
  });
});
