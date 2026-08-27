/**
 * Single source of truth for the auth-page preview gallery: every screen and
 * its state variants, each with the exact params its renderer expects.
 *
 * This is a dev-only tool (never deployed). It imports the real page renderers,
 * the real transactional email templates, plus the shared `AUTH_CSS` and static
 * JS strings so the gallery shows exactly what ships, not a re-implementation.
 * A variant is `{ label, render() }`; screens group variants; tabs group
 * screens. The gallery renders the selected variant's full HTML document into
 * an iframe.
 *
 * Two tabs: `auth` (the hosted auth-page renderers) and `email` (the
 * transactional email templates). Both tabs share the same screen/variant
 * shape, so `resolveVariant` works uniformly across them.
 */

import { parseScope } from "@withmarfa/shared";
import type { ParsedScope } from "@withmarfa/shared";
import { renderSignInPage } from "../src/routes/sign-in-page.js";
import { renderSignUpPage } from "../src/routes/sign-up-page.js";
import { renderVerifyEmailPage } from "../src/routes/verify-email-page.js";
import { renderForgotPasswordPage } from "../src/routes/forgot-password-page.js";
import { renderResetPasswordPage } from "../src/routes/reset-password-page.js";
import { renderConsentScreen } from "../src/routes/consent.js";
import { buildScopeDescriptions } from "../src/routes/auth-consent.js";
import { renderAuthorizeExpiredPage } from "../src/routes/authorize-expired-page.js";
import {
  renderSignInLinkFailedPage,
  hostFromBaseUrl,
} from "../src/routes/sign-in-link-page.js";
import { renderSignedOutPage } from "../src/routes/signed-out-page.js";
import {
  renderDevicePage,
  renderDeviceConsentScreen,
  renderDeviceDecisionPage,
} from "../src/routes/device-pages.js";
import { renderPasskeyEnrollPage } from "../src/routes/passkey-enroll-page.js";
import { renderSecurityPage } from "../src/routes/security-page.js";
import { renderKeysPage } from "../src/routes/keys-page.js";
import { renderAuthErrorPage } from "../src/routes/auth-error.js";
import { renderInstallConsentScreen } from "../src/routes/integration-install-page.js";
import {
  renderBadTokenPage,
  renderConfirmedPage,
  renderCancelledPage,
  renderAlreadyDeletedPage,
} from "../src/routes/auth-account.js";
import {
  renderOAuthCallbackSuccess,
  renderOAuthCallbackError,
} from "../src/routes/oauth-callback.js";
import {
  renderInstallDeniedPage,
  renderInstalledPage,
} from "../src/routes/integrations.js";
import {
  renderGoogleCalendarPicker,
  renderConfigureSuccess,
  renderGenericConfigureForm,
  renderConfigureError,
  renderConnectionNotAuthorized,
} from "../src/routes/connection-configure.js";
import { renderHttpErrorPage } from "../src/routes/http-error-page.js";
import { renderVerifyEmailEmail } from "../src/auth/email-templates/verify-email.js";
import { renderMagicLinkEmail } from "../src/auth/email-templates/magic-link.js";
import { renderResetPasswordEmail } from "../src/auth/email-templates/reset-password.js";
import { renderAccountDeleteConfirmEmail } from "../src/auth/email-templates/account-delete-confirm.js";
import { renderAccountPendingDeletionEmail } from "../src/auth/email-templates/account-pending-deletion.js";
import { renderAccountDeleteCancelEmail } from "../src/auth/email-templates/account-delete-cancel.js";

export interface GalleryVariant {
  /** Stable id used in the preview URL (`?variant=…`). */
  id: string;
  /** Human label shown in the sidebar. */
  label: string;
  /** Renders the full HTML document for this variant. */
  render: () => string;
}

export interface GalleryScreen {
  /** Stable id used in the preview URL (`?screen=…`). */
  id: string;
  /** Human label shown in the left sidebar. */
  label: string;
  /** Functional states of the screen (pending / success / error …) — the
   *  "State" group in the right column. */
  variants: GalleryVariant[];
  /** Alternative design directions for this same screen — the "Variant" group
   *  shown beneath the states. Named v1 / v2 / v3. Optional. */
  designVariants?: GalleryVariant[];
}

export interface GalleryTab {
  /** Stable id used in the preview URL (`?tab=…`). */
  id: string;
  /** Human label shown in the top-center tab control. */
  label: string;
  screens: GalleryScreen[];
}

const RETURN_TO = "/auth/authorize?client_id=marfa-cli&response_type=code";

// Realistic consent scopes — a read+write+profile spread so the three groups
// all render.
const CONSENT_SCOPES: ParsedScope[] = [
  { kind: "type", typePattern: "core.note", operation: "read" },
  { kind: "type", typePattern: "core.task", operation: "read" },
  { kind: "type", typePattern: "core.bookmark", operation: "read" },
  { kind: "type", typePattern: "core.note", operation: "write" },
  { kind: "type", typePattern: "core.task", operation: "write" },
  {
    kind: "oidc",
    typePattern: "openid",
    operation: "none",
    oidcScope: "openid",
  },
  {
    kind: "oidc",
    typePattern: "profile",
    operation: "none",
    oidcScope: "profile",
  },
  { kind: "oidc", typePattern: "email", operation: "none", oidcScope: "email" },
];

