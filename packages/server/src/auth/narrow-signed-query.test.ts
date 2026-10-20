import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { makeSignature } from "better-auth/crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalizeOAuthQueryParams,
  narrowSignedQuery,
} from "./narrow-signed-query.js";

const SECRET = "a-signing-secret-for-this-test-only";

async function signed(scope: string): Promise<string> {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: "client_1",
    redirect_uri: "http://localhost:0/callback",
    scope,
    state: "s",
    exp: "4102444800",
    ba_iat: "1700000000000",
  });
  params.set(
    "sig",
    await makeSignature(
      canonicalizeOAuthQueryParams(params).toString(),
      SECRET,
    ),
  );
  return params.toString();
}

async function verifies(query: string): Promise<boolean> {
  const params = new URLSearchParams(query);
  const sig = params.get("sig");
  params.delete("sig");
  return (
    sig ===
    (await makeSignature(
      canonicalizeOAuthQueryParams(params).toString(),
      SECRET,
    ))
  );
}

describe("narrowSignedQuery", () => {
  it("names the narrower scopes under a signature the provider accepts, and changes nothing else", async () => {
    const query = await signed("openid *:read keys.mint");
    const narrowed = await narrowSignedQuery(
      query,
      ["openid", "core.note:read", "core.task:read"],
      ["core.note", "core.task"],
      SECRET,
    );
    expect(narrowed).not.toBeNull();
    const after = new URLSearchParams(narrowed ?? "");
    expect(after.get("scope")).toBe("openid core.note:read core.task:read");
    expect(await verifies(narrowed ?? "")).toBe(true);
    // The witness that the signature is not just copied: the old one fails.
    const forged = new URLSearchParams(narrowed ?? "");
    forged.set("sig", new URLSearchParams(query).get("sig") ?? "");
    expect(await verifies(forged.toString())).toBe(false);
    for (const key of ["client_id", "redirect_uri", "state", "exp", "ba_iat"])
      expect(after.get(key), key).toBe(new URLSearchParams(query).get(key));
  });

  it("hands the query back unchanged when every scope was already named", async () => {
    const query = await signed("openid core.note:read");
    expect(await narrowSignedQuery(query, ["core.note:read"], [], SECRET)).toBe(
      query,
    );
  });

  it("refuses a scope no all-data scope in the request covers", async () => {
    const query = await signed("openid *:read");
    for (const scope of [
      "core.note:write",
      "keys.mint",
      "core.*:read",
      "system.connection:read",
    ])
      expect(
        await narrowSignedQuery(query, [scope], ["core.note"], SECRET),
        scope,
      ).toBeNull();
    // The witness: a read of an offered type is accepted from the same request.
    expect(
      await narrowSignedQuery(query, ["core.note:read"], ["core.note"], SECRET),
    ).not.toBeNull();
  });

  it("refuses a type the page did not offer", async () => {
    const query = await signed("*:read");
    expect(
      await narrowSignedQuery(query, ["core.task:read"], ["core.note"], SECRET),
    ).toBeNull();
  });

  it("refuses a query with more or fewer than one signature", async () => {
    const query = await signed("*:read");
    expect(
      await narrowSignedQuery(
        `${query}&sig=x`,
        ["core.note:read"],
        ["core.note"],
        SECRET,
      ),
    ).toBeNull();
    expect(
      await narrowSignedQuery(
        query.replace(/&?sig=[^&]*/, ""),
        ["core.note:read"],
        ["core.note"],
        SECRET,
      ),
    ).toBeNull();
  });

  it("signs a query the provider's own verifier accepts, and one it rejects once altered", async () => {
    const query = await signed("openid *:read");
    // The oracle first: the provider accepts the query it would have signed.
    expect(await verifyOAuthQueryParams(query, SECRET)).toBe(true);
    const narrowed = await narrowSignedQuery(
      query,
      ["openid", "core.note:read"],
      ["core.note"],
      SECRET,
    );
    expect(await verifyOAuthQueryParams(narrowed ?? "", SECRET)).toBe(true);
    // The witness: the verifier is not accepting everything.
    const altered = new URLSearchParams(narrowed ?? "");
    altered.set("scope", "openid core.note:write");
    expect(await verifyOAuthQueryParams(altered.toString(), SECRET)).toBe(
      false,
    );
    expect(await verifyOAuthQueryParams(narrowed ?? "", `${SECRET}x`)).toBe(
      false,
    );
  });
});
