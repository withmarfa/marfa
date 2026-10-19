import { describe, it, expect } from "vitest";
import type { ParsedScope, PermissionBundle } from "@withmarfa/shared";
import {
  GLOBAL_TYPE_WILDCARD,
  PERMISSIONS,
  parseScope,
  scopesToMetadataPermissions,
  subtreeWildcardRoot,
} from "@withmarfa/shared";
import { buildAllowedScopes } from "../auth/oauth-provider.js";
import { pageAssetUrl } from "../pages/assets.js";
import {
  decodeEntities,
  defaultSubmission,
  readControls,
  visibleText,
} from "../test-html.js";
import { buildScopeDescriptions } from "./auth-consent.js";
import { PERMISSION_LABELS } from "./permission-labels.js";
import {
  OPEN_ENDED_EXPANSION_TAIL,
  OPEN_ENDED_LINE,
} from "./scope-openness.js";
import { SCOPE_LABELS } from "./scope-copy.js";
import { renderConsentScreen } from "./test-render.js";

/**
 * The Approve access screen, read the way a person and a form read it: by
 * text, roles and field names, never by class names or tag shapes.
 */

const scope = (literal: string): ParsedScope => {
  const parsed = parseScope(literal);
  if (!parsed) throw new Error(`unparseable: ${literal}`);
  return parsed;
};

const SIGNED_QUERY =
  "response_type=code&client_id=client-abc&redirect_uri=http%3A%2F%2Flocalhost%2Fcallback&scope=core.note%3Aread&state=abc&code_challenge=def&code_challenge_method=S256&exp=1778957000&sig=somesignaturehash";

const render = (
  literals: string[],
  extra: Partial<Parameters<typeof renderConsentScreen>[0]> = {},
): string =>
  renderConsentScreen({
    clientName: "Test CLI",
    clientId: "client-abc",
    oauthQuery: SIGNED_QUERY,
    scopes: literals.map(scope),
    ...extra,
  });

const selects = (html: string) =>
  readControls(html).filter((c) => c.tag === "select");
const switches = (html: string) =>
  readControls(html).filter((c) => c.role === "switch");

describe("renderConsentScreen: the page", () => {
  it("uses the shared page system, with no inline style, no handlers and no script", () => {
    const html = render(["core.note:read"]);
    expect(html).toContain(`href="${pageAssetUrl("pages.css")}"`);
    expect(html).not.toContain("<style");
    expect(html).not.toMatch(/\sstyle=|\son[a-z]+=/);
    expect(html).not.toContain("<script");
    expect(visibleText(html)).not.toContain("needs JavaScript");
  });

  it("names the app, the instance and who is signed in", () => {
    const text = visibleText(
      render(["core.note:read"], {
        instanceName: "Home",
        signedInAs: "owner@example.test",
      }),
    );
    expect(text).toContain("Test CLI wants access to Home");
    expect(text).toContain("Signed in as owner@example.test");
  });

  it("escapes a hostile app name", () => {
    const html = render(["core.note:read"], {
      clientName: "<script>x</script>",
    });
    expect(html).not.toContain("<script>x</script>");
    expect(visibleText(html)).toContain("<script>x</script> wants access");
  });

  it("posts the signed request back unchanged to the decision handler, with Deny before Approve", () => {
    const html = render(["core.note:read"]);
    expect(html).toMatch(
      /<form[^>]*method="post"[^>]*action="\/auth\/authorize\/decision"/,
    );
    const controls = readControls(html);
    expect(controls.find((c) => c.name === "oauth_query")?.value).toBe(
      SIGNED_QUERY,
    );
    expect(controls.find((c) => c.name === "client_id")?.value).toBe(
      "client-abc",
    );
    expect(
      controls
        .filter((c) => c.name === "accept")
        .map((c) => [c.value, c.label]),
    ).toEqual([
      ["false", "Deny"],
      ["true", "Approve"],
    ]);
  });

  it("says that approving with everything off denies the request", () => {
    expect(visibleText(render(["core.note:read"]))).toContain(
      "If everything is off, approving denies the request.",
    );
  });

  it("cautions that the app is unverified, as a status", () => {
    const html = render(["core.note:read"]);
    expect(html).toContain('role="status"');
    expect(visibleText(html)).toContain("can't confirm who made this app");
  });

  it("names the origin of each web page the approval allows", () => {
    const text = visibleText(
      render(["core.note:read"], {
        webOrigins: ["https://one.example", "https://two.example"],
      }),
    );
    expect(text).toContain(
      "Approving also lets web pages at https://one.example and https://two.example reach Marfa from your browser.",
    );
    expect(
      visibleText(render(["core.note:read"], { webOrigins: [] })),
    ).not.toContain("from your browser");
  });
});