const DEVICE_SCOPES: ParsedScope[] = [
  { kind: "type", typePattern: "core.note", operation: "read" },
  { kind: "type", typePattern: "core.task", operation: "write" },
  {
    kind: "oidc",
    typePattern: "openid",
    operation: "none",
    oidcScope: "openid",
  },
];

/**
 * Parses fixture scope literals, throwing rather than filtering. A typo would
 * otherwise leave a shorter list that still renders, so the variant would
 * preview fewer rows than it says it does and nothing would report it.
 *
 * Through the parser rather than as object literals because the fixture is the
 * only caller of these renderers that is not the app, which makes it the one
 * place a wrong scope shape hides. A capability carries a second field the
 * consent screen reads, and a hand-written literal that omits it renders a row
 * the real flow never would.
 */
const scopeSet = (...literals: string[]): ParsedScope[] =>
  literals.map((literal) => {
    const parsed = parseScope(literal);
    if (!parsed) throw new Error(`unparseable fixture scope: ${literal}`);
    return parsed;
  });

/**
 * One row of every kind the scope copy branches on, so each kind's words are
 * on a page somebody can read.
 *
 * Deliberately not a plausible single request: `*:read` subsumes `user.*:read`
 * and `metadata:write` subsumes `metadata.edge_types:write`, so no real client
 * asks for these together. The redundancy is the point. Every other variant in
 * this gallery is a state; this one is the copy, and the failure it guards
 * against is only visible with the kinds side by side. The consent screen shipped
 * for months naming content an app had never asked for, and what made that
 * survivable was that nobody could see all of the copy at once.
 *
 * The two content scopes carry a curated short label, so a person meets them as
 * "Notes" and never reads their description. Every other scope here has no
 * label, which is exactly what makes this the only place their copy renders:
 * the description is the row.
 *
 * `capability.webhooks` cannot arrive here through a real request. Nothing in
 * the scope allowlist emits a capability literal, so the only way one reaches a
 * consent screen today is an operator naming it in a permission bundle. It is
 * previewed anyway, because the screen already renders one, unticked and under
 * a heading of its own, and a grant nobody has looked at is what this gallery
 * is for.
 *
 * **A sample, not the coverage answer.** Whether every requestable scope
 * reaches a person as words rather than as machine text is asked of the scope
 * allowlist in `routes/consent-copy-coverage.test.ts`, because the allowlist
 * publishes around 150 literals and a page each is not a review anybody
 * performs. What this variant is for is the half a check cannot do: reading
 * the words. So it stays short enough to scan, and holds one row per branch
 * the copy actually takes rather than one row per scope.
 *
 * The last three are the branches that had no row here until the derived
 * check named them, and they are at two different stages. The two wildcards
 * are the fix: `edge.*` and `google.*` rendered as their own literals on the
 * device screen and as title-cased fragments of them on the authorize
 * screen, and they now read as sentences, one curated and one derived from
 * the publisher root it names. Previewing both is what says the derivation
 * is the same copy a curated entry would be.
 *
 * The third is still a failure a person can see: an integration's concrete
 * type falls through to the type registry, whose sentences are written for
 * somebody reading API docs and run to several hundred characters. It stays
 * in the derived check's known-uncovered list, and when copy lands for it
 * these snapshots move, which is the review that copy should get.
 */
const ALL_SCOPE_KINDS: ParsedScope[] = scopeSet(
  // OIDC literals: `openid` rides along as a hidden field, `profile` is a row.
  "openid",
  "profile",
  // Item types, the only kind with a curated toggle label.
  "core.note:read",
  "core.note:write",
  // Edges.
  "edge.authored-by:read",
  "edge.references:read",
  // Metadata, both the top-level grant and a sub-resource, which is where a
  // drift between the two would show.
  "metadata:write",
  "metadata.edge_types:write",
  // Wildcards, the widest line on the screen and the custom-namespace one.
  "*:read",
  "user.*:read",
  // A capability, which no request can carry today. See above.
  "capability.webhooks",
  // The wildcard over every relationship type, and the widest edge grant a
  // client can ask for. Nothing described it on either screen until this
  // preview showed what that looked like.
  "edge.*:read",
  // An integration's namespace wildcard, the family that grew past the four
  // curated entries and is caught up with by a rule rather than by an entry.
  // Previewed because a derived sentence is copy like any other and this is
  // where copy gets read.
  "google.*:read",
  // An integration's concrete type, which reads as described and is not: the
  // curated map has no entry, so it falls through to the registry's Sync API
  // rationale. The longest of them, deliberately.
  //
  // **On the device screen only.** `SCOPE_LABELS` names this one "Todoist
  // tasks", and the authorize screen's row is that label, so its snapshot
  // shows a clean row and hides the defect entirely. The device screen has
  // no labels and prints the description as the whole of the row, which is
  // where the paragraph lands. Reading the two variants against each other
  // is the point of previewing this scope on both.
  "todoist.task:read",
);

