import { describe, it, expect } from "vitest";
import type { ParsedScope } from "@withmarfa/shared";
import { parseScope } from "@withmarfa/shared";
import { pageAssetUrl } from "../pages/assets.js";
import { defaultSubmission, readControls, visibleText } from "../test-html.js";
import {
  renderDeviceConsentScreen,
  renderDeviceDecisionPage,
} from "./test-render.js";

/**
 * The Connect a device approval screen and the page that ends it, read the
 * way a person and a form read them: by text, roles and field names. The
 * handler-side round trip is in device-grant.test.ts and the conformance
 * suites.
 */

const scope = (literal: string): ParsedScope => {
  const parsed = parseScope(literal);
  if (!parsed) throw new Error(`unparseable: ${literal}`);
  return parsed;
};

const PARAMS = {
  clientName: "marfa CLI",
  scopes: [scope("core.note:read")],
  userCode: "ABCD1234",
};

describe("renderDeviceConsentScreen", () => {
  it("uses the shared page system, with no inline style, no handlers and no script", () => {
    const html = renderDeviceConsentScreen(PARAMS);
    expect(html).toContain(`href="${pageAssetUrl("pages.css")}"`);
    expect(html).not.toContain("<style");
    expect(html).not.toMatch(/\sstyle=|\son[a-z]+=/);
    // It works in full without a script, so it loads none and does not say
    // it needs one.
    expect(html).not.toContain("<script");
    expect(visibleText(html)).not.toContain("needs JavaScript");
  });

  it("names the app and the code the device shows, as the device shows it", () => {
    const text = visibleText(renderDeviceConsentScreen(PARAMS));
    expect(text).toContain("marfa CLI wants access to Marfa");
    expect(text).toContain("ABCD1234");
    expect(text).toContain("matches the one on your device");
  });

  it("posts the code and the decision to the device handler, with deny first", () => {
    const html = renderDeviceConsentScreen(PARAMS);
    expect(html).toMatch(
      /<form[^>]*method="post"[^>]*action="\/auth\/device\/consent"/,
    );
    const controls = readControls(html);
    expect(
      controls.find((c) => c.name === "user_code" && c.type === "hidden")
        ?.value,
    ).toBe("ABCD1234");
    const decisions = controls.filter((c) => c.name === "decision");
    expect(decisions.map((c) => [c.value, c.label])).toEqual([
      ["deny", "Deny"],
      ["approve", "Approve"],
    ]);
  });

  it("says the app is unverified", () => {
    const text = visibleText(renderDeviceConsentScreen(PARAMS));
    expect(text).toContain("can't confirm who made this app");
    expect(text).toContain("Only approve apps you trust");
  });

  it("offers one control for each type, with the levels asked for and below", () => {
    const html = renderDeviceConsentScreen({
      ...PARAMS,
      scopes: [
        scope("core.note:read"),
        scope("core.note:write"),
        scope("core.task:read"),
      ],
    });
    const selects = readControls(html).filter((c) => c.tag === "select");
    expect(selects.map((c) => c.label)).toEqual(["Notes", "Tasks"]);
    expect(
      selects.map((c) => c.options.map((o) => [o.label, o.value])),
    ).toEqual([
      [
        ["No access", ""],
        ["Read only", "core.note:read"],
        ["Read and edit", "core.note:write"],
      ],
      [
        ["No access", ""],
        ["Read only", "core.task:read"],
      ],
    ]);
    // Nothing is offered twice: a type is never a read box and a write box.
    expect(selects.every((c) => c.name === "scopes")).toBe(true);
  });

  it("starts each type at the level asked for, and a power off", () => {
    const html = renderDeviceConsentScreen({
      ...PARAMS,
      scopes: [
        scope("core.note:read"),
        scope("core.note:write"),
        scope("keys.mint"),
      ],
    });
    expect(defaultSubmission(html, "scopes")).toEqual(["core.note:write"]);
    const power = readControls(html).find((c) => c.value === "keys.mint");
    expect(power).toMatchObject({ role: "switch", checked: false });
  });

  it("shows a person plain English, never a scope literal", () => {
    const text = visibleText(
      renderDeviceConsentScreen({
        ...PARAMS,
        scopes: [scope("core.note:read"), scope("webhooks.manage")],
      }),
    );
    expect(text).toContain("Notes");
    expect(text).toContain(
      "Manage webhooks that send events to other services",
    );
    expect(text).not.toContain("core.note");
    expect(text).not.toContain("webhooks.manage");
  });

  it("maps OIDC scopes to friendly words and carries the mechanisms unseen", () => {
    const html = renderDeviceConsentScreen({
      ...PARAMS,
      scopes: [
        scope("openid"),
        scope("offline_access"),
        scope("email"),
        scope("core.note:read"),
      ],
    });
    const text = visibleText(html);
    expect(text).toContain("Your email address");
    expect(text).not.toContain("openid");
    expect(text).not.toContain("offline_access");
    const controls = readControls(html);
    expect(
      controls
        .filter((c) => c.type === "hidden" && c.name === "scopes")
        .map((c) => c.value),
    ).toEqual(["openid", "offline_access"]);
    expect(controls.find((c) => c.value === "email")).toMatchObject({
      role: "switch",
      checked: true,
    });
  });

  it("offers a repeated grant once", () => {
    const html = renderDeviceConsentScreen({
      ...PARAMS,
      scopes: [
        scope("core.note:read"),
        scope("core.note:write"),
        scope("core.note:read"),
      ],
    });
    const selects = readControls(html).filter((c) => c.tag === "select");
    expect(selects).toHaveLength(1);
    expect(selects[0]?.options).toHaveLength(3);
  });

  it("tells apart two types whose names are alike", () => {
    const html = renderDeviceConsentScreen({
      ...PARAMS,
      scopes: [scope("acme.widget:read"), scope("beta.widget:read")],
    });
    const text = visibleText(html);
    expect(text.split("Widget").length - 1).toBe(2);
    expect(text).toContain("acme.widget");
    expect(text).toContain("beta.widget");
  });

  it("escapes a hostile app name", () => {
    const html = renderDeviceConsentScreen({
      ...PARAMS,
      clientName: "<script>x</script>",
    });
    expect(html).not.toContain("<script>x</script>");
    expect(visibleText(html)).toContain("<script>x</script> wants access");
  });

  it("shows what the app holds, collapsed, and never offers a level below it", () => {
    const html = renderDeviceConsentScreen({
      ...PARAMS,
      scopes: [scope("core.note:read"), scope("core.note:write")],
      priorScopes: ["core.note:read"],
    });
    const text = visibleText(html);
    expect(text).toContain("Already allowed");
    expect(html).toMatch(/<details/);
    const select = readControls(html).find((c) => c.tag === "select");
    expect(select?.options.map((o) => o.label)).toEqual([
      "Read only",
      "Read and edit",
    ]);
    expect(select?.value).toBe("core.note:write");
    expect(text).toContain("Now: Read only");
    expect(text).toContain("New");
  });

  it.each([
    [
      "a type's write asked while its read is held",
      ["core.note:write"],
      ["core.note:read"],
      "Notes",
    ],
    [
      "a type's write asked beside a wildcard read the app holds",
      ["core.*:read", "core.note:write"],
      ["core.*:read"],
      "Notes",
    ],
    [
      "the profile's write asked while its read is held",
      ["profile:write"],
      ["profile:read"],
      "Profile",
    ],
  ])(
    "lets a person keep what the app holds, and decline the write: %s",
    (_case, asked, held, label) => {
      const html = renderDeviceConsentScreen({
        ...PARAMS,
        scopes: asked.map(scope),
        priorScopes: held,
      });
      const select = readControls(html).find(
        (c) => c.tag === "select" && c.label === label,
      );
      const write = asked.find((l) => l.endsWith(":write"));
      expect(select?.options.map((o) => [o.value, o.label])).toEqual([
        ["", "Read only"],
        [write, "Read and edit"],
      ]);
      expect(select?.value).toBe(write);
    },
  );

  it("says approving never lowers what the app holds, and where to end its access", () => {
    const text = visibleText(
      renderDeviceConsentScreen({
        ...PARAMS,
        scopes: [scope("core.note:read"), scope("core.task:read")],
        priorScopes: ["core.note:read"],
      }),
    );
    expect(text).toContain("Approving never lowers this.");
    expect(text).toContain("To end its access, use Connected apps.");
  });

  it("carries what the app holds in full without a control", () => {
    const html = renderDeviceConsentScreen({
      ...PARAMS,
      scopes: [scope("core.note:read"), scope("core.task:read")],
      priorScopes: ["core.note:read"],
    });
    const controls = readControls(html);
    expect(controls.filter((c) => c.tag === "select")).toHaveLength(1);
    expect(defaultSubmission(html, "scopes")).toEqual([
      "core.note:read",
      "core.task:read",
    ]);
  });
});

describe("renderDeviceDecisionPage", () => {
  it("confirms the approval", () => {
    const html = renderDeviceDecisionPage({ approved: true });
    expect(html).toContain('role="status"');
    const text = visibleText(html);
    expect(text).toContain("Access approved");
    expect(text).toContain("You can go back to your device");
  });

  it("confirms the denial", () => {
    const html = renderDeviceDecisionPage({ approved: false });
    expect(html).toContain('role="status"');
    expect(visibleText(html)).toContain("You didn't approve access");
  });

  it("uses the shared page system on both", () => {
    for (const approved of [true, false]) {
      expect(renderDeviceDecisionPage({ approved })).toContain(
        pageAssetUrl("pages.css"),
      );
    }
  });
});