describe("renderConsentScreen: one control for each thing asked for", () => {
  it("offers a type asked at both levels as one control with three choices, never two boxes", () => {
    const html = render(["core.note:read", "core.note:write"]);
    const found = selects(html);
    expect(found).toHaveLength(1);
    expect(found[0]?.label).toBe("Notes");
    expect(found[0]?.options.map((o) => [o.label, o.value])).toEqual([
      ["No access", ""],
      ["Read only", "core.note:read"],
      ["Read and edit", "core.note:write"],
    ]);
    expect(
      readControls(html).filter((c) => c.type === "checkbox"),
    ).toHaveLength(0);
  });

  it("offers no level above the one asked for", () => {
    const found = selects(render(["core.note:read", "core.task:read"]));
    for (const select of found)
      expect(select.options.map((o) => o.label)).toEqual([
        "No access",
        "Read only",
      ]);
  });

  it("starts every type at the highest level asked for", () => {
    expect(
      defaultSubmission(
        render(["core.note:read", "core.note:write", "core.task:read"]),
        "scopes",
      ),
    ).toEqual(["core.note:write", "core.task:read"]);
  });

  it("offers links, metadata and profile only when asked for", () => {
    const narrow = render(["core.note:read"]);
    const text = visibleText(narrow);
    expect(text).not.toContain("Your profile");
    expect(text).not.toContain("Which items");
    expect(selects(narrow)).toHaveLength(1);

    const requested = [
      "edge.parent-of:write",
      "edge.parent-of:read",
      "metadata.types:read",
      "profile:read",
    ];
    const wide = visibleText(
      render(requested, {
        descriptions: buildScopeDescriptions(requested.map(scope)),
      }),
    );
    expect(wide).toContain("Which items sit inside others");
    expect(wide).toContain("Custom data types");
    expect(wide).toContain("Your profile");
  });

  it("carries the mechanisms unseen and offers the profile claims as switches", () => {
    const html = render([
      "openid",
      "offline_access",
      "profile",
      "email",
      "core.note:read",
    ]);
    const text = visibleText(html);
    expect(text).toContain("Your name and picture");
    expect(text).toContain("Your email address");
    expect(text).not.toContain("openid");
    expect(text).not.toContain("offline_access");
    const controls = readControls(html);
    expect(
      controls
        .filter((c) => c.type === "hidden" && c.name === "scopes")
        .map((c) => c.value),
    ).toEqual(["openid", "offline_access"]);
    expect(switches(html).map((c) => c.value)).toEqual(["profile", "email"]);
  });

  it("shows no scope literal to a person", () => {
    const text = visibleText(
      render(["core.note:read", "core.note:write", "webhooks.manage"]),
    );
    expect(text).not.toMatch(/core\.note|webhooks\.manage|:read|:write/);
  });

  it("renders a type the registry no longer holds with a plain name and a working control", () => {
    const html = render(["user.gone_type:read"]);
    const found = selects(html);
    expect(found).toHaveLength(1);
    expect(found[0]?.label).toBe("Gone type");
    expect(found[0]?.options.map((o) => o.value)).toEqual([
      "",
      "user.gone_type:read",
    ]);
  });
});

describe("renderConsentScreen: powers", () => {
  it("starts every power off, grouped, each a switch with its own words", () => {
    const html = render([...PERMISSIONS]);
    const found = switches(html);
    expect(found.map((c) => c.value).sort()).toEqual([...PERMISSIONS].sort());
    expect(found.every((c) => !c.checked)).toBe(true);
    const text = visibleText(html);
    for (const heading of [
      "Keys and apps",
      "Running Marfa",
      "Connections and records",
    ])
      expect(text).toContain(heading);
    for (const permission of PERMISSIONS)
      expect(text).toContain(PERMISSION_LABELS[permission]);
    expect(defaultSubmission(html, "scopes")).toEqual([]);
  });

  it("marks the powers that delete data for good, and only those", () => {
    const html = render([...PERMISSIONS]);
    const marked = [...html.matchAll(/class="rd danger"[^>]*>([^<]*)</g)].map(
      (m) => decodeEntities(m[1] ?? ""),
    );
    expect(marked).toHaveLength(3);
    for (const note of marked) expect(note).toContain("Can't be undone");
    const text = visibleText(html);
    expect(text).toContain("Delete items in the trash for good");
    expect(text).toContain(
      "Some jobs permanently delete data that is due to go.",
    );
  });

  it("starts a power off even when a default-on bundle claims it", () => {
    const html = render(["keys.mint"], {
      bundles: [
        {
          id: "all",
          label: "All",
          description: "",
          scopes: ["keys.mint"],
          default_on: true,
        },
      ],
    });
    expect(switches(html)[0]?.checked).toBe(false);
  });
});

