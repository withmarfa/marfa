import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  OIDC_LABELS,
  OIDC_SHORT,
  oidcLabel,
  oidcShort,
} from "./oidc-labels.js";

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
 * There is one description of these literals and there stays one.
 *
 * The guard the ticket asked for, and the only one that would have caught
 * what happened: a fix written against the maps its author found, leaving
 * the ones they did not. It reads the route sources rather than trusting a
 * count, because a count is the thing that was wrong.
 */
describe("no second description of these literals appears", () => {
  it("finds the OIDC copy in exactly one module", async () => {
    // Walks the whole of `src`, not one directory. Scoped to `routes/` it
    // could not see `auth/default-bundles.ts`, which carries a sixth
    // statement about the same grant and had drifted from the toggles it
    // heads. A guard that cannot reach the place the next one will appear
    // is a guard against the last mistake rather than the next.
    const root = join(import.meta.dirname, "..");
    const files = (await readdir(root, { recursive: true })).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
    );

    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith("oidc-labels.ts")) continue;
      const src = await readFile(join(root, file), "utf8");
      // An object literal that names two or more of the four literals as
      // keys is a map of this copy, whatever it is called. One key alone is
      // ordinary (a branch on `openid`, a scope list); two or more together
      // in a `{ key: "..." }` shape is a second vocabulary.
      // Quoted or bare key, string literal value, anywhere on the line.
      // Two or more of the four together is a map of this copy whatever it
      // is called; one alone is ordinary — a branch on `openid`, a scope
      // list, a claims-shaping object.
      const named = LITERALS.filter((l) =>
        new RegExp(`["']?${l}["']?:\\s*["'\`]`).test(src),
      );
      if (named.length >= 2) offenders.push(`${file} (${named.join(", ")})`);
    }

    expect(
      offenders,
      `a second description of the OIDC literals lives in: ${offenders.join("; ")}`,
    ).toEqual([]);
  });
});
