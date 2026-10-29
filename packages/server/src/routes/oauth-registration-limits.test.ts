import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MAX_REGISTERED_REDIRECT_URIS,
  REGISTRATION_BODY_CAP,
} from "../middleware/body-cap.js";
import {
  createTestContext,
  type TestContext,
  cleanupTestContext,
} from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await cleanupTestContext(ctx);
});

function registration(redirects: number, padding = 0): string {
  return JSON.stringify({
    client_name: "Limits",
    redirect_uris: Array.from(
      { length: redirects },
      (_, i) => `https://limits.example/callback/${String(i)}`,
    ),
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    software_version: "x".repeat(padding),
  });
}

function register(body: string): Promise<Response> {
  return Promise.resolve(
    ctx.app.request("/auth/oauth2/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
  );
}

describe("the bounds on one registration", () => {
  it("takes a body at the cap and refuses one byte over it before the library reads it", async () => {
    const base = Buffer.byteLength(registration(1));
    const atCap = registration(1, REGISTRATION_BODY_CAP - base);
    expect(Buffer.byteLength(atCap)).toBe(REGISTRATION_BODY_CAP);
    expect((await register(atCap)).status).toBe(201);
    const over = registration(1, REGISTRATION_BODY_CAP - base + 1);
    const refused = await register(over);
    expect(refused.status).toBe(413);
    expect(refused.headers.get("x-error-code")).toBe("request_too_large");
  });

  it("takes the most redirect URIs a registration may name and refuses one more", async () => {
    expect(
      (await register(registration(MAX_REGISTERED_REDIRECT_URIS))).status,
    ).toBe(201);
    const refused = await register(
      registration(MAX_REGISTERED_REDIRECT_URIS + 1),
    );
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe(
      "invalid_redirect_uri",
    );
  });
});
