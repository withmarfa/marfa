import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import * as clock from "../clock.js";
import type { AppEnv, DirectAuthority } from "../middleware/auth.js";
import { gateAttributes } from "../pages/parts/index.js";
import { renderConsentScreen } from "./consent.js";
import { renderDeviceConsentScreen } from "./device-approval.js";
import { confirmGateFor } from "./confirm-gate.js";
import { parseScope } from "@withmarfa/shared";
import { visibleText } from "../pages/reading.js";

const MINUTE = 60_000;

function owner(signedInAgo: number): DirectAuthority {
  return {
    kind: "owner",
    userId: "user",
    sessionId: "session",
    userAgent: null,
    authenticatedAt: clock.nowMs() - signedInAgo,
  };
}

async function gateFor(
  authority: DirectAuthority | undefined,
  offered: string[],
  held?: string[],
) {
  const app = new Hono<AppEnv>();
  app.use(async (c, next) => {
    c.set("authority", authority);
    c.set("cspNonce", "bm9uY2U=");
    await next();
  });
  let gate: ReturnType<typeof confirmGateFor>;
  app.get("/", (c) => {
    gate = confirmGateFor(c, "Notes App", offered, held);
    return c.text("");
  });
  const response = await app.request("/");
  return {
    gate,
    policy: response.headers.get("content-security-policy") ?? undefined,
  };
}

describe("confirmGateFor", () => {
  it("names the offered scopes that need a recent sign-in, and how long the session has left", async () => {
    const { gate } = await gateFor(owner(MINUTE), [
      "openid",
      "core.note:read",
      "core.note:write",
      "keys.manage",
    ]);
    expect(gate?.scopes).toEqual(["core.note:write", "keys.manage"]);
    expect(gate?.left).toBeGreaterThan(4 * MINUTE - 5000);
    expect(gate?.left).toBeLessThanOrEqual(4 * MINUTE);
    expect(gate?.why).toBe(
      "To let Notes App change your data or control Marfa, confirm it's you.",
    );
  });

  it("leaves out a scope the app already holds, and offers nothing for a request that only reads", async () => {
    const held = await gateFor(
      owner(MINUTE),
      ["core.note:read", "core.note:write", "keys.manage"],
      ["core.*:write"],
    );
    expect(held.gate?.scopes).toEqual(["keys.manage"]);
    const reads = await gateFor(owner(MINUTE), ["openid", "core.note:read"]);
    expect(reads.gate).toBeUndefined();
  });

  it("counts down from the session's creation, and has nothing left once it is past five minutes", async () => {
    const { gate } = await gateFor(owner(6 * MINUTE), ["core.note:write"]);
    expect(gate?.left).toBeLessThan(0);
    expect(gateAttributes(gate)["data-confirm-left"]).toBe("0");
  });

  it("offers nothing to the local command or to a request with no owner session", async () => {
    expect(
      (await gateFor({ kind: "local_process" }, ["core.note:write"])).gate,
    ).toBeUndefined();
    expect(
      (await gateFor(undefined, ["core.note:write"])).gate,
    ).toBeUndefined();
  });

  it("lets the page ask this server for the confirmation, and only when it will", async () => {
    const asks = await gateFor(owner(MINUTE), ["core.note:write"]);
    expect(asks.policy).toContain("connect-src 'self'");
    expect(asks.policy).toContain("script-src 'nonce-bm9uY2U='");
    const reads = await gateFor(owner(MINUTE), ["core.note:read"]);
    expect(reads.policy).toBeUndefined();
  });
});

describe("the approval screens' confirmation", () => {
  const scopes = ["core.note:read", "core.note:write"]
    .map(parseScope)
    .filter((s) => s !== null);
  const gate = {
    left: 4 * MINUTE,
    scopes: ["core.note:write"],
    why: "To let Notes App change your data or control Marfa, confirm it's you.",
  };

  it("puts the dialog and the gate on the consent screen only when a scope needs a recent sign-in", () => {
    const withGate = renderConsentScreen({
      nonce: "bm9uY2U=",
      clientName: "Notes App",
      scopes,
      clientId: "client",
      oauthQuery: "a=b",
      confirmGate: gate,
    });
    expect(withGate).toContain('data-confirm-left="240000"');
    expect(withGate).toContain('data-confirm-scopes="core.note:write"');
    expect(visibleText(withGate)).toContain("Confirm it's you");
    expect(withGate).toContain("data-confirm");
    const without = renderConsentScreen({
      nonce: "bm9uY2U=",
      clientName: "Notes App",
      scopes,
      clientId: "client",
      oauthQuery: "a=b",
    });
    expect(without).not.toContain("data-confirm-left");
    expect(visibleText(without)).not.toContain("Confirm it's you");
  });

  it("does the same on the device screen, and marks only Approve as the button that asks", () => {
    const html = renderDeviceConsentScreen({
      nonce: "bm9uY2U=",
      clientName: "Notes CLI",
      scopes,
      userCode: "ABCD2345",
      confirmGate: gate,
    });
    expect(html).toContain('data-confirm-scopes="core.note:write"');
    expect(visibleText(html)).toContain("Confirm it's you");
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    const asking = buttons.filter((tag) =>
      /\sdata-confirm(?=[\s=>])(?!-)/.test(tag),
    );
    expect(asking).toHaveLength(1);
    expect(asking[0]).toContain('value="approve"');
  });
});
