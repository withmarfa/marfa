/**
 * Redirect-allowlist boot guard — warns loud at boot if a hosted
 * deployment runs with an empty `MARFA_OAUTH_REDIRECT_ALLOWLIST`.
 *
 * The integration OAuth bootstrap (`POST /connections/:id/oauth/start`)
 * builds the upstream authorize URL from a caller-supplied
 * `redirect_uri`. An empty allowlist now FAILS CLOSED in hosted mode —
 * every `redirect_uri` is rejected — so an operator who forgot to set the
 * var doesn't expose an authorization-code interception hole. That's the
 * safe default, but it also means the OAuth-start flow is disabled until
 * the var is set, which the operator needs to know. The boot guard makes
 * that unmissable.
 *
 * A warning rather than a hard refuse-to-start: the empty-allowlist case
 * is already safe (requests reject), so blocking boot would be needlessly
 * aggressive. Keys-mode self-hosts keep the unenforced passthrough and
 * never warn. Test environments skip the check.
 *
 * Mirrors the `senderDomainCheck` boot-guard pattern in
 * `email/sender-domain-check.ts`.
 */
import { log } from "../middleware/logger.js";

export interface RedirectAllowlistCheckOptions {
  authMode: "hosted" | "keys";
  allowlist: readonly string[];
  /** When true, skip the check (test contexts). Defaults to
   *  NODE_ENV-derived. */
  skip?: boolean;
}

/**
 * Emits a loud startup warning when the deployment is in hosted mode and
 * the OAuth redirect allowlist is empty. No-op in keys mode, when the
 * allowlist is non-empty, or under test.
 */
export function checkRedirectAllowlist(
  opts: RedirectAllowlistCheckOptions,
): void {
  const skip =
    opts.skip ?? (process.env.NODE_ENV === "test" || !process.env.NODE_ENV);
  if (skip) return;
  if (opts.authMode !== "hosted") return;
  if (opts.allowlist.length > 0) return;
  log(
    "warn",
    "MARFA_OAUTH_REDIRECT_ALLOWLIST is empty in hosted mode — the integration " +
      "OAuth start flow (POST /connections/:id/oauth/start) will reject every " +
      "redirect_uri (fail closed) to prevent authorization-code interception. " +
      "Set MARFA_OAUTH_REDIRECT_ALLOWLIST to the allowed redirect URIs to enable it.",
  );
}
