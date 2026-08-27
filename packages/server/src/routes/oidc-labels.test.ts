import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  OIDC_LABELS,
  OIDC_SHORT,
  oidcLabel,
  oidcShort,
} from "./oidc-labels.js";
import { CONSENT_SCOPE_DESCRIPTIONS } from "./auth-consent.js";

/**
 * The four OIDC literals, described once.
 *
 * Five maps used to describe them and no two agreed. The compiler holds the
 * completeness half — every map here is keyed on the literal union — so what
 * these tests hold is the half a type cannot: that a sixth map does not
 * quietly appear, and that the copy says what the token actually carries.
 */
const LITERALS = ["openid", "profile", "email", "offline_access"] as const;

describe("every literal is named in both registers", () => {
  it("covers the four literals and nothing else", () => {
    // The union already holds key parity at compile time. This holds the
    // half a type cannot: that the union itself has not quietly grown a
    // fifth member nobody wrote copy for.
    for (const map of [OIDC_LABELS, OIDC_SHORT]) {
      expect(Object.keys(map).sort()).toEqual([...LITERALS].sort());
    }
  });

  it("resolves each literal to real copy through each accessor", () => {
    for (const literal of LITERALS) {
      // Not `toBeTruthy`, which a single space satisfies.
      expect(oidcLabel(literal), literal).toMatch(/\S/);
      expect(oidcShort(literal), literal).toMatch(/\S/);
    }
  });

  it("answers nothing for a literal that names no OIDC scope", () => {
    // A guard rather than a cast, so a type scope cannot be asserted into a
    // lookup that has no entry for it and come back with something.
    for (const other of [
      "core.note:read",
      "capability.webhooks",
      "",
      "OPENID",
    ]) {
      expect(oidcLabel(other), other).toBeUndefined();
      expect(oidcShort(other), other).toBeUndefined();
    }
  });

  it("does not answer for inherited Object properties", () => {
    // `hasOwnProperty` rather than `in`, or `constructor` and `toString`
    // resolve to something truthy off the prototype chain.
    for (const inherited of ["constructor", "toString", "__proto__"]) {
      expect(oidcLabel(inherited), inherited).toBeUndefined();
      expect(oidcShort(inherited), inherited).toBeUndefined();
    }
  });
});

/**
 * The copy has to match the claim set, because this is the screen where a
 * person decides.
 *
 * One of the five maps this file replaces told people that granting
 * `profile` let an application see their "username, name, bio, and avatar".
 * `customIdTokenClaims` and `customUserInfoClaims` in
 * `auth/oauth-provider.ts` return `name` and `picture` for `profile`, and
 * `email` plus `email_verified` for `email`. Nothing else.
 */
describe("the copy does not over-state what a scope grants", () => {
  it("claims nothing for profile beyond a name and a picture", () => {
    const all = [OIDC_LABELS.profile, OIDC_SHORT.profile]
      .join(" ")
      .toLowerCase();
    for (const overclaim of ["username", "bio", "handle", "phone", "address"]) {
      expect(all, `profile copy claims "${overclaim}"`).not.toContain(
        overclaim,
      );
    }
    expect(all).toContain("name");
    // The label carries it; the inline form deliberately does not, because
    // a conjunction inside a joined list reads as two items.
    expect(OIDC_LABELS.profile.toLowerCase()).toContain("picture");
  });

  it("keeps email about the address", () => {
    const all = [OIDC_LABELS.email, OIDC_SHORT.email].join(" ").toLowerCase();
    expect(all).toContain("email");
    expect(all).not.toContain("name");
  });
});

/**
 * Copy has one home per family, and stays that way.
 *
 * The guard the ticket asked for, and the only one that would have caught
 * what happened: a fix written against the maps its author found, leaving the
 * ones they did not. It reads the sources rather than trusting a count,
 * because a count is the thing that was wrong.
 *
 * It has since grown a second family rather than a second copy of itself. The
 * OIDC literals were five maps that disagreed about what `profile` hands
 * over; the scope descriptions were three that disagreed about whether a
 * metadata scope or a wildcard gets described at all. Same mistake, same
 * check, so a family is a row in the table below and a third family costs a
 * row.
 *
 * **What the walk catches is a shape, not a name**, and the shape is three
 * keyings of the same copy: the curated key (`edge.parent-of`), the bare
 * registry id the edge entries used to carry (`parent-of`), and the scope
 * literal the wire carries (`core.note:read`). The middle one is not
 * hypothetical. The edge entries were keyed that way until this branch
 * moved them, and moving them silently narrowed this guard until the keys
 * below followed.
 *
 * **What it does not catch**, in falling order of how likely it is to
 * matter:
 *
 * - A map keyed on `metadata` or `*` alone. Neither names this copy: a
 *   `{ metadata: "..." }` field is ordinary in code that has never heard of
 *   a consent screen, so those two keys stay out of the search.
 * - A map keyed on the three edge ids that are also ordinary words:
 *   `about`, `references`, `supersedes`. A `roundabout: "..."` would trip
 *   the walk on a word with nothing to do with this copy, and a second
 *   statement of the edge copy would have to hold none of the other six to
 *   escape on that alone.
 * - One key on its own. That is deliberate and load-bearing: a branch on a
 *   single literal, a claims-shaping object and a scope list all name one.
 */