/** The same copy both consent surfaces resolve, from the same call the two
 *  routes make. A fixture holding its own strings previews words that do not
 *  ship, and is the second vocabulary this map exists to have removed. */
const ALL_SCOPE_KIND_DESCRIPTIONS = buildScopeDescriptions(ALL_SCOPE_KINDS);

const AUTH_SCREENS: GalleryScreen[] = [
  {
    id: "sign-in",
    label: "Sign in",
    variants: [
      {
        id: "password",
        label: "Password",
        render: () =>
          renderSignInPage({
            returnTo: RETURN_TO,
            allowSignup: true,
            oidcProviderIds: [],
          }),
      },
      {
        id: "magic",
        label: "One-time link",
        render: () =>
          renderSignInPage({
            mode: "magic",
            returnTo: RETURN_TO,
            allowSignup: true,
            oidcProviderIds: [],
          }),
      },
      {
        id: "sent",
        label: "Link sent",
        render: () =>
          renderSignInPage({
            mode: "magic",
            returnTo: RETURN_TO,
            magicLinkSent: true,
            email: "jonah@example.com",
            allowSignup: true,
            oidcProviderIds: [],
          }),
      },
      {
        // The same screen reached without the address, which happens to an
        // older link or a hand-typed URL. The resend button is omitted
        // rather than rendered over an empty field.
        id: "sent-no-email",
        label: "Link sent, address unknown",
        render: () =>
          renderSignInPage({
            mode: "magic",
            returnTo: RETURN_TO,
            magicLinkSent: true,
            allowSignup: true,
            oidcProviderIds: [],
          }),
      },
      {
        id: "error",
        label: "Wrong credentials",
        render: () =>
          renderSignInPage({
            returnTo: RETURN_TO,
            error: "invalid_credentials",
            allowSignup: true,
            oidcProviderIds: [],
          }),
      },
    ],
  },
  {
    id: "sign-up",
    label: "Sign up",
    variants: [
      {
        id: "default",
        label: "Default",
        render: () => renderSignUpPage({ returnTo: RETURN_TO }),
      },
      {
        id: "email-exists",
        label: "Email taken",
        render: () =>
          renderSignUpPage({ returnTo: RETURN_TO, error: "email_exists" }),
      },
      {
        id: "email-invalid",
        label: "Email invalid",
        render: () =>
          renderSignUpPage({ returnTo: RETURN_TO, error: "email_invalid" }),
      },
      {
        id: "weak-password",
        label: "Weak password",
        render: () =>
          renderSignUpPage({ returnTo: RETURN_TO, error: "weak_password" }),
      },
      {
        id: "password-mismatch",
        label: "Passwords differ",
        render: () =>
          renderSignUpPage({ returnTo: RETURN_TO, error: "password_mismatch" }),
      },
      {
        id: "handle-taken",
        label: "Username taken",
        render: () =>
          renderSignUpPage({ returnTo: RETURN_TO, error: "handle_taken" }),
      },
      {
        id: "missing-field",
        label: "Missing field",
        render: () =>
          renderSignUpPage({ returnTo: RETURN_TO, error: "missing_field" }),
      },
    ],
  },
  {
    id: "verify-email",
    label: "Verify email",
    variants: [
      {
        id: "pending",
        label: "Pending",
        render: () =>
          renderVerifyEmailPage({
            state: "pending",
            email: "jonah@example.com",
            returnTo: RETURN_TO,
          }),
      },
      {
        id: "success",
        label: "Verified",
        render: () =>
          renderVerifyEmailPage({ state: "success", returnTo: RETURN_TO }),
      },
      {
        id: "failure",
        label: "Link failed",
        render: () =>
          renderVerifyEmailPage({
            state: "failure",
            email: "jonah@example.com",
            returnTo: RETURN_TO,
          }),
      },
      {
        id: "resent",
        label: "Resent",
        render: () =>
          renderVerifyEmailPage({
            state: "resent",
            email: "jonah@example.com",
            returnTo: RETURN_TO,
          }),
      },
    ],
  },
  {
    id: "forgot-password",
    label: "Forgot password",
    variants: [
      {
        id: "form",
        label: "Form",
        render: () =>
          renderForgotPasswordPage({ state: "form", returnTo: RETURN_TO }),
      },
      {
        id: "sent",
        label: "Link sent",
        render: () =>
          renderForgotPasswordPage({
            state: "sent",
            email: "jonah@example.com",
          }),
      },
      {
        id: "rate-limited",
        label: "Rate limited",
        render: () =>
          renderForgotPasswordPage({
            state: "error",
            errorCode: "rate_limited",
          }),
      },
    ],
  },
  {
    id: "reset-password",
    label: "Reset password",
    variants: [
      {
        id: "form",
        label: "Form",
        render: () =>
          renderResetPasswordPage({
            state: "form",
            token: "reset-token-123",
            returnTo: RETURN_TO,
          }),
      },
      {
        id: "error",
        label: "Passwords differ",
        render: () =>
          renderResetPasswordPage({
            state: "form",
            token: "reset-token-123",
            formError: "password_mismatch",
          }),
      },
      {
        id: "success",
        label: "Updated",
        render: () =>
          renderResetPasswordPage({ state: "success", returnTo: RETURN_TO }),
      },
      {
        id: "failure",
        label: "Link failed",
        render: () => renderResetPasswordPage({ state: "failure" }),
      },
    ],
  },
  {
    id: "consent",
    label: "OAuth consent",
    variants: [
      {
        id: "first-time",
        label: "First time",
        render: () =>
          renderConsentScreen({
            clientName: "Raycast",
            unverified: true,
            scopes: CONSENT_SCOPES,
            clientId: "raycast-client",
            oauthQuery: "client_id=raycast-client&scope=...&sig=signed",
            descriptions: buildScopeDescriptions(CONSENT_SCOPES),
          }),
      },
      {
        id: "re-consent",
        label: "Re-consent",
        render: () =>
          renderConsentScreen({
            clientName: "Raycast",
            scopes: CONSENT_SCOPES,
            clientId: "raycast-client",
            oauthQuery: "client_id=raycast-client&scope=...&sig=signed",
            descriptions: buildScopeDescriptions(CONSENT_SCOPES),
            // Previously granted read-only; now also requesting write + profile.
            priorScopes: [
              "core.note:read",
              "core.task:read",
              "core.event:read",
            ],
          }),
      },
      {
        // Every kind of scope the copy branches on, on one page.
        //
        // The four variants beside this one all request content types, and
        // every content type carries a short toggle label, so the description
        // map this screen reads never reaches any of them. A metadata row, a
        // wildcard, an edge and a capability have no label at all: the
        // description is the row, and until this variant existed none of that
        // copy had ever rendered anywhere a person looks.
        id: "all-scope-kinds",
        label: "Every kind of scope",
        render: () =>
          renderConsentScreen({
            clientName: "Fieldwork",
            unverified: true,
            scopes: ALL_SCOPE_KINDS,
            clientId: "fieldwork-client",
            oauthQuery: "client_id=fieldwork-client&scope=...&sig=signed",
            descriptions: ALL_SCOPE_KIND_DESCRIPTIONS,
          }),
      },
      {
        // The signed authorize request has to survive the user's whole
        // authentication journey, and a magic link or an email
        // verification hop routinely outlasts it — so this is a state a
        // real user reaches, not just a malformed-request screen.
        id: "expired",
        label: "Request expired",
        render: () => renderAuthorizeExpiredPage("expired"),
      },
      {
        // The other half of the same gate, and the one worth looking at:
        // a signature that did not verify is not a timeout, and saying so
        // is what stops the next corruption bug reading as an expiry.
        id: "unverifiable",
        label: "Request unverifiable",
        render: () => renderAuthorizeExpiredPage("unverifiable"),
      },
    ],
  },
  {
    id: "sign-in-link",
    label: "Sign-in link",
    variants: [
      {
        // Where a dead one-time link lands. Only reachable by clicking a
        // link that has already been spent or has timed out, which is
        // exactly the kind of state nobody looks at until a user hits it.
        id: "failed",
        label: "Link did not work",
        render: () => renderSignInLinkFailedPage({ returnTo: RETURN_TO }),
      },
      {
        // The other half of the same route, and a different message
        // entirely: sign-up is closed, so a fresh link bounces the same
        // way and the page offers none. Two variants because the host is
        // named only when there is one worth naming, and the pair is the
        // only way to see both readings.
        //
        // Both go through `hostFromBaseUrl` on a base URL rather than
        // passing a host straight in, so the gallery can only ever show a
        // state the route can actually reach. Handing it `host: "localhost"`
        // would otherwise preview a page that no longer renders.
        id: "signup-closed",
        label: "Sign-up closed, host named",
        render: () =>
          renderSignInLinkFailedPage({
            returnTo: RETURN_TO,
            reason: "signup_closed",
            host: hostFromBaseUrl("https://marfa.so"),
          }),
      },
      {
        // The deployment that never configured its public identity, where
        // config resolves to a localhost URL and the page names no host.
        id: "signup-closed-no-host",
        label: "Sign-up closed, no host to name",
        render: () =>
          renderSignInLinkFailedPage({
            returnTo: RETURN_TO,
            reason: "signup_closed",
            host: hostFromBaseUrl("http://localhost:8600"),
          }),
      },
    ],
  },
  {
    id: "signed-out",
    label: "Signed out",
    variants: [
      {
        // The floor under browser logout: reached when the plugin ends the
        // session but has no registered return URI to send the person to,
        // which it otherwise answers with an empty document.
        id: "default",
        label: "Session ended",
        render: () => renderSignedOutPage(),
      },
    ],
  },
  {
    id: "device",
    label: "Device flow",
    variants: [
      {
        id: "verify",
        label: "Enter code",
        render: () => renderDevicePage({ prefilled: "" }),
      },
      {
        id: "verify-error",
        label: "Bad code",
        render: () =>
          renderDevicePage({ prefilled: "WXYZ-1234", error: "invalid_code" }),
      },
      {
        // Descriptions from the same call the device route makes, rather than
        // written out here. Two strings stood in this fixture and neither was
        // the copy that ships: they had drifted by a full stop, which is
        // exactly the size of difference a preview exists to show and a
        // hand-written one cannot.
        id: "consent",
        label: "Approve",
        render: () =>
          renderDeviceConsentScreen({
            clientName: "marfa CLI",
            scopes: DEVICE_SCOPES,
            userCode: "BDRF-7H2K",
            descriptions: buildScopeDescriptions(DEVICE_SCOPES),
          }),
      },
      {
        // The same scope set the authorize screen's "Every kind of scope"
        // variant renders, so the two can be read against each other. One map
        // now feeds both screens, and a page each is the only way to see that
        // they agree: the defect it replaced was never a screen being wrong on
        // its own, it was two screens each internally consistent and saying
        // different things about the same grant.
        id: "consent-all-scope-kinds",
        label: "Approve, every kind of scope",
        render: () =>
          renderDeviceConsentScreen({
            clientName: "Fieldwork",
            scopes: ALL_SCOPE_KINDS,
            userCode: "QK3M-92XT",
            descriptions: ALL_SCOPE_KIND_DESCRIPTIONS,
          }),
      },
      {
        id: "approved",
        label: "Approved",
        render: () => renderDeviceDecisionPage({ approved: true }),
      },
      {
        id: "denied",
        label: "Denied",
        render: () => renderDeviceDecisionPage({ approved: false }),
      },
    ],
  },
  {
    id: "passkey-enroll",
    label: "Passkey enroll",
    variants: [
      {
        id: "default",
        label: "Default",
        render: () => renderPasskeyEnrollPage({ email: "jonah@example.com" }),
      },
    ],
  },
  {
    id: "security",
    label: "Security",
    variants: [
      {
        id: "default",
        label: "Default",
        render: () =>
          renderSecurityPage({
            email: "jonah@example.com",
            grants: [
              {
                id: "grant-1",
                client_name: "Raycast",
                client_id: "raycast-client",
                scopes: ["core.note:read", "core.task:write"],
                granted_at: "2026-05-02T10:00:00.000Z",
                last_used_at: "2026-06-18T09:30:00.000Z",
              },
              {
                id: "grant-2",
                client_name: "Obsidian Sync",
                client_id: "obsidian-client",
                scopes: ["core.note:read"],
                granted_at: "2026-04-11T08:00:00.000Z",
                last_used_at: null,
              },
              {
                id: "grant-3",
                client_name: "Standup Bot",
                client_id: "standup-client",
                scopes: ["openid", "profile", "email"],
                granted_at: "2026-06-02T08:00:00.000Z",
                last_used_at: "2026-06-19T07:45:00.000Z",
              },
              {
                id: "grant-4",
                client_name: "Archived Importer",
                client_id: "importer-client",
                scopes: [],
                granted_at: "2026-01-14T08:00:00.000Z",
                last_used_at: null,
              },
            ],
            sessions: [
              {
                id: "session-1",
                created_at: "2026-06-01T08:00:00.000Z",
                last_active_at: "2026-06-19T11:00:00.000Z",
                is_current: true,
                ip_address: "203.0.113.7",
                user_agent:
                  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
              },
              {
                id: "session-2",
                created_at: "2026-05-20T14:00:00.000Z",
                last_active_at: "2026-06-15T19:00:00.000Z",
                is_current: false,
                ip_address: "198.51.100.42",
                user_agent:
                  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15",
              },
            ],
          }),
      },
      {
        id: "empty",
        label: "No connections",
        render: () =>
          renderSecurityPage({
            email: "jonah@example.com",
            grants: [],
            sessions: [
              {
                id: "session-1",
                created_at: "2026-06-01T08:00:00.000Z",
                last_active_at: "2026-06-19T11:00:00.000Z",
                is_current: true,
                ip_address: "203.0.113.7",
                user_agent:
                  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
              },
            ],
          }),
      },
    ],
  },
  {
    id: "keys",
    label: "API keys",
    variants: [
      {
        id: "default",
        label: "Default",
        render: () =>
          renderKeysPage({
            email: "jonah@example.com",
            keys: [
              {
                id: "key-1",
                label: "Personal laptop",
                source: "cli",
                created_at: "2026-05-10T10:00:00.000Z",
                last_used_at: "2026-06-18T09:00:00.000Z",
              },
              {
                id: "key-2",
                label: "Automation",
                source: "script",
                created_at: "2026-03-01T10:00:00.000Z",
                last_used_at: null,
              },
            ],
          }),
      },
      {
        id: "create",
        label: "Create key",
        render: () =>
          renderKeysPage({
            email: "jonah@example.com",
            forceCreate: true,
            keys: [
              {
                id: "key-1",
                label: "Personal laptop",
                source: "cli",
                created_at: "2026-05-10T10:00:00.000Z",
                last_used_at: "2026-06-18T09:00:00.000Z",
              },
            ],
          }),
      },
      {
        id: "reveal",
        label: "New key reveal",
        render: () =>
          renderKeysPage({
            email: "jonah@example.com",
            keys: [
              {
                id: "key-1",
                label: "Personal laptop",
                source: "cli",
                created_at: "2026-05-10T10:00:00.000Z",
                last_used_at: "2026-06-18T09:00:00.000Z",
              },
            ],
            newKey: "marfa_k1_examplekeyvaluethatisshownonce0000",
            newKeyLabel: "Personal laptop",
            newKeyAccess: "read and write your content",
          }),
      },
      {
        id: "reveal-no-content",
        label: "New key reveal, no content",
        render: () =>
          renderKeysPage({
            email: "jonah@example.com",
            keys: [],
            newKey: "marfa_k1_examplekeyvaluethatisshownonce0001",
            newKeyLabel: "Type registrar",
            newKeyAccess: "reach none of your content",
          }),
      },
      {
        id: "empty",
        label: "No keys",
        render: () => renderKeysPage({ email: "jonah@example.com", keys: [] }),
      },
    ],
  },
];