describe("renderConsentScreen: a grant that reaches things not yet created", () => {
  const openEnded = (parsed: ParsedScope): boolean => {
    if (parsed.kind === "oidc" || parsed.kind === "permission") return false;
    if (parsed.typePattern === GLOBAL_TYPE_WILDCARD) return true;
    if (subtreeWildcardRoot(parsed.typePattern) !== null) return true;
    return (
      scopesToMetadataPermissions([
        `${parsed.typePattern}:${parsed.operation}`,
      ])["*"] !== undefined
    );
  };

  /** The words a reader takes as "and whatever comes next". They are
   *  reserved for the sentence the screen composes, so copy that borrows one
   *  is copy to look at before it ships. */
  const FUTURITY =
    /\b(?:later|future|yet|upcoming|forthcoming|henceforth|subsequently)\b|\badd(?:s|ed|ing)?\b|\bfrom now on\b|\bgoing forward\b|\bnew (?:ones|types|kinds|members)\b/i;
  const COMPOSED = [OPEN_ENDED_LINE, OPEN_ENDED_EXPANSION_TAIL];

  const strip = (text: string): { stated: number; residue: string } => {
    let residue = text;
    let stated = 0;
    for (const sentence of COMPOSED) {
      const parts = residue.split(sentence);
      stated += parts.length - 1;
      residue = parts.join(" ");
    }
    return { stated, residue };
  };

  const openLiterals = (): string[] =>
    buildAllowedScopes().filter((literal) => {
      const parsed = parseScope(literal);
      return parsed !== null && openEnded(parsed);
    });

  /** The row's own text: its title and the line under it. */
  const rowText = (html: string, literal: string): string => {
    const control = readControls(html).find(
      (c) => c.tag === "select" && c.options.some((o) => o.value === literal),
    );
    const id = control?.id ?? "";
    const row = new RegExp(
      `<div class="row[^"]*">(?:(?!<div class="row)[\\s\\S])*?id="${id}"`,
    ).exec(html)?.[0];
    return visibleText(row ?? "");
  };

  it("finds open-ended literals in the allowlist at all", () => {
    const literals = openLiterals();
    expect(literals.length).toBeGreaterThan(3);
    expect(literals).toContain("user.*:read");
    expect(literals).toContain("metadata:read");
  });

  it("says so once on the row, in the screen's words and not the copy's", () => {
    for (const literal of openLiterals()) {
      const parsed = scope(literal);
      const html = render([literal], {
        descriptions: buildScopeDescriptions([parsed]),
      });
      const text = rowText(html, literal);
      expect(text, `no row for ${literal}`).not.toBe("");
      const { stated, residue } = strip(text);
      expect(
        stated,
        `${literal} states its open ending ${String(stated)} times`,
      ).toBe(1);
      expect(residue, `${literal} states it again in copy`).not.toMatch(
        FUTURITY,
      );
    }
  });

  it("names the types a pattern matches today, and still says it once", () => {
    for (const literal of openLiterals()) {
      const parsed = scope(literal);
      const html = render([literal], {
        descriptions: buildScopeDescriptions([parsed]),
        wildcardExpansions: {
          [parsed.typePattern]: ["Recipes", "Training log"],
        },
      });
      const text = rowText(html, literal);
      expect(text).toContain("Today this covers Recipes, Training log");
      expect(strip(text).stated).toBe(1);
    }
  });

  it("says nothing of the kind on a concrete scope", () => {
    const html = render(["core.note:read"], {
      descriptions: buildScopeDescriptions([scope("core.note:read")]),
    });
    const text = rowText(html, "core.note:read");
    expect(text).toContain("Notes");
    const { stated, residue } = strip(text);
    expect(stated).toBe(0);
    expect(residue).not.toMatch(FUTURITY);
  });

  it("keeps futurity out of every curated name", () => {
    for (const [pattern, name] of Object.entries(SCOPE_LABELS))
      expect(name, pattern).not.toMatch(FUTURITY);
  });

  it("offers the whole of the data as one row", () => {
    const html = render(["*:read", "*:write"], {
      descriptions: buildScopeDescriptions([scope("*:write")]),
    });
    const found = selects(html);
    expect(found).toHaveLength(1);
    expect(found[0]?.label).toBe("All your data");
    expect(found[0]?.options.map((o) => o.label)).toEqual([
      "No access",
      "Read only",
      "Read and edit",
    ]);
  });
});