const COPY_FAMILIES = [
  {
    family: "the OIDC literals",
    home: "oidc-labels.ts",
    keys: [...LITERALS] as string[],
    /**
     * Declarations that legitimately key the same strings for a *different*
     * field, cut out by name before the file is scanned. Cutting the
     * declaration rather than skipping the file is the whole point: a second
     * map of this copy appearing beside an excised one is still caught.
     */
    excise: [] as string[],
  },
  {
    family: "the type, edge, metadata and wildcard scope descriptions",
    home: "auth-consent.ts",
    // Dotted keys, plus the bare edge type ids that cannot be mistaken for
    // ordinary identifiers. The map also holds `metadata` and `*`, and
    // neither names this copy on its own: `{ metadata: "..." }` is an
    // ordinary field in code that has never heard of a consent screen.
    keys: scopeDescriptionKeys(),
    // `SCOPE_LABELS` keys many of the same patterns and is not a second
    // statement of this copy. It holds the short toggle name, a different
    // field on the same key that `labelFor` falls back *from* to a
    // description, and folding the two together would collapse a distinction
    // the renderer depends on.
    excise: ["export const SCOPE_LABELS: Record<string, string> = {"],
  },
];

/**
 * The operations the scope grammar spells, as an alternation.
 *
 * Used twice below and for opposite reasons: a key may carry one as a
 * suffix (`core.note:read`, the form the wire carries), and a *value* that
 * is one means the object is a permission map rather than copy.
 */
const OPERATIONS = "read|write|destroy";

/**
 * The search keys for the scope-description family: every dotted key in the
 * map, plus the bare registry id behind each hyphenated `edge.<id>` entry.
 *
 * The bare form is the shape the edge copy carried until this branch moved
 * it, and the shape `EDGE_TYPE_REGISTRY` still uses, so it is the keying a
 * second map would most naturally arrive in. Only the hyphenated ids:
 * `about`, `references` and `supersedes` are ordinary identifiers and would
 * put this walk on words that have nothing to do with this copy.
 */
function scopeDescriptionKeys(): string[] {
  const dotted = Object.keys(CONSENT_SCOPE_DESCRIPTIONS).filter((k) =>
    k.includes("."),
  );
  const bareEdgeIds = dotted
    .filter((k) => k.startsWith("edge."))
    .map((k) => k.slice("edge.".length))
    .filter((id) => id.includes("-"));
  return [...dotted, ...bareEdgeIds];
}

/** Every non-test module under `src`, as `[path relative to src, source]`. */
async function readSourceModules(): Promise<[string, string][]> {
  // Walks the whole of `src`, not one directory. Scoped to `routes/` it could
  // not see `auth/default-bundles.ts`, which carries a sixth statement about
  // the OIDC grant and had drifted from the toggles it heads. A guard that
  // cannot reach the place the next one will appear is a guard against the
  // last mistake rather than the next.
  const root = join(import.meta.dirname, "..");
  const files = (await readdir(root, { recursive: true })).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
  );
  return Promise.all(
    files.map(
      async (f) =>
        [f, await readFile(join(root, f), "utf8")] as [string, string],
    ),
  );
}

/** The source with one named declaration's object literal cut out of it. */
function withoutDeclaration(src: string, declaration: string): string {
  const start = src.indexOf(declaration);
  if (start === -1) return src;
  const end = src.indexOf("\n};", start);
  return end === -1 ? src : src.slice(0, start) + src.slice(end + 3);
}

/**
 * The modules holding two or more of `keys` as object-literal keys with a
 * string value: the shape a second vocabulary takes whatever it is called.
 * One key alone is ordinary: a branch on `openid`, a scope list, a
 * claims-shaping object. Two or more together is a map of this copy.
 */
function modulesNaming(
  sources: [string, string][],
  keys: string[],
  excise: string[],
): string[] {
  const out: string[] = [];
  for (const [file, raw] of sources) {
    const src = excise.reduce(withoutDeclaration, raw);
    const named = keys.filter((k) => {
      const key = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Three keyings, one search: `<key>: "..."`, `"<key>": "..."` and
      // `"<key>:read": "..."`. The lookahead drops a value that is itself a
      // permission verb, which is what tells `{ "parent-of": "write" }` in a
      // manifest apart from `{ "parent-of": "Parent and child..." }` in a
      // second copy of this map.
      return new RegExp(
        `["']?${key}(?::(?:${OPERATIONS}))?["']?:\\s*` +
          `(?!["'\`](?:${OPERATIONS})["'\`])["'\`]`,
      ).test(src);
    });
    if (named.length >= 2)
      out.push(`${file} (${named.slice(0, 4).join(", ")})`);
  }
  return out;
}

describe("copy has one home per family", () => {
  for (const { family, home, keys, excise } of COPY_FAMILIES) {
    it(`finds ${family} in exactly one module`, async () => {
      // A search that matched nothing would pass this test silently, and the
      // families differ in how their keys are derived, so the floor is
      // asserted rather than assumed.
      expect(keys.length, family).toBeGreaterThanOrEqual(4);

      const sources = await readSourceModules();
      expect(sources.length).toBeGreaterThan(50);
      const holders = modulesNaming(sources, keys, excise);

      // Positive control, and the half that makes the negative one mean
      // something: the home module must trip the same search the others are
      // required not to. Without it, a regex that had stopped matching this
      // copy's real shape would report a clean tree forever.
      expect(
        holders.filter((h) => h.startsWith(home) || h.includes(`/${home} `)),
        `the search no longer recognizes the copy in ${home}`,
      ).toHaveLength(1);

      const offenders = holders.filter(
        (h) => !(h.startsWith(home) || h.includes(`/${home} `)),
      );
      expect(
        offenders,
        `a second description of ${family} lives in: ${offenders.join("; ")}`,
      ).toEqual([]);
    });
  }
});
