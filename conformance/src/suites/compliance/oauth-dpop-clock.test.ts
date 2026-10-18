import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { authenticateOwner } from "../../client/owner-session.js";
import { TEST_OWNER } from "../../utils/target.js";
import { DpopClient } from "../../client/dpop.js";
import { bootFreshServer, type FreshServer } from "../../utils/fresh-server.js";

let server: FreshServer | undefined;
afterEach(async () => {
  await server?.stop();
});

it("exchanges and uses DPoP tokens on the stated clock across clock advances", async () => {
  server = await bootFreshServer("dpop-clock", {
    MARFA_TEST_CLOCK_OFFSET_MS: "86400000",
  });
  const client = new DpopClient({
    serverClockOffsetMs: () => server!.clockOffsetMs,
  });
  await server.advanceClock(86_400_000);
  const base = server.apiUrl;
  const { cookie } = await authenticateOwner(
    base,
    server.ownerCookie,
    TEST_OWNER,
    () => Date.now() + server!.clockOffsetMs,
  );
  const callback = "https://client.example.test/callback";
  const registered = await fetch(`${base}/auth/oauth2/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "DPoP clock fixture",
      application_type: "web",
      redirect_uris: [callback],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      scope: "openid core.note:read",
      dpop_bound_access_tokens: true,
    }),
  });
  expect(registered.status).toBe(201);
  const { client_id: clientId } = (await registered.json()) as {
    client_id: string;
  };
  const verifier = "v".repeat(64);
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callback,
    response_type: "code",
    scope: "openid core.note:read",
    state: "dpop-clock",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  const authorized = await fetch(`${base}/auth/oauth2/authorize?${query}`, {
    headers: { cookie },
    redirect: "manual",
  });
  expect(authorized.status, await authorized.clone().text()).toBe(200);
  const { url: location } = (await authorized.json()) as { url: string };
  const consent = await fetch(`${base}/auth/authorize/decision`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, origin: base },
    body: new URLSearchParams([
      ["accept", "true"],
      ["oauth_query", location.slice(location.indexOf("?") + 1)],
      ["scopes", "openid"],
      ["scopes", "core.note:read"],
    ]),
  });
  expect(consent.status, await consent.clone().text()).toBe(302);
  const code = new URL(consent.headers.get("location")!, base).searchParams.get(
    "code",
  )!;
  expect(
    code,
    consent.headers.get("location") ?? "missing redirect",
  ).toBeTruthy();
  const tokenUrl = `${base}/auth/oauth2/token`;
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { DPoP: client.proof("POST", tokenUrl), origin: base },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: callback,
    }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const tokens = (await response.json()) as {
    access_token: string;
    token_type: string;
  };
  expect(tokens.token_type.toLowerCase()).toBe("dpop");
  const userinfo = `${base}/auth/oauth2/userinfo`;
  const read = (proof: string) =>
    fetch(userinfo, {
      headers: { authorization: `DPoP ${tokens.access_token}`, DPoP: proof },
    });
  const oldProof = client.proof("GET", userinfo, tokens.access_token);
  const current = await read(
    client.proof("GET", userinfo, tokens.access_token),
  );
  expect(current.status, await current.clone().text()).toBe(200);
  await server.advanceClock(600_000);
  const stale = await read(oldProof);
  expect(stale.status).toBe(401);
  expect(await stale.text()).toContain(
    "DPoP proof iat is outside the accepted window",
  );
  const moved = await read(client.proof("GET", userinfo, tokens.access_token));
  expect(moved.status, await moved.clone().text()).toBe(200);
});
