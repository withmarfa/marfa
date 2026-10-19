/**
 * A permission is granted by being turned on, on every surface that offers
 * one.
 *
 * Two screens held opposite opinions once, and which one a person met decided
 * what they handed over. Both now read `requiresExplicitConsent`, so the rule
 * has one home. These cases are the two screens asked the same question.
 */
import { describe, it, expect } from "vitest";
import type { ParsedScope, PermissionBundle } from "@withmarfa/shared";
import { parseScope } from "@withmarfa/shared";
import {
  renderConsentScreen,
  renderDeviceConsentScreen,
} from "./test-render.js";
import { DEFAULT_PERMISSION_BUNDLES } from "../config.js";
import { defaultSubmission, readControls } from "../test-html.js";

function parsed(literal: string): ParsedScope {
  const p = parseScope(literal);
  if (!p) throw new Error(`unparseable literal in fixture: ${literal}`);
  return p;
}

const switchFor = (html: string, literal: string) =>
  readControls(html).find((c) => c.role === "switch" && c.value === literal);

const CONSENT_PARAMS = {
  clientName: "Test CLI",
  clientId: "client-abc",
  oauthQuery:
    "response_type=code&client_id=client-abc&redirect_uri=http%3A%2F%2Flocalhost%2Fcallback&scope=core.note%3Aread&state=abc&code_challenge=def&code_challenge_method=S256&exp=1778957000&sig=somesignaturehash",
  descriptions: {},
};

describe("the authorize screen never turns a permission on for the person", () => {
  it("starts an unclaimed permission off", () => {
    const html = renderConsentScreen({
      ...CONSENT_PARAMS,
      scopes: [parsed("core.note:read"), parsed("keys.mint")],
      bundles: DEFAULT_PERMISSION_BUNDLES,
    });
    expect(switchFor(html, "keys.mint")?.checked).toBe(false);
    // The ordinary literal beside it still starts on, so the case is not
    // passing because nothing is on at all.
    expect(defaultSubmission(html, "scopes")).toEqual(["core.note:read"]);
  });

  it("starts it off even when a default-on bundle claims it", () => {
    // `default_on` is a bundle's opinion about its own contents;
    // `requiresExplicitConsent` is the platform's about the scope, and the
    // platform's outranks it.
    const claiming: PermissionBundle = {
      id: "operator-custom",
      label: "Operator custom",
      description: "Configured, not shipped.",
      scopes: ["core.note:read", "keys.mint"],
      default_on: true,
    };
    const html = renderConsentScreen({
      ...CONSENT_PARAMS,
      scopes: [parsed("core.note:read"), parsed("keys.mint")],
      bundles: [claiming],
    });
    expect(switchFor(html, "keys.mint")?.checked).toBe(false);
    expect(defaultSubmission(html, "scopes")).toEqual(["core.note:read"]);
  });

  it("keeps a permission the person already granted granted", () => {
    // A default that decides what to offer must never decide what to keep:
    // an untouched Approve would otherwise drop a permission the app holds.
    const html = renderConsentScreen({
      ...CONSENT_PARAMS,
      scopes: [parsed("keys.mint"), parsed("core.note:read")],
      bundles: DEFAULT_PERMISSION_BUNDLES,
      priorScopes: ["keys.mint"],
    });
    expect(switchFor(html, "keys.mint")).toBeUndefined();
    // Not posted: the server adds what the app still holds when it approves.
    expect(defaultSubmission(html, "scopes")).toEqual(["core.note:read"]);
  });
});

describe("the device approval screen offers a permission the same way", () => {
  const DEVICE_PARAMS = {
    clientName: "Marfa CLI",
    userCode: "ABCDEFGH",
    descriptions: {},
  };

  it("offers a switch for it, and leaves it off while everything else starts on", () => {
    const html = renderDeviceConsentScreen({
      ...DEVICE_PARAMS,
      scopes: [parsed("core.note:read"), parsed("keys.mint")],
      bundles: DEFAULT_PERMISSION_BUNDLES,
    });
    expect(switchFor(html, "keys.mint")?.checked).toBe(false);
    expect(defaultSubmission(html, "scopes")).toEqual(["core.note:read"]);
  });

  it("carries the hidden mechanisms without a control", () => {
    // `openid` and `offline_access` are how a client gets an identity and a
    // refresh token, and a person cannot decline a control they cannot see.
    // Dropping them here would hand the CLI a session it cannot renew.
    const html = renderDeviceConsentScreen({
      ...DEVICE_PARAMS,
      scopes: [
        parsed("openid"),
        parsed("offline_access"),
        parsed("core.note:read"),
      ],
      bundles: DEFAULT_PERMISSION_BUNDLES,
    });
    const hidden = readControls(html).filter(
      (c) => c.name === "scopes" && c.type === "hidden",
    );
    expect(hidden.map((c) => c.value)).toEqual(["openid", "offline_access"]);
    expect(
      readControls(html).some(
        (c) => c.role === "switch" && c.value === "openid",
      ),
    ).toBe(false);
  });
});
