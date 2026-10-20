import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { makeSignature } from "better-auth/crypto";
import { describe, expect, it } from "vitest";
import type { MarfaAuth } from "../auth/instance.js";
import { canonicalizeOAuthQueryParams } from "../auth/narrow-signed-query.js";
import { __test_internals } from "./auth-consent.js";

/**
 * The consent route verifies the provider's signed request with a copy of the
 * provider's own check, because it must tell an expired request from a forged
 * one. This holds the copy to the original: for each query below, both say
 * the same. A provider upgrade that changes how it signs fails here.
 */
const SECRET = "agreement-secret-for-this-test-only-0123456789";
const auth = { signingSecret: SECRET } as unknown as MarfaAuth;

async function signed(
  over: Record<string, string> = {},
  sign = true,
): Promise<URLSearchParams> {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: "client_1",
    redirect_uri: "http://localhost:0/callback",
    scope: "openid *:read",
    state: "s",
    exp: String(Math.floor(Date.now() / 1000) + 600),
    ba_iat: String(Date.now()),
    ...over,
  });
  if (sign)
    params.set(
      "sig",
      await makeSignature(
        canonicalizeOAuthQueryParams(params).toString(),
        SECRET,
      ),
    );
  return params;
}

describe("the consent route's check of a signed request", () => {
  it("agrees with the provider's on what it signed and on what was altered", async () => {
    const good = await signed();
    const tampered = new URLSearchParams(good);
    tampered.set("scope", "openid *:write");
    const reordered = new URLSearchParams([...good.entries()].reverse());
    const twice = new URLSearchParams(good);
    twice.append("sig", good.get("sig") ?? "");
    const unsigned = await signed({}, false);
    const cases: [string, URLSearchParams, boolean][] = [
      ["signed", good, true],
      ["the same parameters in another order", reordered, true],
      ["a scope edited after signing", tampered, false],
      ["a signature given twice", twice, false],
      ["no signature", unsigned, false],
    ];
    for (const [name, params, accepted] of cases) {
      const ours =
        (await __test_internals.verifySignedQuery(auth, params.toString())) ===
        "valid";
      const theirs = await verifyOAuthQueryParams(params.toString(), SECRET);
      expect(theirs, `the provider on ${name}`).toBe(accepted);
      expect(ours, `the route on ${name}`).toBe(theirs);
    }
  });

  it("calls a query past its window expired where the provider only rejects it", async () => {
    const old = await signed({
      exp: String(Math.floor(Date.now() / 1000) - 60),
    });
    expect(await verifyOAuthQueryParams(old.toString(), SECRET)).toBe(false);
    expect(await __test_internals.verifySignedQuery(auth, old.toString())).toBe(
      "expired",
    );
  });
});
