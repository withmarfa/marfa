/**
 * The gate on the OIDC identity claims, held at both doors that serve them.
 *
 * `profilePermissionCovers` is the sole decider for `email` and
 * `email_verified`, and for every claim a client holding no OIDC literal
 * asks for. It is also reached through `scopes.ts` on the narrowing path,
 * so a blanket mutation of it reddens `shared` — which is not the same
 * thing: these two builders are where a wrong answer becomes a claim on
 * the wire, and only a case driving them says what a client would receive.
 *
 * The scope list below holds neither `profile` nor `email`, deliberately.
 * Both builders read `scopes.includes("profile") || profilePermissionCovers(…)`,
 * so a list carrying either literal answers true through the other arm and
 * the function's answer never decides anything. With both withheld it
 * decides everything.
 *
 * Presence and absence in one table, because the absence half alone is
 * worthless: a builder that returns `{}` for every input passes every
 * "is not there" assertion in this file and fails every "is there" one.
 */
import { describe, expect, it } from "vitest";
import { buildOauthProviderPlugin } from "./oauth-provider.js";
import type { Storage } from "../storage/interface.js";

/** The user every case reads claims off. Every field the builders can emit. */
const USER = {
  id: "user_1",
  name: "A Name",
  email: "someone@example.test",
  emailVerified: true,
  image: "https://example.test/avatar.png",
};

/**
 * The two builders, taken off the plugin the server actually installs
 * rather than reimplemented here. `buildOauthProviderPlugin` needs no
 * database to construct — the storage handle is threaded to the hooks, and
 * no hook runs on this path.
 */
function claimBuilders(): {
  id_token: (input: { user: typeof USER; scopes: string[] }) => unknown;
  userinfo: (input: { user: typeof USER; scopes: string[] }) => unknown;
} {
  const plugin = buildOauthProviderPlugin({
    apiKeySalt: "salt-for-this-test",
    storage: {} as Storage,
    baseURL: "https://instance.test",
  });
  const options = (
    plugin as unknown as {
      options: {
        customIdTokenClaims: (input: {
          user: typeof USER;
          scopes: string[];
        }) => unknown;
        customUserInfoClaims: (input: {
          user: typeof USER;
          scopes: string[];
        }) => unknown;
      };
    }
  ).options;
  return {
    id_token: options.customIdTokenClaims,
    userinfo: options.customUserInfoClaims,
  };
}

/**
 * One row of `profile_permissions`, the scope that grants it, and the claims
 * that ride on it.
 *
 * `email` carries two, and they are listed together on purpose: a gate that
 * released the address and withheld the verification flag, or the reverse,
 * would be a half-open door and neither claim alone would show it.
 */
const ROWS = [
  { row: "name", scope: "profile.name:read", claims: ["name"] },
  {
    row: "email",
    scope: "profile.email:read",
    claims: ["email", "email_verified"],
  },
  { row: "avatar", scope: "profile.avatar:read", claims: ["picture"] },
] as const;

/** Every claim the two builders can emit, so absence is asked of all of them. */
const EVERY_CLAIM = ROWS.flatMap((entry) => entry.claims);

const DOORS = ["id_token", "userinfo"] as const;

describe("the profile claim gate", () => {
  for (const door of DOORS) {
    for (const { row, scope, claims } of ROWS) {
      it(`serves ${claims.join(" and ")} on the ${door} when ${row} is granted, and nothing else`, () => {
        const built = claimBuilders()[door]({
          user: USER,
          scopes: ["openid", scope],
        }) as Record<string, unknown>;
        // Present: the half that fails when the gate is stuck closed.
        for (const claim of claims) {
          expect(Object.hasOwn(built, claim), claim).toBe(true);
        }
        // Absent: the half that fails when the gate is stuck open. Asked of
        // every other claim, so a grant on one row cannot carry another.
        for (const claim of EVERY_CLAIM) {
          if ((claims as readonly string[]).includes(claim)) continue;
          expect(Object.hasOwn(built, claim), claim).toBe(false);
        }
      });

      it(`withholds ${claims.join(" and ")} on the ${door} when ${row} is not granted`, () => {
        // The other two rows granted, so the case is about this row rather
        // than about a client holding nothing.
        const others = ROWS.filter((entry) => entry.row !== row).map(
          (entry) => entry.scope,
        );
        const built = claimBuilders()[door]({
          user: USER,
          scopes: ["openid", ...others],
        }) as Record<string, unknown>;
        for (const claim of claims) {
          expect(Object.hasOwn(built, claim), claim).toBe(false);
        }
        // The control: the rows that were granted are there, so the case is
        // not passing because the builder answered nothing at all.
        for (const claim of EVERY_CLAIM) {
          if ((claims as readonly string[]).includes(claim)) continue;
          expect(Object.hasOwn(built, claim), claim).toBe(true);
        }
      });
    }

    it(`serves no identity claim on the ${door} to a client holding only openid`, () => {
      const built = claimBuilders()[door]({
        user: USER,
        scopes: ["openid"],
      }) as Record<string, unknown>;
      expect(Object.keys(built)).toEqual([]);
    });
  }
});
