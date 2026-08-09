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

import type { ParsedScope } from "@withmarfa/shared";
import { renderSignInPage } from "../src/routes/sign-in-page.js";
import { renderSignUpPage } from "../src/routes/sign-up-page.js";
import { renderVerifyEmailPage } from "../src/routes/verify-email-page.js";
import { renderForgotPasswordPage } from "../src/routes/forgot-password-page.js";
import { renderResetPasswordPage } from "../src/routes/reset-password-page.js";
import { renderConsentScreen } from "../src/routes/consent.js";
import { renderAuthorizeExpiredPage } from "../src/routes/authorize-expired-page.js";
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
  { typePattern: "core.note", operation: "read" },
  { typePattern: "core.task", operation: "read" },
  { typePattern: "core.bookmark", operation: "read" },
  { typePattern: "core.note", operation: "write" },
  { typePattern: "core.task", operation: "write" },
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
  { typePattern: "core.note", operation: "read" },
  { typePattern: "core.task", operation: "write" },
  {
    kind: "oidc",
    typePattern: "openid",
    operation: "none",
    oidcScope: "openid",
  },
];

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
            // Previously granted read-only; now also requesting write + profile.
            priorScopes: [
              "core.note:read",
              "core.task:read",
              "core.event:read",
            ],
          }),
      },
      {
        // The signed authorize request has to survive the user's whole
        // authentication journey, and a magic link or an email
        // verification hop routinely outlasts it — so this is a state a
        // real user reaches, not just a malformed-request screen.
        id: "expired",
        label: "Request expired",
        render: () => renderAuthorizeExpiredPage(),
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
        id: "consent",
        label: "Approve",
        render: () =>
          renderDeviceConsentScreen({
            clientName: "marfa CLI",
            scopes: DEVICE_SCOPES,
            userCode: "BDRF-7H2K",
            descriptions: {
              "core.note": "Your notes",
              "core.task": "Your tasks",
            },
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
            newKeyAccess: "read and write your notes and tasks",
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
  name: "google.calendar",
  version: "1.4.0",
  publisher: "Marfa",
  summary: "Two-way sync between Google Calendar and your events.",
  direction: "both",
  target_types: ["google.calendar.event"],
  runtime_compatibility: ["hosted", "local"],
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
            manifestName: "google.calendar",
            manifestVersion: "1.4.0",
            publisher: "Marfa",
            summary: "Two-way sync between Google Calendar and your events.",
            direction: "both",
            manifest: INSTALL_MANIFEST,
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
            targetTypeChoices: ["google.calendar.event", "core.event"],
            defaultTargetType: "google.calendar.event",
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
            targetTypeChoices: ["google.calendar.event", "core.event"],
            defaultTargetType: "google.calendar.event",
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