// Realistic fixture data for the transactional email previews. Names, URLs,
// and dates are illustrative; the action URLs are obviously fake so nobody
// mistakes a preview for a live link.
const EMAIL_NAME = "Jonah";
const VERIFY_URL =
  "https://staging.marfa.so/auth/verify-email?token=preview-verify-token";
const MAGIC_URL =
  "https://staging.marfa.so/auth/magic-link?token=preview-magic-token";
const RESET_URL =
  "https://staging.marfa.so/auth/reset-password?token=preview-reset-token";
const DELETE_CONFIRM_URL =
  "https://staging.marfa.so/auth/account/delete/confirm?token=preview-confirm-token";
const DELETE_CANCEL_URL =
  "https://staging.marfa.so/auth/account/cancel?token=preview-cancel-token";
const DELETION_DATE = "July 19, 2026";

const EMAIL_SCREENS: GalleryScreen[] = [
  {
    id: "verify-email",
    label: "Verify email",
    variants: [
      {
        id: "default",
        label: "Default",
        render: () =>
          renderVerifyEmailEmail({ url: VERIFY_URL, name: EMAIL_NAME }).html,
      },
      {
        id: "no-name",
        label: "No name",
        render: () => renderVerifyEmailEmail({ url: VERIFY_URL }).html,
      },
    ],
  },
  {
    id: "magic-link",
    label: "Sign-in link",
    variants: [
      {
        id: "default",
        label: "Default",
        render: () => renderMagicLinkEmail({ url: MAGIC_URL }).html,
      },
    ],
  },
  {
    id: "reset-password",
    label: "Reset password",
    variants: [
      {
        id: "default",
        label: "Default",
        render: () =>
          renderResetPasswordEmail({ url: RESET_URL, name: EMAIL_NAME }).html,
      },
      {
        id: "no-name",
        label: "No name",
        render: () => renderResetPasswordEmail({ url: RESET_URL }).html,
      },
    ],
  },
  {
    id: "delete-confirm",
    label: "Delete confirm",
    variants: [
      {
        id: "default",
        label: "Default",
        render: () =>
          renderAccountDeleteConfirmEmail({
            url: DELETE_CONFIRM_URL,
            name: EMAIL_NAME,
          }).html,
      },
    ],
  },
  {
    id: "pending-deletion",
    label: "Pending deletion",
    variants: [
      {
        id: "default",
        label: "Default",
        render: () =>
          renderAccountPendingDeletionEmail({
            url: DELETE_CANCEL_URL,
            deletionDate: DELETION_DATE,
            graceDays: 30,
            name: EMAIL_NAME,
          }).html,
      },
    ],
  },
  {
    id: "delete-cancel",
    label: "Sign-in attempt",
    variants: [
      {
        id: "default",
        label: "Default",
        render: () =>
          renderAccountDeleteCancelEmail({
            url: DELETE_CANCEL_URL,
            deletionDate: DELETION_DATE,
            name: EMAIL_NAME,
          }).html,
      },
      {
        id: "no-date",
        label: "No deadline",
        render: () =>
          renderAccountDeleteCancelEmail({
            url: DELETE_CANCEL_URL,
            name: EMAIL_NAME,
          }).html,
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Connection + error surfaces
// ---------------------------------------------------------------------------

/** A manifest shaped like a real one, so the install consent screen renders
 *  the scopes it actually derives rather than a placeholder. */
const INSTALL_MANIFEST: Record<string, unknown> = {
  name: "google/calendar",
  version: "1.4.0",
  publisher: "Marfa",
  summary: "Two-way sync between Google Calendar and your events.",
  direction: "both",
  target_types: ["google.calendar.event"],
};

const CONNECTION_ID = "01999a3f-96ad-4ec1-b378-399d4875cfa5";

const CONNECTION_SCREENS: GalleryScreen[] = [
  {
    id: "auth-error",
    label: "Auth error",
    // Every code the page knows, plus the fallback. These are the pages a
    // person meets when an app sends them somewhere the server refuses, and
    // until now none of them had ever been looked at.
    variants: [
      {
        id: "invalid-client",
        label: "Unknown app",
        render: () => renderAuthErrorPage("invalid_client"),
      },
      {
        id: "invalid-request",
        label: "Malformed request",
        render: () => renderAuthErrorPage("invalid_request"),
      },
      {
        id: "invalid-scope",
        label: "Invalid scope",
        render: () => renderAuthErrorPage("invalid_scope"),
      },
      {
        id: "unsupported-response-type",
        label: "Unsupported response type",
        render: () => renderAuthErrorPage("unsupported_response_type"),
      },
      {
        id: "access-denied",
        label: "Cancelled",
        render: () => renderAuthErrorPage("access_denied"),
      },
      {
        id: "server-error",
        label: "Server error",
        render: () => renderAuthErrorPage("server_error"),
      },
      {
        id: "temporarily-unavailable",
        label: "Temporarily unavailable",
        render: () => renderAuthErrorPage("temporarily_unavailable"),
      },
      {
        id: "unknown",
        label: "Unrecognized code",
        render: () => renderAuthErrorPage("something_new"),
      },
      {
        id: "none",
        label: "No code at all",
        render: () => renderAuthErrorPage(null),
      },
    ],
  },
  {
    id: "http-error",
    label: "HTTP error",
    // A browser navigation that fails. Until recently every one of these was
    // raw JSON in the viewport.
    variants: [
      { id: "404", label: "Not found", render: () => renderHttpErrorPage(404) },
      {
        id: "401",
        label: "Unauthorized",
        render: () => renderHttpErrorPage(401),
      },
      { id: "403", label: "Forbidden", render: () => renderHttpErrorPage(403) },
      {
        id: "429",
        label: "Rate limited",
        render: () => renderHttpErrorPage(429),
      },
      {
        id: "500",
        label: "Server error",
        render: () => renderHttpErrorPage(500),
      },
    ],
  },
  {
    id: "account-delete",
    label: "Account deletion",
    variants: [
      {
        id: "confirmed",
        label: "Deletion confirmed",
        render: () => renderConfirmedPage(),
      },
      {
        id: "cancelled",
        label: "Deletion cancelled",
        render: () => renderCancelledPage(),
      },
      {
        id: "already-deleted",
        label: "Already deleted",
        render: () => renderAlreadyDeletedPage(),
      },
      {
        id: "bad-token",
        label: "Bad or expired link",
        render: () => renderBadTokenPage(),
      },
    ],
  },
  {
    id: "install-consent",
    label: "Integration install",
    variants: [
      {
        id: "consent",
        label: "Consent",
        render: () =>
          renderInstallConsentScreen({
            integrationId: "01999a3f-0000-4ec1-b378-000000000001",
            manifestName: "google/calendar",
            manifestVersion: "1.4.0",
            publisher: "Marfa",
            summary: "Two-way sync between Google Calendar and your events.",
            direction: "both",
            manifest: INSTALL_MANIFEST,
          }),
      },
      {
        id: "consent-display-name",
        label: "With display name",
        // The manifest declares a label, so the heading is the label and
        // the meta line carries the identifier. Worth looking at beside
        // the plain variant: the identifier is what tells this apart from
        // anyone else publishing under the same words.
        render: () =>
          renderInstallConsentScreen({
            integrationId: "01999a3f-0000-4ec1-b378-000000000004",
            manifestName: "acme/calendar-sync",
            manifestVersion: "2.1.0",
            publisher: "Acme",
            summary: "Two-way sync between Acme Calendar and your events.",
            direction: "both",
            manifest: {
              ...INSTALL_MANIFEST,
              display_name: "Acme Calendar Sync",
            },
          }),
      },
      {
        id: "consent-configuration",
        label: "With configuration",
        render: () =>
          renderInstallConsentScreen({
            integrationId: "01999a3f-0000-4ec1-b378-000000000002",
            manifestName: "marfa/rss-watcher",
            manifestVersion: "1.0.0",
            publisher: "Marfa",
            summary: "Polls a feed and lands new entries as bookmarks.",
            direction: "read",
            manifest: {
              ...INSTALL_MANIFEST,
              configuration_schema: {
                feed_url: {
                  type: "string",
                  description: "The Atom or RSS feed to poll.",
                  required: true,
                },
              },
            },
          }),
      },
      {
        id: "consent-configuration-refused",
        label: "Configuration refused",
        render: () =>
          renderInstallConsentScreen({
            integrationId: "01999a3f-0000-4ec1-b378-000000000002",
            manifestName: "marfa/rss-watcher",
            manifestVersion: "1.0.0",
            publisher: "Marfa",
            summary: "Polls a feed and lands new entries as bookmarks.",
            direction: "read",
            manifest: {
              ...INSTALL_MANIFEST,
              configuration_schema: {
                feed_url: {
                  type: "string",
                  description: "The Atom or RSS feed to poll.",
                  required: true,
                },
              },
            },
            configurationValues: {},
            errorMessage: '"feed_url" is required',
          }),
      },
      {
        id: "installed",
        label: "Installed",
        render: () => renderInstalledPage(),
      },
      {
        id: "declined",
        label: "Declined",
        render: () => renderInstallDeniedPage(),
      },
    ],
  },
  {
    id: "oauth-callback",
    label: "Provider callback",
    variants: [
      {
        id: "success",
        label: "Authorized",
        render: () => renderOAuthCallbackSuccess("Google"),
      },
      {
        id: "error",
        label: "Provider error",
        render: () =>
          renderOAuthCallbackError(
            "access_denied: The user denied the request",
          ),
      },
      {
        id: "expired",
        label: "Request expired",
        render: () => renderOAuthCallbackError("state expired or already used"),
      },
    ],
  },
  {
    id: "connection-configure",
    label: "Configure connection",
    variants: [
      {
        id: "calendar-picker",
        label: "Calendar picker",
        render: () =>
          renderGoogleCalendarPicker({
            connectionId: CONNECTION_ID,
            calendars: [
              {
                id: "primary",
                summary: "August Cayzer",
                primary: true,
                backgroundColor: "#3f51b5",
                accessRole: "owner",
              },
              {
                id: "work",
                summary: "Work",
                backgroundColor: "#0b8043",
                accessRole: "writer",
              },
              {
                id: "family",
                summary: "Family",
                backgroundColor: "#d50000",
                accessRole: "reader",
              },
            ],
            writeFamilyChoices: ["google", "core"],
            defaultWriteFamily: "google",
          }),
      },
      {
        id: "calendar-picker-empty",
        label: "No calendars",
        // An upstream account with nothing in it is an ordinary state, not an
        // error, and the copy has to read that way.
        render: () =>
          renderGoogleCalendarPicker({
            connectionId: CONNECTION_ID,
            calendars: [],
            writeFamilyChoices: ["google", "core"],
            defaultWriteFamily: "google",
          }),
      },
      {
        id: "generic-form",
        label: "Generic form",
        render: () =>
          renderGenericConfigureForm(
            CONNECTION_ID,
            {
              name: "readwise",
              version: "1.0.0",
              publisher: "Marfa",
              direction: "read",
              target_types: ["readwise.highlight", "core.highlight"],
              configuration_schema: {
                include_highlights: {
                  type: "boolean",
                  description:
                    "Pull highlights as well as the source documents.",
                },
                since_days: {
                  type: "number",
                  description: "How far back to look on the first run.",
                },
                target_type: {
                  type: "string",
                  description: "Which type new items are written as.",
                  from_target_types: true,
                },
                tags: {
                  type: "string_array",
                  description:
                    "Tags applied to every item this connection creates.",
                },
              },
            } as never,
            { include_highlights: true, since_days: 30 },
          ),
      },
      {
        id: "generic-form-display-name",
        label: "Generic form, labeled",
        // The other half of the labeled branch. This screen leads with the
        // label and carries the identifier nowhere, which is a decision
        // worth being able to look at rather than infer: it is post-consent
        // and grants nothing, where the install screen is neither.
        render: () =>
          renderGenericConfigureForm(
            CONNECTION_ID,
            {
              name: "acme/calendar-sync",
              display_name: "Acme Calendar Sync",
              version: "2.1.0",
              publisher: "Acme",
              direction: "both",
              target_types: ["core.event"],
              configuration_schema: {
                since_days: {
                  type: "number",
                  description: "How far back to look on the first run.",
                },
              },
            } as never,
            { since_days: 30 },
          ),
      },
      {
        id: "not-authorized",
        label: "Not authorized yet",
        render: () =>
          renderConnectionNotAuthorized("01999a3f-96ad-4ec1-b378-399d4875cfa5"),
      },
      {
        id: "saved",
        label: "Saved",
        render: () => renderConfigureSuccess(),
      },
      {
        id: "error",
        label: "Error",
        render: () =>
          renderConfigureError(
            "This integration does not declare a configuration surface.",
          ),
      },
    ],
  },
];

export const TABS: GalleryTab[] = [
  { id: "auth", label: "Auth", screens: AUTH_SCREENS },
  { id: "connections", label: "Connections", screens: CONNECTION_SCREENS },
  { id: "email", label: "Email", screens: EMAIL_SCREENS },
];

/**
 * Resolve a tab + screen + variant triple, or `undefined` if any id is
 * unknown. The screen id is unique within a tab but not across tabs (both
 * tabs carry a `verify-email` and a `reset-password` screen), so resolution
 * is always scoped by tab.
 */
export function resolveVariant(
  tabId: string,
  screenId: string,
  variantId: string,
):
  | { tab: GalleryTab; screen: GalleryScreen; variant: GalleryVariant }
  | undefined {
  const tab = TABS.find((t) => t.id === tabId);
  if (!tab) return undefined;
  const screen = tab.screens.find((s) => s.id === screenId);
  if (!screen) return undefined;
  // Resolve against the screen's states first, then its design variants — the
  // two id-spaces don't collide, so a single `?variant=` param serves both.
  const variant =
    screen.variants.find((v) => v.id === variantId) ??
    screen.designVariants?.find((v) => v.id === variantId);
  if (!variant) return undefined;
  return { tab, screen, variant };
}
