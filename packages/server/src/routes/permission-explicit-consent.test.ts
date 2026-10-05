/**
 * A permission is granted by being ticked, on every surface that offers
 * one.
 *
 * **Two screens held opposite opinions and which one a person met decided
 * what they handed over.** The code-flow consent screen gives a
 * permission no bundle claims its own unticked row, on the reasoning that it
 * is authority over the instance itself and has to be handed over deliberately
 * rather than by silence. The
 * device-approval screen could not reach that reasoning: its only withholding
 * input was derived from the configured bundles, so a permission no
 * bundle names was in no withheld set, and its rows were confirmations rather
 * than toggles — one Approve granted the lot.
 *
 * Both now read `requiresExplicitConsent`, so the rule has one home. These
 * cases are the two screens asked the same question.
 */
import { describe, it, expect } from "vitest";
import type { ParsedScope, PermissionBundle } from "@withmarfa/shared";
import { parseScope } from "@withmarfa/shared";
import { renderConsentScreen } from "./test-render.js";
import { renderDeviceConsentScreen } from "./device-pages.js";
import { DEFAULT_PERMISSION_BUNDLES } from "../config.js";

function parsed(literal: string): ParsedScope {
  const p = parseScope(literal);
  if (!p) throw new Error(`unparseable literal in fixture: ${literal}`);
  return p;
}

/** The row a checkbox renders for one literal, so a case can assert on the
 *  tick rather than on the whole document. */
function rowFor(html: string, literal: string): string {
  const marker = `value="${literal}"`;
  const at = html.indexOf(marker);
  if (at === -1) return "";
  // The `checked` attribute, when present, follows the value on the same tag.
  return html.slice(at, html.indexOf(">", at) + 1);
}

const CONSENT_PARAMS = {
  clientName: "Test CLI",
  clientId: "client-abc",
  oauthQuery:
    "response_type=code&client_id=client-abc&redirect_uri=http%3A%2F%2Flocalhost%2Fcallback&scope=core.note%3Aread&state=abc&code_challenge=def&code_challenge_method=S256&exp=1778957000&sig=somesignaturehash",
  descriptions: {},
};

describe("the code-flow consent screen never pre-ticks a permission", () => {
  it("renders an unclaimed permission unticked", () => {
    const html = renderConsentScreen({
      ...CONSENT_PARAMS,
      scopes: [parsed("core.note:read"), parsed("keys.mint")],
      bundles: DEFAULT_PERMISSION_BUNDLES,
    });
    expect(rowFor(html, "keys.mint")).not.toContain("checked");
    // The ordinary literal beside it still arrives ticked, so the case is not
    // passing because nothing is ticked at all.
    expect(rowFor(html, "core.note:read")).toContain("checked");
  });

  it("renders it unticked even when a default-on bundle claims it", () => {
    // The case the bundle branch could not see. `default_on` is a bundle's
    // opinion about its own contents; `requiresExplicitConsent` is the
    // platform's about the scope, and the platform's outranks it. Without
    // this the fallback bucket never fires for a claimed literal and the
    // permission inherits the bundle's tick.
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
    expect(rowFor(html, "keys.mint")).not.toContain("checked");
    expect(rowFor(html, "core.note:read")).toContain("checked");
  });

  it("shows a permission the person already granted as granted", () => {
    // The other direction, and the one that costs an app its tokens if it is
    // wrong: a default that decides what to OFFER must never decide what to
    // KEEP. At re-consent a standing grant renders from the prior grant, so
    // an untouched Continue cannot silently drop a permission and
    // trigger the narrowing revoke.
    const html = renderConsentScreen({
      ...CONSENT_PARAMS,
      scopes: [parsed("keys.mint"), parsed("core.note:read")],
      bundles: DEFAULT_PERMISSION_BUNDLES,
      // A standing grant, so this render is the re-consent diff: the
      // permission lands in "Already allowed", which is being shown
      // rather than offered.
      priorScopes: ["keys.mint"],
    });
    expect(rowFor(html, "keys.mint")).toContain("checked");
  });
});

describe("the device-approval screen offers a permission as a toggle", () => {
  const DEVICE_PARAMS = {
    clientName: "Marfa CLI",
    userCode: "ABCD-EFGH",
    descriptions: {},
  };

  it("submits a checkbox per scope rather than confirming a list", () => {
    // The premise of the whole fix. While the rows were confirmations the
    // approve form carried only the user code and a decision, so there was
    // nothing for "leaving it alone grants nothing" to mean on this screen.
    const html = renderDeviceConsentScreen({
      ...DEVICE_PARAMS,
      scopes: [parsed("core.note:read"), parsed("keys.mint")],
      bundles: DEFAULT_PERMISSION_BUNDLES,
    });
    expect(html).toContain('name="scopes"');
    expect(html).toContain('value="core.note:read"');
    expect(html).toContain('value="keys.mint"');
  });

  it("leaves a permission unticked and everything else ticked", () => {
    const html = renderDeviceConsentScreen({
      ...DEVICE_PARAMS,
      scopes: [parsed("core.note:read"), parsed("keys.mint")],
      bundles: DEFAULT_PERMISSION_BUNDLES,
    });
    expect(rowFor(html, "keys.mint")).not.toContain("checked");
    expect(rowFor(html, "core.note:read")).toContain("checked");
  });

  it("carries the hidden mechanisms without a toggle", () => {
    // `openid` and `offline_access` are how a client gets an identity and a
    // refresh token rather than data permissions, and the code-flow screen
    // submits them as hidden checked fields for the same reason: a person
    // cannot decline a control they cannot see. Dropping them here would
    // hand the CLI a session it cannot renew.
    const html = renderDeviceConsentScreen({
      ...DEVICE_PARAMS,
      scopes: [
        parsed("openid"),
        parsed("offline_access"),
        parsed("core.note:read"),
      ],
      bundles: DEFAULT_PERMISSION_BUNDLES,
    });
    expect(rowFor(html, "openid")).toContain("hidden");
    expect(rowFor(html, "offline_access")).toContain("hidden");
  });
});
