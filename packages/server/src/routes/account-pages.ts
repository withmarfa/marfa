/**
 * The owner's account pages: Profile, and Password and passkeys. They sit
 * under the console's gate, so a browser that is not signed in is sent to sign
 * in; the changes themselves go to the doors that already make them.
 */
import { isIP } from "node:net";
import { Hono } from "hono";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import type { AppEnv } from "../middleware/auth.js";
import type { MarfaAuth } from "../auth/instance.js";
import { requireOwnerSession } from "../auth/instance-claim.js";
import { browserSignInName } from "../auth/sign-in-names.js";
import { readInstanceName } from "../instance-name.js";
import type { Storage } from "../storage/interface.js";
import { CONSOLE_PAGES } from "./console.js";
import { consoleContentSecurityPolicy } from "./content-security-policy.js";
import { PASSKEYS_HREF, renderPasswordPage } from "./password-page.js";
import { PROFILE_HREF, renderProfilePage } from "./profile-page.js";

/** "Password only", "1 passkey" or "3 passkeys": what Home says about signing in. */
export function signInValue(passkeys: number): string {
  if (passkeys === 0) return "Password only";
  return passkeys === 1 ? "1 passkey" : `${String(passkeys)} passkeys`;
}

/**
 * What the Add dialog starts with: this browser and system, as "Safari on
 * macOS", with a number after it when the owner already has a passkey by that
 * name.
 */
export function suggestedPasskeyName(
  userAgent: string | null,
  taken: readonly (string | null)[],
): string {
  const named = browserSignInName(userAgent);
  const base =
    named === "A browser"
      ? "Passkey"
      : named.replace(/^A browser on /, "Passkey on ");
  const used = new Set(taken.map((name) => name?.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${String(n)}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/** Browsers refuse a passkey for an IP address, which has no domain to bind it to. */
function addressRefusesPasskeys(baseURL: string): boolean {
  return isIP(new URL(baseURL).hostname.replace(/^\[|\]$/g, "")) !== 0;
}

CONSOLE_PAGES.register("profile", {
  href: PROFILE_HREF,
  settings: [
    {
      id: "name",
      title: "Name",
      description: "Shown to apps you let see your profile",
      group: "Profile",
      href: `${PROFILE_HREF}#profile-name`,
    },
    {
      id: "email",
      title: "Email",
      description: "You sign in with it",
      group: "Profile",
      href: `${PROFILE_HREF}#profile-email`,
    },
  ],
  value: async ({ storage }) => {
    const owner = await storage.owner?.find();
    return owner ? { text: owner.name } : undefined;
  },
});

CONSOLE_PAGES.register("password", {
  href: PASSKEYS_HREF,
  settings: [
    {
      id: "password",
      title: "Change password",
      group: "Sign in",
      href: `${PASSKEYS_HREF}#password`,
    },
    {
      id: "passkeys",
      title: "Passkeys",
      description: "Add, rename or remove a passkey",
      group: "Sign in",
      href: `${PASSKEYS_HREF}#passkeys`,
    },
  ],
  value: async ({ storage, auth }) => {
    const owner = await storage.owner?.find();
    if (!owner || !auth) return undefined;
    return {
      text: signInValue((await auth.listOwnerPasskeys(owner.id)).length),
    };
  },
});

export function accountPages(storage: Storage, auth: MarfaAuth) {
  const router = new Hono<AppEnv>();
  const owner = async (headers: Headers) => {
    const session = await requireOwnerSession(storage, auth, headers);
    const found = await storage.owner?.find();
    if (found?.id !== session.user.id)
      throw new MarfaError(
        ErrorCode.OWNER_NOT_FOUND,
        "The claimed owner's account is unavailable.",
      );
    return found;
  };
  router.get("/profile", async (c) => {
    const { name, email } = await owner(c.req.raw.headers);
    c.header(
      "Content-Security-Policy",
      consoleContentSecurityPolicy(c.var.cspNonce),
    );
    return c.html(
      renderProfilePage({
        nonce: c.var.cspNonce,
        instanceName: await readInstanceName(storage.settings),
        owner: { name, email },
      }),
    );
  });
  router.get("/passkeys", async (c) => {
    const { id } = await owner(c.req.raw.headers);
    const passkeys = await auth.listOwnerPasskeys(id);
    c.header(
      "Content-Security-Policy",
      consoleContentSecurityPolicy(c.var.cspNonce),
    );
    return c.html(
      renderPasswordPage({
        nonce: c.var.cspNonce,
        instanceName: await readInstanceName(storage.settings),
        passkeys: passkeys.map((passkey) => ({
          id: passkey.id,
          name: passkey.name,
          added: passkey.createdAt,
        })),
        suggestedName: suggestedPasskeyName(
          c.req.header("user-agent") ?? null,
          passkeys.map((passkey) => passkey.name),
        ),
        addressProblem: addressRefusesPasskeys(auth.baseURL),
      }),
    );
  });
  return router;
}