describe("renderConsentScreen: asking again", () => {
  const BASE = ["core.note:read", "core.note:write", "core.task:read"];

  it("says what is new, and keeps what the app holds in a closed section", () => {
    const html = render(BASE, { priorScopes: ["core.note:read"] });
    const text = visibleText(html);
    expect(text).toContain("Test CLI wants more access");
    expect(text).toContain("It already has access to some of your data");
    expect(text).toContain("Already allowed");
    expect(html).toMatch(/<details(?![^>]*\sopen)/);
    expect(text).toContain("Notes Read only");
  });

  it("greets an app that holds only openid as a first request", () => {
    const html = render(BASE, { priorScopes: ["openid", "offline_access"] });
    const text = visibleText(html);
    expect(text).toContain("Test CLI wants access to Marfa");
    expect(text).not.toContain("wants more access");
    expect(text).not.toContain("already has access");
    expect(text).not.toContain("Already allowed");
    expect(text).not.toContain("New");
    expect(text).toContain("Authorize Test CLI");
  });

  it("marks what is new, and what the row holds now", () => {
    const text = visibleText(render(BASE, { priorScopes: ["core.note:read"] }));
    expect(text).toContain("Now: Read only");
    expect(text.split("New").length - 1).toBeGreaterThanOrEqual(2);
  });

  it("never offers a level below what the app holds", () => {
    const html = render(BASE, { priorScopes: ["core.note:read"] });
    const note = selects(html).find((c) => c.label === "Notes");
    expect(note?.options.map((o) => o.label)).toEqual([
      "Read only",
      "Read and edit",
    ]);
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
      const html = render(asked, { priorScopes: held });
      const select = selects(html).find((c) => c.label === label);
      expect(select?.options.map((o) => [o.value, o.label])).toEqual([
        ["", "Read only"],
        [asked.find((l) => l.endsWith(":write")), "Read and edit"],
      ]);
      // The write stays what is asked, and keeping what is held posts nothing.
      expect(select?.value).toBe(asked.find((l) => l.endsWith(":write")));
      expect(select?.options.some((o) => o.label === "No access")).toBe(false);
    },
  );

  it("starts on the held level when the level asked for starts off", () => {
    const html = render(["core.note:write"], {
      priorScopes: ["core.note:read"],
      bundles: [
        {
          id: "manage",
          label: "Manage your server",
          description: "",
          scopes: ["core.note:write"],
          default_on: false,
        },
      ],
    });
    expect(selects(html)[0]?.value).toBe("");
    expect(defaultSubmission(html, "scopes")).toEqual([]);
  });

  it("carries what the app holds in full, with no control, so a token still has it", () => {
    const html = render(BASE, {
      priorScopes: ["core.note:read", "core.note:write"],
    });
    expect(selects(html).map((c) => c.label)).toEqual(["Tasks"]);
    expect(defaultSubmission(html, "scopes")).toEqual([
      "core.note:read",
      "core.note:write",
      "core.task:read",
    ]);
  });

  it("recognizes that a wildcard held covers a type asked for", () => {
    const html = render(["core.note:read", "core.task:read"], {
      priorScopes: ["core.*:read"],
    });
    expect(selects(html)).toHaveLength(0);
    expect(visibleText(html)).toContain("wants to confirm its access");
  });

  it("confirms what the app already has when nothing is new", () => {
    const html = render(BASE, {
      priorScopes: ["core.note:write", "core.task:read"],
    });
    const text = visibleText(html);
    expect(text).toContain("wants to confirm its access");
    expect(text).toContain("It already has all of this");
    expect(selects(html)).toHaveLength(0);
    expect(switches(html)).toHaveLength(0);
    expect(defaultSubmission(html, "scopes").sort()).toEqual([...BASE].sort());
  });

  it("tells a person where to lower what the app holds", () => {
    expect(
      visibleText(render(BASE, { priorScopes: ["core.note:read"] })),
    ).toContain("To lower it, use Connected apps");
  });

  it("keeps a power the app holds on, without offering it again", () => {
    const html = render(["keys.mint", "webhooks.manage"], {
      priorScopes: ["keys.mint"],
    });
    expect(switches(html).map((c) => c.value)).toEqual(["webhooks.manage"]);
    expect(defaultSubmission(html, "scopes")).toEqual(["keys.mint"]);
    expect(visibleText(html)).toContain("Make, see, edit and revoke keys On");
  });
});

describe("renderConsentScreen: what starts on", () => {
  const ON: PermissionBundle = {
    id: "read",
    label: "Read your content",
    description: "",
    scopes: ["core.note:read", "core.task:read"],
    default_on: true,
  };
  const OFF: PermissionBundle = {
    id: "manage",
    label: "Manage your server",
    description: "",
    scopes: ["core.note:write"],
    default_on: false,
  };
  const REQUESTED = ["core.note:read", "core.task:read", "core.note:write"];

  it("leaves a level an off-by-default bundle offers off until it is chosen", () => {
    const html = render(REQUESTED, { bundles: [ON, OFF] });
    expect(defaultSubmission(html, "scopes")).toEqual([
      "core.note:read",
      "core.task:read",
    ]);
    // It is still there to choose.
    expect(
      selects(html)
        .find((c) => c.label === "Notes")
        ?.options.map((o) => o.value),
    ).toContain("core.note:write");
  });

  it("does not start a level on that the app already holds in full", () => {
    const html = render(REQUESTED, {
      bundles: [ON, OFF],
      priorScopes: ["core.note:read", "core.note:write"],
    });
    expect(defaultSubmission(html, "scopes")).toEqual([
      "core.note:read",
      "core.note:write",
      "core.task:read",
    ]);
  });

  it("still offers a newly asked level off", () => {
    const html = render(REQUESTED, {
      bundles: [ON, OFF],
      priorScopes: ["core.note:read"],
    });
    expect(defaultSubmission(html, "scopes")).toEqual([
      "core.note:read",
      "core.task:read",
    ]);
  });

  it("starts a scope on when any on-by-default bundle offers it", () => {
    const html = render(["core.note:write"], {
      bundles: [
        OFF,
        {
          id: "write",
          label: "Write your content",
          description: "",
          scopes: ["core.note:write"],
          default_on: true,
        },
      ],
    });
    expect(defaultSubmission(html, "scopes")).toEqual(["core.note:write"]);
  });

  it("starts a scope on when an on-by-default wildcard reaches it", () => {
    const html = render(["core.task:write"], {
      bundles: [
        {
          id: "manage",
          label: "Manage your server",
          description: "",
          scopes: ["core.task:write"],
          default_on: false,
        },
        {
          id: "write",
          label: "Write your content",
          description: "",
          scopes: ["core.*:write"],
          default_on: true,
        },
      ],
    });
    expect(defaultSubmission(html, "scopes")).toEqual(["core.task:write"]);
  });

  it("starts a scope off that no on-by-default bundle reaches", () => {
    const html = render(["user.secret:write"], {
      bundles: [
        {
          id: "manage",
          label: "Manage your server",
          description: "",
          scopes: ["user.secret:write"],
          default_on: false,
        },
        {
          id: "write",
          label: "Write your content",
          description: "",
          scopes: ["core.*:write"],
          default_on: true,
        },
      ],
    });
    expect(defaultSubmission(html, "scopes")).toEqual([]);
  });

  it("starts a wildcard off when it covers something only an off-by-default bundle offers", () => {
    const html = render(["core.*:write"], {
      bundles: [
        ON,
        {
          id: "manage",
          label: "Manage your server",
          description: "",
          scopes: ["core.note:write"],
          default_on: false,
        },
      ],
    });
    expect(defaultSubmission(html, "scopes")).toEqual([]);
  });

  it("keeps a mechanism on whatever a bundle says", () => {
    const html = render(["openid"], {
      bundles: [
        {
          id: "profile",
          label: "Your profile",
          description: "",
          scopes: ["openid"],
          default_on: false,
        },
      ],
    });
    expect(defaultSubmission(html, "scopes")).toEqual(["openid"]);
  });

  it("starts a scope on that no bundle claims", () => {
    const html = render(["core.bookmark:read"], { bundles: [OFF] });
    expect(defaultSubmission(html, "scopes")).toEqual(["core.bookmark:read"]);
  });
});
