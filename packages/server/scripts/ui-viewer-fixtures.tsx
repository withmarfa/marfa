/**
 * Example values for every page Marfa's server draws, for the UI viewer.
 *
 * Each variant calls the real renderer with plain values, so a page is shown
 * in the states a person can meet. Nothing here reads a database or starts a
 * server. A new `render*` export in `src/routes/` needs a variant here;
 * `src/routes/ui-viewer-coverage.test.ts` fails until it has one.
 */
import {
  getTypeSchema,
  parseScope,
  PERMISSIONS,
  type ParsedScope,
  type TypeSchema,
  type FolderProblem,
  type FolderStatus,
  type FolderStatusCopy,
  type FolderStatusSignIn,
  type InstanceConfig,
  type WebhookDelivery,
} from "@withmarfa/shared";
import {
  describeSettings,
  getPermissionBundles,
  loadConfig,
} from "../src/config.js";
import type {
  ConfirmGate,
  SelectGroup,
  SelectOption,
} from "../src/pages/parts/index.js";
import {
  agoWords,
  createdWords,
  dateWords,
  endsSoon,
  endsWords,
  happenedWords,
  lastUsedValue,
  usedWords,
} from "../src/pages/key-time.js";
import { endChoicesFor, keyFingerprint } from "../src/pages/key-body.js";
import { paginate, type Pagination } from "../src/pages/navigation.js";
import { tooManyTries, SETUP_WORDS } from "../src/pages/setup-words.js";
import type { WebhookHistory } from "../src/pages/webhook-history.js";
import { readSettings } from "../src/settings-reading.js";
import type {
  AuditEntry,
  HousekeepingRow,
  ItemSummary,
  TrashSummary,
} from "../src/storage/interface.js";
import { HOUSEKEEPING_JOBS } from "../src/housekeeping/metadata.js";

// The route modules register their pages with the console, which is what
// gives the breadcrumb's picker and the search their pages and addresses.
import "../src/routes/account-pages.js";
import "../src/routes/activity-routes.js";
import "../src/routes/app-routes.js";
import "../src/routes/browser-routes.js";
import "../src/routes/connector-routes.js";
import "../src/routes/export-routes.js";
import "../src/routes/folder-page-routes.js";
import "../src/routes/item-page-routes.js";
import "../src/routes/key-routes.js";
import "../src/routes/settings-routes.js";
import "../src/routes/trash-page-routes.js";

import { buildScopeDescriptions } from "../src/routes/auth-consent.js";
import {
  buildAccess,
  describeHeld,
  type AccessModel,
} from "../src/routes/access-model.js";
import type { ChoosableType } from "../src/routes/access-types.js";
import { renderAuthErrorPage } from "../src/routes/auth-error-page.js";
import { renderAuthorizeExpiredPage } from "../src/routes/authorize-expired-page.js";
import { renderConsentScreen } from "../src/routes/consent.js";
import {
  CONSOLE_PAGES,
  type AttentionItem,
  type HomeReading,
  type HomeValue,
} from "../src/routes/console.js";
import { renderDevicePage } from "../src/routes/device-pages.js";
import {
  renderDeviceConsentScreen,
  renderDeviceDecisionPage,
} from "../src/routes/device-approval.js";
import { renderForgotPasswordPage } from "../src/routes/forgot-password-page.js";
import { renderHttpErrorPage } from "../src/routes/http-error-page.js";
import { renderRootPage } from "../src/routes/root-page.js";
import { renderSignInPage } from "../src/routes/sign-in-page.js";
import { renderSignedInPage } from "../src/routes/signed-in-page.js";
import { renderSignedOutPage } from "../src/routes/signed-out-page.js";
import {
  renderBackupsPage,
  renderClaimedPage,
  renderCodePage,
  renderConnectPage,
  renderDetailsPage,
  renderNamePage,
  renderPasskeyPage,
} from "../src/routes/setup-pages.js";
import { renderHomePage } from "../src/routes/home-page.js";
import {
  renderItemsPage,
  renderTypePage,
  typePlural,
  type ItemType,
} from "../src/routes/item-pages.js";
import { TrashPage } from "../src/routes/trash-pages.js";
import {
  KEYS_HREF,
  keyHref,
  renderCreateKeyPage,
  renderGoneKeyPage,
  renderKeyListPage,
  renderKeyPage,
  renderMissingKeyPage,
  type KeyListRow,
} from "../src/routes/key-pages.js";
import { withReads } from "../src/routes/key-rows.js";
import {
  appHref,
  renderAppListPage,
  renderAppPage,
  renderMissingAppPage,
  type AppListRow,
} from "../src/routes/app-pages.js";
import {
  connectorHref,
  renderConnectorListPage,
  renderConnectorPage,
  renderMissingConnectorPage,
  type ConnectorListRow,
  type ConnectorPageParams,
} from "../src/routes/connector-pages.js";
import {
  folderHref,
  renderFolderDetail,
  renderFolderList,
  renderMissingFolder,
  type FolderReading,
} from "../src/routes/folder-pages.js";
import { renderBrowsersPage } from "../src/routes/browser-pages.js";
import { renderActivityPage } from "../src/routes/activity-pages.js";
import { renderHealthPage } from "../src/routes/health-pages.js";
import { jobRows, nowRows } from "../src/routes/health-page-routes.js";
import { renderExportPage } from "../src/routes/export-page.js";
import {
  renderSettingsGroupPage,
  renderSettingsIndexPage,
  renderSettingsMissingPage,
} from "../src/routes/settings-pages.js";
import type { SettingEntry } from "../src/routes/settings-routes.js";
import { renderGeneralPage } from "../src/routes/general-pages.js";
import {
  keepingRows,
  liveRows,
  ruleRows,
  versionWords,
} from "../src/routes/general-routes.js";
import { renderProfilePage } from "../src/routes/profile-page.js";
import { renderPasswordPage } from "../src/routes/password-page.js";

export interface GalleryVariant {
  id: string;
  label: string;
  render: () => string;
}

export interface GalleryScreen {
  id: string;
  label: string;
  variants: GalleryVariant[];
  designVariants?: GalleryVariant[];
}

export interface GalleryTab {
  id: string;
  label: string;
  screens: GalleryScreen[];
}

export const VIEWER_NONCE = "viewer";

// ---------------------------------------------------------------------------
// Example values shared by the pages
// ---------------------------------------------------------------------------

const NONCE = VIEWER_NONCE;
const INSTANCE = "Jonah's Marfa";
const OWNER = { name: "Jonah Ellis", email: "jonah@example.com" };
const ADDRESS = "marfa.example.com";
const BASE_URL = `https://${ADDRESS}`;

/** A name with no place to break, as a pasted address or file name can be. */
const LONG_NAME =
  "quarterly-household-paperwork-scans-and-receipts-backup-for-the-whole-family-archive-2026-final-copy";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-22T09:30:00.000Z");
const before = (ms: number): string => new Date(NOW - ms).toISOString();
const after = (ms: number): number => NOW + ms;

/** A valid time-ordered identifier, the form every stored row has. */
const uid = (n: number): string =>
  `0199f0a0-1b2c-7d3e-8f40-${n.toString(16).padStart(12, "0")}`;

const variant = (
  id: string,
  label: string,
  render: () => string,
): GalleryVariant => ({ id, label, render });

const screen = (
  id: string,
  label: string,
  variants: GalleryVariant[],
): GalleryScreen => ({ id, label, variants });

const scopesOf = (literals: readonly string[]): ParsedScope[] =>
  literals.flatMap((literal) => {
    const parsed = parseScope(literal);
    return parsed === null ? [] : [parsed];
  });

/** The words an approval or access view needs beyond the scopes themselves. */
function accessWords(literals: readonly string[]) {
  return {
    descriptions: buildScopeDescriptions(scopesOf(literals)),
    typeLabels: {
      "user.recipe": "Recipe",
      "user.reading_list": "Reading list",
    },
    wildcardExpansions: { "user.*": ["Reading list", "Recipe"] },
  };
}

const CHOOSABLE_TYPES: readonly ChoosableType[] = [
  { id: "core.note", label: "Note" },
  { id: "core.task", label: "Task" },
  { id: "core.bookmark", label: "Bookmark" },
  { id: "core.event", label: "Event" },
  { id: "user.recipe", label: "Recipe" },
  { id: "user.reading_list", label: "Reading list" },
];

// ---------------------------------------------------------------------------
// Getting in
// ---------------------------------------------------------------------------

const SIGNED_QUERY =
  "response_type=code&client_id=client-notes&redirect_uri=https%3A%2F%2Fnotes.example.com%2Fcallback&state=example&code_challenge=example&code_challenge_method=S256&exp=1792000000&sig=example";

const LITTLE = ["core.note:read"];
const A_LOT = [
  "openid",
  "offline_access",
  "profile",
  "email",
  "core.note:read",
  "core.note:write",
  "core.task:read",
  "core.task:write",
  "core.bookmark:read",
  "user.recipe:read",
  "edge.parent-of:read",
  "edge.parent-of:write",
  "metadata.types:read",
  "metadata.types:write",
  ...PERMISSIONS,
];
const ALL_DATA = ["*:read", "*:write"];

const CONFIRM_GATE: ConfirmGate = {
  left: 4 * 60_000,
  scopes: ["core.note:write"],
  why: "To let Notes for Mac change your data or control Marfa, confirm it's you.",
};

function approval(
  literals: readonly string[],
  extra: Partial<Parameters<typeof renderConsentScreen>[0]> = {},
): string {
  return renderConsentScreen({
    instanceName: INSTANCE,
    nonce: NONCE,
    clientName: "Notes for Mac",
    clientId: "client-notes",
    oauthQuery: SIGNED_QUERY,
    scopes: scopesOf(literals),
    signedInAs: OWNER.email,
    ...accessWords(literals),
    ...extra,
  });
}

function deviceApproval(
  literals: readonly string[],
  extra: Partial<Parameters<typeof renderDeviceConsentScreen>[0]> = {},
): string {
  return renderDeviceConsentScreen({
    instanceName: INSTANCE,
    nonce: NONCE,
    clientName: "Marfa command line",
    scopes: scopesOf(literals),
    userCode: "WDJBMJHT",
    signedInAs: OWNER.email,
    ...accessWords(literals),
    ...extra,
  });
}

const SIGN_IN = {
  instanceName: INSTANCE,
  address: ADDRESS,
  nonce: NONCE,
  returnTo: "/",
};

const AUTH_ERRORS: [string | null, string][] = [
  ["invalid_client", "App not recognized"],
  ["invalid_request", "Incomplete link"],
  ["invalid_scope", "App asked for something not offered"],
  ["unsupported_response_type", "Unsupported way to sign in"],
  ["access_denied", "Sign-in canceled"],
  ["server_error", "Server error"],
  ["temporarily_unavailable", "Briefly unavailable"],
  [null, "No error code"],
];

const DEVICE_ERRORS: [string, string][] = [
  ["missing_code", "No code entered"],
  ["invalid_code", "Wrong or expired code"],
  ["expired_code", "Expired code"],
  ["already_resolved", "Code already used"],
  ["another_account", "Code started under another account"],
  ["something_else", "Something went wrong"],
];

const GETTING_IN: GalleryTab = {
  id: "getting-in",
  label: "Getting in",
  screens: [
    screen("root", "Root address", [
      variant("named", "Named instance", () => renderRootPage(NONCE, INSTANCE)),
      variant("default", "No name chosen yet", () => renderRootPage(NONCE)),
      variant("long", "Long unbroken name", () =>
        renderRootPage(NONCE, LONG_NAME),
      ),
    ]),
    screen("claim-code", "Claim: setup code", [
      variant("new", "New", () => renderCodePage(NONCE)),
      variant("empty", "No code entered", () =>
        renderCodePage(NONCE, { codeError: SETUP_WORDS.noCode }),
      ),
      variant("wrong", "Wrong code", () =>
        renderCodePage(NONCE, { codeError: SETUP_WORDS.wrongCode }),
      ),
      variant("throttled", "Too many tries", () =>
        renderCodePage(NONCE, { codeError: tooManyTries(600) }),
      ),
      variant("ended", "Setup session ended", () =>
        renderCodePage(NONCE, { notice: SETUP_WORDS.sessionEnded }),
      ),
      variant("link-spent", "Setup link already used", () =>
        renderCodePage(NONCE, { notice: SETUP_WORDS.linkSpent }),
      ),
    ]),
    screen("claim-details", "Claim: your details", [
      variant("new", "New", () => renderDetailsPage(NONCE)),
      variant("errors", "Email and password refused", () =>
        renderDetailsPage(NONCE, {
          email: "jonah@example",
          name: OWNER.name,
          errors: {
            email: "Enter a valid email address.",
            password: "Password must contain 8 to 128 characters.",
          },
        }),
      ),
      variant("missing", "Nothing entered", () =>
        renderDetailsPage(NONCE, {
          errors: {
            email: SETUP_WORDS.email,
            password: SETUP_WORDS.password,
          },
        }),
      ),
      variant("throttled", "Too many tries", () =>
        renderDetailsPage(NONCE, {
          email: OWNER.email,
          name: OWNER.name,
          notice: tooManyTries(1800),
        }),
      ),
    ]),
    screen("claimed", "Already claimed", [
      variant("named", "Named instance", () =>
        renderClaimedPage(NONCE, INSTANCE),
      ),
    ]),
    screen("setup-passkey", "Setup: passkey", [
      variant("new", "New", () => renderPasskeyPage(NONCE)),
    ]),
    screen("setup-name", "Setup: name", [
      variant("new", "Default name", () =>
        renderNamePage(NONCE, { name: "Marfa" }),
      ),
      variant("refused", "Name refused", () =>
        renderNamePage(NONCE, {
          name: "A name that is too long ".repeat(10),
          error:
            "That name can't be used. Use 200 characters or fewer, with no control characters.",
        }),
      ),
    ]),
    screen("setup-connect", "Setup: connect", [
      variant("new", "New", () => renderConnectPage(NONCE, BASE_URL)),
    ]),
    screen("setup-backups", "Setup: backups", [
      variant("folder", "Data in one folder", () =>
        renderBackupsPage(NONCE, { bucket: false }),
      ),
      variant("bucket", "Files copied to a bucket", () =>
        renderBackupsPage(NONCE, { bucket: true }),
      ),
    ]),
    screen("sign-in", "Sign in", [
      variant("new", "New", () => renderSignInPage(SIGN_IN)),
      variant("app", "Signing in for an app", () =>
        renderSignInPage({
          ...SIGN_IN,
          app: { name: "Notes for Mac" },
          returnTo: "/auth/authorize",
        }),
      ),
      variant("wrong", "Wrong email or password", () =>
        renderSignInPage({
          ...SIGN_IN,
          error: "invalid_credentials",
          email: OWNER.email,
        }),
      ),
      variant("nothing", "Nothing entered", () =>
        renderSignInPage({ ...SIGN_IN, error: "missing_field" }),
      ),
      variant("no-password", "Password missing", () =>
        renderSignInPage({
          ...SIGN_IN,
          error: "missing_field",
          email: OWNER.email,
        }),
      ),
      variant("locked", "Too many attempts, with a wait", () =>
        renderSignInPage({
          ...SIGN_IN,
          error: "too_many_attempts",
          retryAfter: 840,
          email: OWNER.email,
        }),
      ),
      variant("locked-no-wait", "Too many attempts, no wait given", () =>
        renderSignInPage({
          ...SIGN_IN,
          error: "too_many_attempts",
          email: OWNER.email,
        }),
      ),
      variant("unknown", "Something went wrong", () =>
        renderSignInPage({
          ...SIGN_IN,
          error: "unexpected",
          email: OWNER.email,
        }),
      ),
      variant("long", "Long unbroken name", () =>
        renderSignInPage({
          ...SIGN_IN,
          instanceName: LONG_NAME,
          address: LONG_NAME,
        }),
      ),
    ]),
    screen("forgot-password", "Forgot password", [
      variant("new", "New", () => renderForgotPasswordPage(NONCE)),
    ]),
    screen("signed-in", "Signed in", [
      variant("home", "Going to Home", () =>
        renderSignedInPage({
          instanceName: INSTANCE,
          nonce: NONCE,
          email: OWNER.email,
        }),
      ),
      variant("continue", "With somewhere to continue", () =>
        renderSignedInPage({
          instanceName: INSTANCE,
          nonce: NONCE,
          email: OWNER.email,
          continueTo: KEYS_HREF,
        }),
      ),
      variant("long", "Long unbroken email", () =>
        renderSignedInPage({
          instanceName: INSTANCE,
          nonce: NONCE,
          email: `${LONG_NAME}@example.com`,
        }),
      ),
    ]),
    screen("signed-out", "Signed out", [
      variant("new", "New", () => renderSignedOutPage(NONCE)),
    ]),
    screen(
      "sign-in-error",
      "Sign-in error",
      AUTH_ERRORS.map(([code, label]) =>
        variant(code ?? "none", label, () => renderAuthErrorPage(code, NONCE)),
      ),
    ),
    screen("approval", "Approve access", [
      variant("little", "Asks for little", () => approval(LITTLE)),
      variant("lot", "Asks for a lot", () => approval(A_LOT)),
      variant("all-data", "Asks for all data", () =>
        approval(ALL_DATA, { chooseTypes: CHOOSABLE_TYPES }),
      ),
      variant("open-ended", "Asks for every added type", () =>
        approval(["user.*:read", "user.*:write"]),
      ),
      variant("more", "Asks for more access", () =>
        approval(["core.note:read", "core.note:write", "core.task:read"], {
          priorScopes: ["core.note:read"],
        }),
      ),
      variant("confirm", "Confirms access it has", () =>
        approval(["core.note:read", "core.task:read"], {
          priorScopes: ["core.note:read", "core.task:read"],
        }),
      ),
      variant("gate", "Needs a recent sign-in", () =>
        approval(["core.note:read", "core.note:write"], {
          confirmGate: CONFIRM_GATE,
        }),
      ),
      variant("web", "App on a web address", () =>
        approval(LITTLE, { webOrigins: ["https://notes.example.com"] }),
      ),
      variant("long", "Long unbroken app name", () =>
        approval(LITTLE, { clientName: LONG_NAME }),
      ),
    ]),
    screen("device-code", "Connect a device: enter code", [
      variant("new", "New", () =>
        renderDevicePage({ prefilled: "", nonce: NONCE }),
      ),
      variant("prefilled", "Code filled in from the link", () =>
        renderDevicePage({ prefilled: "WDJB-MJHT", nonce: NONCE }),
      ),
      ...DEVICE_ERRORS.map(([error, label]) =>
        variant(error, label, () =>
          renderDevicePage({ prefilled: "WDJB-MJHT", error, nonce: NONCE }),
        ),
      ),
      variant("throttled", "Too many codes, with a wait", () =>
        renderDevicePage({
          prefilled: "WDJB-MJHT",
          error: "too_many_attempts",
          retryAfter: 600,
          nonce: NONCE,
        }),
      ),
      variant("throttled-no-wait", "Too many codes, no wait given", () =>
        renderDevicePage({
          prefilled: "",
          error: "too_many_attempts",
          nonce: NONCE,
        }),
      ),
    ]),
    screen("device-approval", "Connect a device: approve", [
      variant("little", "Asks for little", () => deviceApproval(LITTLE)),
      variant("lot", "Asks for a lot", () => deviceApproval(A_LOT)),
      variant("all-data", "Asks for all data", () =>
        deviceApproval(ALL_DATA, { chooseTypes: CHOOSABLE_TYPES }),
      ),
      variant("more", "Asks for more access", () =>
        deviceApproval(
          ["core.note:read", "core.note:write", "core.task:read"],
          {
            priorScopes: ["core.note:read"],
          },
        ),
      ),
      variant("gate", "Needs a recent sign-in", () =>
        deviceApproval(["core.note:write"], {
          confirmGate: {
            ...CONFIRM_GATE,
            why: CONFIRM_GATE.why.replace(
              "Notes for Mac",
              "Marfa command line",
            ),
          },
        }),
      ),
    ]),
    screen("device-decision", "Connect a device: decision", [
      variant("approved", "Approved", () =>
        renderDeviceDecisionPage({ nonce: NONCE, approved: true }),
      ),
      variant("denied", "Not approved", () =>
        renderDeviceDecisionPage({ nonce: NONCE, approved: false }),
      ),
    ]),
    screen("request-expired", "Expired approval", [
      variant("expired", "Request expired", () =>
        renderAuthorizeExpiredPage(NONCE, "expired"),
      ),
      variant("unverifiable", "Request not verified", () =>
        renderAuthorizeExpiredPage(NONCE, "unverifiable"),
      ),
    ]),
    screen("problem", "Problem pages", [
      variant("404", "Not found", () => renderHttpErrorPage(404, NONCE)),
      variant("403", "Not allowed", () => renderHttpErrorPage(403, NONCE)),
      variant("429-wait", "Too many attempts, with a wait", () =>
        renderHttpErrorPage(429, NONCE, { retryAfter: 420 }),
      ),
      variant("429", "Too many attempts, no wait given", () =>
        renderHttpErrorPage(429, NONCE),
      ),
      variant("500", "Server error", () => renderHttpErrorPage(500, NONCE)),
      variant("500-retry", "Server error, can try again", () =>
        renderHttpErrorPage(500, NONCE, { retry: true }),
      ),
      variant("400", "Request not completed", () =>
        renderHttpErrorPage(400, NONCE),
      ),
    ]),
  ],
};

// ---------------------------------------------------------------------------
// Console: shared rows
// ---------------------------------------------------------------------------

const PAGE = { nonce: NONCE, instanceName: INSTANCE };
const registry = CONSOLE_PAGES.registry;

const sourceNames = [
  "Notes for Mac",
  "Inbox Sorter",
  "import-script",
  "Reader for web",
];

const NOTE_NAMES = [
  "Kitchen renovation: quote comparison",
  "Meeting notes with the electrician",
  "Ideas for the garden",
  "Reading list for the autumn",
  "Passport renewal checklist",
  "Notes from the school evening",
  "Holiday packing list",
  "Boiler service history",
  "Birthday gift ideas",
  "Notes on the new bike",
  "Tax documents to gather",
  "Slow-cooked lamb: what worked",
];

function itemRows(
  type: string,
  count: number,
  names: readonly string[] = NOTE_NAMES,
  offset = 0,
): ItemSummary[] {
  return Array.from({ length: count }, (_, i) => ({
    id: uid(1000 + offset + i),
    type,
    version: 1 + ((offset + i) % 4),
    name: names[(offset + i) % names.length] ?? "Untitled",
    source: sourceNames[(offset + i) % sourceNames.length] ?? "",
    created_at: before((3 + 5 * (offset + i)) * DAY + 2 * HOUR),
  }));
}

const RECIPE_SCHEMA: TypeSchema = {
  id: "user.recipe",
  label: "Recipe",
  description: "A dish to cook, with its steps.",
  version: 1,
  fields: {
    title: { type: "string", required: true },
    servings: { type: "integer" },
  },
};

function schemaOf(id: string): TypeSchema {
  const schema = getTypeSchema(id);
  if (schema === undefined) throw new Error(`No shipped type ${id}`);
  return schema;
}

/** The types an instance lists on Items, each with how many items it holds. */
function itemTypes(counts: Record<string, number>): ItemType[] {
  return [
    schemaOf("core.note"),
    schemaOf("core.task"),
    schemaOf("core.bookmark"),
    schemaOf("core.event"),
    RECIPE_SCHEMA,
  ].map((schema) => ({
    schema,
    count: counts[schema.id] ?? 0,
    plural: typePlural(schema),
  }));
}

const BUSY_COUNTS = {
  "core.note": 412,
  "core.task": 96,
  "core.bookmark": 188,
  "core.event": 31,
  "user.recipe": 17,
};

const totalOf = (types: readonly ItemType[]): number =>
  types.reduce((sum, type) => sum + type.count, 0);

/** The pagination a search reports: it knows only whether another page follows. */
function openPagination(
  page: number,
  shown: number,
  hasNext: boolean,
): Pagination {
  const from = (page - 1) * 10;
  return {
    page,
    size: 10,
    last: hasNext ? page + 1 : page,
    from,
    to: from + shown,
    total: from + shown + (hasNext ? 1 : 0),
    hasPrevious: page > 1,
    hasNext,
  };
}

const keyLabels = [
  "backup-script",
  "home-dashboard",
  "photo-importer",
  "nightly-export",
  "shortcut-capture",
  "calendar-sync",
  "recipe-clipper",
  "garden-sensors",
  "printer-scans",
  "reading-list-sync",
];

const KEY_READS = ["core.note:read", "core.task:read"];

function keyRow(
  n: number,
  label: string,
  held: readonly string[],
  ends: number | null,
  lastUsed: number | null,
  maker?: string,
): KeyListRow {
  const summary =
    held.length === 0 ? "No access" : describeHeld(withReads(held), {}).summary;
  return {
    id: uid(2000 + n),
    label,
    description: `${maker === undefined ? "" : `Made by ${maker}. `}${summary}. ${endsWords(ends, NOW)}.`,
    endsSoon: endsSoon(ends, NOW),
    value: usedWords(lastUsed, NOW),
  };
}

const yourKeys: KeyListRow[] = [
  keyRow(
    1,
    "backup-script",
    ["core.note:write", "core.task:read"],
    null,
    NOW - 3 * HOUR,
  ),
  keyRow(2, "home-dashboard", KEY_READS, after(3 * DAY), NOW - 2 * DAY),
  keyRow(3, "photo-importer", ["core.bookmark:write"], after(60 * DAY), null),
];

const appKeys: KeyListRow[] = [
  keyRow(
    11,
    "inbox-sorter-sync",
    ["core.note:read"],
    after(20 * DAY),
    NOW - DAY,
    "Inbox Sorter",
  ),
  keyRow(
    12,
    "notes-mac-cache",
    ["core.note:write"],
    null,
    NOW - 5 * HOUR,
    "Notes for Mac",
  ),
];

const busyKeys: KeyListRow[] = keyLabels.map((label, i) =>
  keyRow(
    20 + i,
    label,
    i % 3 === 0 ? ["core.note:write"] : KEY_READS,
    i % 4 === 0 ? after((5 + i) * DAY) : null,
    i % 5 === 0 ? null : NOW - (i + 1) * HOUR,
  ),
);

const keyListBase = { ...PAGE, tab: "yours" as const, query: "" };

// ---------------------------------------------------------------------------
// Console: Home
// ---------------------------------------------------------------------------

function reading(
  values: Record<string, HomeValue>,
  attention: AttentionItem[] = [],
): HomeReading {
  return { values: new Map(Object.entries(values)), attention };
}

const NEW_HOME = reading({
  keys: { text: "None" },
  apps: { text: "None" },
  items: { text: "None" },
  trash: { text: "Empty" },
  connectors: { text: "None" },
  folders: { text: "None" },
  general: { text: INSTANCE },
  health: { text: "Working" },
  profile: { text: OWNER.name },
  password: { text: "Password only" },
});

const BUSY_HOME = reading({
  keys: { text: "5 keys" },
  apps: { text: "3 apps" },
  browsers: { text: "2 signed in" },
  items: { text: "744 items" },
  trash: { text: "8 items" },
  connectors: { text: "4 running" },
  folders: { text: "2 folders" },
  general: { text: INSTANCE },
  health: { text: "Working" },
  profile: { text: OWNER.name },
  password: { text: "2 passkeys" },
});

const TROUBLED_HOME = reading(
  {
    ...Object.fromEntries(BUSY_HOME.values),
    connectors: { text: "2 need a look", tone: "danger" },
    folders: { text: "1 problem", tone: "warn" },
    health: { text: "Not working", tone: "danger" },
  },
  [
    {
      title: "Key home-dashboard ends in 3 days",
      description: "Scripts using it will stop working",
      href: keyHref(uid(2002)),
      tone: "warn",
    },
    {
      title: "The disk is full",
      description: "Almost no space is left, so changes can't be saved.",
      href: "/auth/owner/health",
      tone: "danger",
    },
    {
      title: "Inbox Sorter connector is failing",
      description: "The last run failed",
      href: connectorHref(uid(3002)),
      tone: "danger",
    },
  ],
);

const home = (params: {
  reading: HomeReading;
  query?: string;
  instanceName?: string;
  address?: string;
}): string =>
  renderHomePage({
    nonce: NONCE,
    instanceName: params.instanceName ?? INSTANCE,
    address: params.address ?? ADDRESS,
    registry,
    reading: params.reading,
    query: params.query,
  });

// ---------------------------------------------------------------------------
// Console: items, types and trash
// ---------------------------------------------------------------------------

const NEW_TYPES = itemTypes({});
const BUSY_TYPES = itemTypes(BUSY_COUNTS);

const itemsBase = { ...PAGE, files: "37 files, 14.2 MB, in 5 types" };

const TYPE_LABEL: Record<string, string> = {
  "core.note": "Notes",
  "core.task": "Tasks",
  "user.recipe": "Recipes",
};

const trashedRows = (count: number, offset = 0): TrashSummary[] =>
  itemRows("core.note", count, NOTE_NAMES, offset).map((row, i) => ({
    ...row,
    type: i % 4 === 3 ? "core.task" : "core.note",
    trashed_at: before((1 + i) * DAY),
    trashed_by:
      i % 5 === 4
        ? null
        : {
            kind: "app",
            id: uid(4000),
            name: sourceNames[i % 2] ?? "Notes for Mac",
          },
  }));

function trash(
  over: Partial<Parameters<typeof TrashPage>[0]> & { rows?: TrashSummary[] },
): string {
  const { rows, ...params } = over;
  const total = over.total ?? 24;
  const q = over.q ?? "";
  const size = 10 as const;
  const pagination = over.pagination ?? paginate(total, 1, size);
  return TrashPage({
    ...PAGE,
    total,
    days: 30,
    type: undefined,
    q,
    counts: { "core.note": 15, "core.task": 6, "user.recipe": 3 },
    label: (id) => TYPE_LABEL[id] ?? id,
    data: rows ?? trashedRows(Math.min(10, total)),
    pagination,
    href: (at) => `/auth/owner/trash?page=${String(at)}&size=${String(size)}`,
    ...params,
  });
}

// ---------------------------------------------------------------------------
// Console: keys, apps, connectors
// ---------------------------------------------------------------------------

const heldAccess = (literals: readonly string[]): AccessModel =>
  buildAccess({
    scopes: scopesOf(withReads(literals)),
    held: undefined,
    ...accessWords(literals),
    chooseTypes: CHOOSABLE_TYPES,
    bundles: getPermissionBundles(),
    start: "held",
  });

const CREATE_LITERALS: readonly string[] = [
  "*:read",
  "*:write",
  "edge.*:read",
  "edge.*:write",
  "metadata:read",
  "metadata:write",
  "profile:read",
  "profile:write",
  ...PERMISSIONS,
];

const WEBHOOKS: WebhookHistory[] = [
  {
    id: uid(5001),
    url: "https://hooks.example.com/marfa",
    events: ["item.created", "item.updated"],
    active: true,
    history: {
      data: [
        delivery(1, "success", 200, 1, null, 2 * HOUR),
        delivery(2, "dead_letter", 502, 5, "HTTP 502", 9 * HOUR),
        delivery(3, "pending", null, 1, null, 10 * 60_000),
      ],
      next_cursor: null,
    },
  },
  {
    id: uid(5002),
    url: "https://backup.example.com/receive",
    events: ["item.deleted"],
    active: false,
    history: { data: [], next_cursor: null },
  },
];

function delivery(
  n: number,
  status: WebhookDelivery["status"],
  statusCode: number | null,
  attempt: number,
  error: string | null,
  ago: number,
): WebhookDelivery {
  return {
    id: uid(5100 + n),
    status,
    webhook_id: uid(5001),
    event_type: "item.created",
    status_code: statusCode,
    attempt,
    succeeded: status === "success",
    error,
    created_at: before(ago),
  };
}

interface KeyExample {
  id: string;
  label: string;
  literals: readonly string[];
  ends: number | null;
  lastUsed: number | null;
  madeBy?: { name: string | null; connected: boolean };
  denied?: { words: string[]; keep: string };
  webhooks?: WebhookHistory[] | null;
  noAccess?: boolean;
}

function keyPage(example: KeyExample): string {
  const { ends, lastUsed, literals } = example;
  const permissions = literals.filter((literal) => !literal.includes(":"));
  const typePermissions: Record<string, string> = {};
  for (const literal of literals) {
    const [name, level] = literal.split(":");
    if (name !== undefined && (level === "read" || level === "write"))
      typePermissions[name] = level;
  }
  return renderKeyPage({
    ...PAGE,
    webhooks: example.webhooks,
    id: example.id,
    label: example.label,
    madeBy: example.madeBy,
    details: [
      { title: "Source", value: example.label },
      { title: "Created", value: createdWords(NOW - 40 * DAY, NOW) },
      { title: "Last used", value: lastUsedValue(lastUsed, NOW) },
      ...(example.madeBy === undefined
        ? []
        : [
            {
              title: "Made by",
              value: example.madeBy.connected
                ? (example.madeBy.name ?? "An app")
                : `${example.madeBy.name ?? "An app"}, no longer connected`,
            },
          ]),
    ],
    ends: {
      current: ends === null ? null : dateWords(ends, NOW),
      iso: ends === null ? null : new Date(ends).toISOString(),
      choices: endChoicesFor(ends, NOW),
    },
    loaded: keyFingerprint({
      permissions,
      type_permissions: typePermissions,
      expires_at: ends === null ? null : new Date(ends).toISOString(),
    }),
    access: example.noAccess === true ? undefined : heldAccess(literals),
    denied: example.denied ?? { words: [], keep: "{}" },
    siblings: yourKeys.map((row) => ({
      title: row.label,
      href: keyHref(row.id),
    })),
  });
}

const BACKUP_KEY: KeyExample = {
  id: uid(2001),
  label: "backup-script",
  literals: ["core.note:write", "core.task:read", "webhooks.manage"],
  ends: after(60 * DAY),
  lastUsed: NOW - 3 * HOUR,
};

const appRow = (
  n: number,
  name: string,
  kind: string,
  held: readonly string[],
  lastUsed: number | null,
): AppListRow => ({
  id: uid(3000 + n),
  name,
  description: `${kind}. ${describeHeld(withReads(held), {}).summary}. Approved ${dateWords(NOW - (10 + 9 * n) * DAY, NOW)}.`,
  value: usedWords(lastUsed, NOW),
});

const APPS: AppListRow[] = [
  appRow(
    1,
    "Notes for Mac",
    "App",
    ["core.note:write", "core.task:read"],
    NOW - 2 * HOUR,
  ),
  appRow(
    2,
    "Inbox Sorter",
    "App",
    ["core.note:read", "core.bookmark:write"],
    NOW - 4 * DAY,
  ),
  appRow(
    3,
    "Reader for web",
    "Web page at reader.example.com",
    ["core.bookmark:read"],
    null,
  ),
  appRow(
    4,
    "Marfa command line",
    "Command line",
    ["*:read", "*:write"],
    NOW - 20 * 60_000,
  ),
];

const BUSY_APPS: AppListRow[] = Array.from({ length: 10 }, (_, i) =>
  appRow(
    10 + i,
    `${["Notes", "Sorter", "Reader", "Garden", "Recipes"][i % 5] ?? "App"} helper ${String(i + 1)}`,
    "App",
    KEY_READS,
    NOW - (i + 1) * DAY,
  ),
);

interface AppExample {
  id: string;
  name: string;
  details: { title: string; value: string }[];
  scopes: string[];
  keys: KeyListRow[];
}

function appPage(
  example: AppExample,
  webhooks?: WebhookHistory[] | null,
): string {
  return renderAppPage({
    ...PAGE,
    webhooks,
    id: example.id,
    name: example.name,
    details: example.details,
    scopes: example.scopes,
    access: buildAccess({
      scopes: scopesOf(withReads(example.scopes)),
      held: undefined,
      ...accessWords(example.scopes),
      chooseTypes: CHOOSABLE_TYPES,
      bundles: getPermissionBundles(),
      start: "held",
      narrowing: example.scopes,
    }),
    keys: example.keys,
    siblings: APPS.map((row) => ({ title: row.name, href: appHref(row.id) })),
  });
}

const appDetails = (
  kind: string,
  lastUsed: number | null,
  address?: string,
) => [
  { title: "Kind", value: kind },
  ...(address === undefined ? [] : [{ title: "Address", value: address }]),
  { title: "Approved", value: dateWords(NOW - 28 * DAY, NOW) },
  { title: "Ends if unused", value: dateWords(NOW + 337 * DAY, NOW) },
  { title: "Last used", value: lastUsedValue(lastUsed, NOW) },
];

const NOTES_APP: AppExample = {
  id: uid(3001),
  name: "Notes for Mac",
  details: appDetails("App", NOW - 2 * HOUR),
  scopes: ["core.note:write", "core.task:read", "profile:read"],
  keys: appKeys,
};

function connectorRow(
  n: number,
  name: string,
  what: string,
  how: string,
  value: string,
  tone?: "warn" | "danger",
): ConnectorListRow {
  return {
    id: uid(3100 + n),
    name,
    description: `${what}. ${how}.`,
    value,
    tone,
  };
}

const CONNECTORS: ConnectorListRow[] = [
  connectorRow(
    1,
    "Calendar sync",
    "Brings in events from a calendar",
    `Last run ${agoWords(NOW - 40 * 60_000, NOW)}`,
    "Running",
  ),
  connectorRow(
    2,
    "Inbox Sorter",
    "Files mail as notes",
    `Last run failed ${agoWords(NOW - 5 * HOUR, NOW)}`,
    "Failing",
    "danger",
  ),
  connectorRow(
    3,
    "Reading list",
    "Saves articles as bookmarks",
    "Reported 2 problems",
    "Problems",
    "warn",
  ),
  connectorRow(
    4,
    "Photo importer",
    "Brings in photos",
    `Last heard from ${agoWords(NOW - 3 * DAY, NOW)}`,
    "Not heard from",
    "warn",
  ),
];

const BUSY_CONNECTORS: ConnectorListRow[] = Array.from({ length: 10 }, (_, i) =>
  connectorRow(
    10 + i,
    `Connector ${String(i + 1)}`,
    "Brings in data",
    `Last run ${agoWords(NOW - (i + 1) * HOUR, NOW)}`,
    "Running",
  ),
);

const connectorBase = (over: Partial<ConnectorPageParams>): string =>
  renderConnectorPage({
    ...PAGE,
    id: uid(3101),
    name: "Calendar sync",
    description: "Brings in events from a calendar.",
    details: [
      { title: "Source", value: "calendar-sync" },
      { title: "Registered", value: dateWords(NOW - 60 * DAY, NOW) },
      { title: "Last heartbeat", value: "12 minutes ago" },
      {
        title: "Key it uses",
        value: "calendar-sync",
        href: keyHref(uid(2006)),
      },
    ],
    problems: [],
    runs: [
      {
        title: "40 minutes ago",
        value: "Succeeded",
        failed: false,
        description: "Brought in 6 events",
      },
      {
        title: "5 hours ago",
        value: "Succeeded",
        failed: false,
        description: "Brought in 2 events",
      },
      { title: "Yesterday", value: "Succeeded", failed: false },
    ],
    siblings: CONNECTORS.map((row) => ({
      title: row.name,
      href: connectorHref(row.id),
    })),
    ...over,
  });

// ---------------------------------------------------------------------------
// Console: folders
// ---------------------------------------------------------------------------

const copy = (
  n: number,
  over: Partial<FolderStatusCopy> = {},
): FolderStatusCopy => ({
  folder_store_id: uid(6000 + n),
  sequence: 40 + n,
  last_success_at: before(20 * 60_000),
  pending_uploads: 0,
  pending_downloads: 0,
  paused_removals: 0,
  first_sync_waiting: false,
  problems: [],
  received_at: before(15 * 60_000),
  age_seconds: 900,
  ...over,
});

const signIn = (
  kind: FolderStatusSignIn["kind"],
  n: number,
  name: string,
): FolderStatusSignIn => ({ kind, id: uid(6100 + n), name });

function folderStatus(
  groups: {
    signIn: FolderStatusSignIn;
    current: boolean;
    copies: FolderStatusCopy[];
  }[],
  saturated = false,
): FolderStatus {
  const current = groups
    .filter((group) => group.current)
    .flatMap((group) => group.copies);
  const problems = new Map<FolderProblem["code"], number>();
  for (const found of current.flatMap((c) => c.problems))
    problems.set(found.code, (problems.get(found.code) ?? 0) + found.count);
  return {
    folder_id: uid(6200),
    sign_ins: groups.map((group) => ({
      sign_in: group.signIn,
      current: group.current,
      copies: group.copies,
    })),
    totals: {
      saturated,
      pending_uploads: current.reduce((n, c) => n + c.pending_uploads, 0),
      pending_downloads: current.reduce((n, c) => n + c.pending_downloads, 0),
      paused_removals: current.reduce((n, c) => n + c.paused_removals, 0),
      first_sync_waiting: current.filter((c) => c.first_sync_waiting).length,
      problems: [...problems].map(([code, count]) => ({ code, count })),
    },
  };
}

const folderBase = { ...PAGE, now: NOW };

const reading_ = (
  n: number,
  title: string,
  status: FolderStatus | null,
): FolderReading => ({
  folder: { id: uid(6300 + n), title, created_at: before(80 * DAY) },
  status,
});

const QUIET = folderStatus([
  {
    signIn: signIn("app", 1, "Notes for Mac"),
    current: true,
    copies: [copy(1)],
  },
]);
const WAITING = folderStatus([
  {
    signIn: signIn("app", 1, "Notes for Mac"),
    current: true,
    copies: [copy(2, { pending_uploads: 4, pending_downloads: 1 })],
  },
]);
const NEEDS_LOOK = folderStatus([
  {
    signIn: signIn("key", 2, "backup-script"),
    current: true,
    copies: [
      copy(3, {
        first_sync_waiting: true,
        paused_removals: 12,
        pending_uploads: 3,
        last_success_at: null,
        problems: [
          { code: "conflict", count: 2 },
          { code: "refused", count: 1 },
          { code: "credential_refused", count: 1 },
          { code: "unreadable", count: 3 },
          { code: "held_file", count: 1 },
          { code: "unavailable", count: 1 },
          { code: "root_gone", count: 1 },
          { code: "settings_invalid", count: 1 },
        ],
      }),
    ],
  },
]);
const HISTORICAL = folderStatus([
  {
    signIn: signIn("browser", 3, "Safari on macOS"),
    current: false,
    copies: [
      copy(4, { age_seconds: 9_000_000, received_at: before(100 * DAY) }),
    ],
  },
]);
const MANY_SIGN_INS = folderStatus(
  [
    {
      signIn: signIn("app", 1, "Notes for Mac"),
      current: true,
      copies: [copy(5), copy(6, { pending_uploads: 2 })],
    },
    {
      signIn: signIn("key", 2, "backup-script"),
      current: true,
      copies: [copy(7, { problems: [{ code: "conflict", count: 1 }] })],
    },
    {
      signIn: signIn("browser", 3, "Safari on macOS"),
      current: false,
      copies: [
        copy(8, { received_at: before(100 * DAY), age_seconds: 8_640_000 }),
      ],
    },
  ],
  true,
);
const NO_REPORTS = folderStatus([]);

const FOLDER_NAMES = [
  "Household",
  "Photos to sort",
  "Recipes",
  "Work notes",
  "Garden plans",
  "Receipts",
  "Travel",
  "School",
  "Music notes",
  "Archive",
];
const BUSY_FOLDERS: FolderReading[] = FOLDER_NAMES.map((title, i) =>
  reading_(
    10 + i,
    title,
    [QUIET, WAITING, NEEDS_LOOK, NO_REPORTS, HISTORICAL][i % 5] ?? null,
  ),
);

const folderSiblings = BUSY_FOLDERS.slice(0, 4).map((row) => ({
  title: row.folder.title,
  href: folderHref(row.folder.id),
}));

// ---------------------------------------------------------------------------
// Console: activity, health, export, settings, general, account
// ---------------------------------------------------------------------------

const ACTORS = [
  { kind: "browser" as const, id: uid(7001), name: "Safari on macOS" },
  { kind: "key" as const, id: uid(2001), name: "backup-script" },
  { kind: "app" as const, id: uid(3001), name: "Notes for Mac" },
  { kind: "server" as const, id: "server" as const, name: "Marfa" as const },
];

const ACTIONS: [string, string][] = [
  ["key.create", "key"],
  ["item.create", "item"],
  ["item.update", "item"],
  ["config.update", "config"],
  ["items.trash_purged", "item"],
  ["owner.sign_in", "owner"],
];

function auditEntry(n: number): AuditEntry {
  const [action, resourceType] = ACTIONS[n % ACTIONS.length] ??
    ACTIONS[0] ?? ["key.create", "key"];
  const actor = action === "items.trash_purged" ? ACTORS[3] : ACTORS[n % 3];
  return {
    actor: actor ?? null,
    id: uid(7100 + n),
    created_at: before((n * 3 + 1) * HOUR),
    key_id: null,
    action,
    resource_type: resourceType,
    resource_id: action === "config.update" ? null : uid(8000 + n),
    client_ip: actor?.kind === "server" ? null : "203.0.113.7",
    details: {},
  };
}

const activityRows = (count: number) =>
  Array.from({ length: count }, (_, i) => {
    const entry = auditEntry(i);
    return { entry, ago: happenedWords(Date.parse(entry.created_at), NOW) };
  });

const activityBase = {
  ...PAGE,
  generalHref: "/auth/owner/general",
  retentionDays: 90 as number | undefined,
};

const OK = { status: "ok" as const };
const COMPONENTS_OK = {
  database: OK,
  database_write: OK,
  disk: OK,
  blob_storage: OK,
};

const job = (
  name: string,
  over: Partial<HousekeepingRow> = {},
): HousekeepingRow => ({
  name,
  interval_ms: 3_600_000,
  next_run_at: before(-HOUR),
  running_since: null,
  last_started_at: before(50 * 60_000),
  last_finished_at: before(49 * 60_000),
  last_outcome: "ok",
  last_error: null,
  last_result: null,
  ...over,
});

const JOB_NAMES = Object.keys(HOUSEKEEPING_JOBS);
const HEALTHY_JOBS = [
  job(JOB_NAMES[0] ?? "audit-cleanup"),
  job(JOB_NAMES[1] ?? "audit-cleanup"),
  job(JOB_NAMES[2] ?? "trash-purge", {
    running_since: before(20_000),
    last_finished_at: null,
    last_outcome: null,
  }),
  job(JOB_NAMES[3] ?? "trash-purge", {
    last_started_at: null,
    last_finished_at: null,
    last_outcome: null,
  }),
];
const FAILING_JOBS = [
  job(JOB_NAMES[0] ?? "audit-cleanup", {
    last_outcome: "error",
    last_error: "The database was busy for too long.",
  }),
  ...HEALTHY_JOBS.slice(1),
];

const config = loadConfig({});
const SETTINGS_ENTRIES: SettingEntry[] = readSettings(
  describeSettings(),
  Object.fromEntries(
    describeSettings().flatMap((setting) =>
      setting.default === undefined ? [] : [[setting.name, setting.default]],
    ),
  ),
  // Only whether a setting is stated is read, so a secret shows as set
  // without any value of it existing.
  { MARFA_AUTH_BASE_URL: BASE_URL, PORT: "8600", API_KEY_SALT: "stated" },
).map(({ live, ...entry }) => ({ ...entry, live: live !== undefined }));

function settingGroups() {
  const names = [...new Set(SETTINGS_ENTRIES.map((entry) => entry.group))];
  return names.map((group) => ({
    group,
    entries: SETTINGS_ENTRIES.filter((entry) => entry.group === group),
  }));
}

const settingsBase = { ...PAGE, generalHref: "/auth/owner/general" };

function settingsGroup(group: SettingEntry["group"]): string {
  const groups = settingGroups();
  const held = groups.find((candidate) => candidate.group === group);
  return renderSettingsGroupPage({
    ...settingsBase,
    group,
    entries: held?.entries ?? [],
    groups,
  });
}

const CHANGED: InstanceConfig = {
  name: INSTANCE,
  trash_retention_days: 45,
  audit_retention_days: 0,
  enrichment_enabled: false,
  enforcement: { strict_mode: { types: ["core.note", "core.task"] } },
};

const general = (
  stored: InstanceConfig | null,
  instanceName = INSTANCE,
): string =>
  renderGeneralPage({
    nonce: NONCE,
    instanceName,
    keeping: keepingRows(config, stored),
    live: liveRows(config, stored),
    rules: ruleRows(stored),
    about: { address: ADDRESS, version: versionWords(config) },
  });

const exportTypes = (added: boolean): (SelectOption | SelectGroup)[] => [
  { value: "", label: "Everything" },
  {
    label: "Built in",
    options: ["core.note", "core.task", "core.bookmark", "core.event"].map(
      (id) => ({
        value: id,
        label: schemaOf(id).label ?? id,
      }),
    ),
  },
  ...(added
    ? [
        {
          label: "Added by apps and you",
          options: [{ value: "user.recipe", label: "Recipe" }],
        },
      ]
    : []),
];

const passkey = (n: number, name: string | null) => ({
  id: uid(9000 + n),
  name,
  added: new Date(NOW - (5 + 9 * n) * DAY),
});

const passwordBase = {
  ...PAGE,
  suggestedName: "Passkey on macOS",
  addressProblem: false,
};

const profileOwner = { ...OWNER, avatar: null as string | null };

// ---------------------------------------------------------------------------
// Console
// ---------------------------------------------------------------------------

const CONSOLE: GalleryTab = {
  id: "console",
  label: "Console",
  screens: [
    screen("home", "Home", [
      variant("new", "New Marfa", () => home({ reading: NEW_HOME })),
      variant("busy", "In use", () => home({ reading: BUSY_HOME })),
      variant("attention", "Needs attention", () =>
        home({ reading: TROUBLED_HOME }),
      ),
      variant("search", "Search with results", () =>
        home({ reading: BUSY_HOME, query: "keys" }),
      ),
      variant("search-setting", "Search finds a setting", () =>
        home({ reading: BUSY_HOME, query: "trash" }),
      ),
      variant("search-none", "Search finds nothing", () =>
        home({ reading: BUSY_HOME, query: "zzzz" }),
      ),
      variant("long", "Long unbroken name", () =>
        home({
          reading: BUSY_HOME,
          instanceName: LONG_NAME,
          address: LONG_NAME,
        }),
      ),
    ]),
    screen("items", "Items", [
      variant("new", "New: no items", () =>
        renderItemsPage({
          ...itemsBase,
          types: NEW_TYPES,
          total: 0,
          files: "5 types, no files yet",
          view: {},
          groups: [],
        }),
      ),
      variant("overview", "Several types", () =>
        renderItemsPage({
          ...itemsBase,
          types: BUSY_TYPES,
          total: totalOf(BUSY_TYPES),
          view: {},
          groups: BUSY_TYPES.filter((type) => type.count > 0).map((type) => ({
            type,
            rows: itemRows(
              type.schema.id,
              3,
              type.schema.id === "user.recipe"
                ? ["Slow-cooked lamb", "Lemon traybake", "Weeknight dal"]
                : NOTE_NAMES,
            ),
          })),
        }),
      ),
      variant("one-type", "One type, busy: 412 notes", () =>
        renderItemsPage({
          ...itemsBase,
          types: BUSY_TYPES,
          total: totalOf(BUSY_TYPES),
          view: { type: "core.note" },
          groups: [],
          rows: itemRows("core.note", 10, NOTE_NAMES, 10),
          pagination: paginate(412, 2, 10),
        }),
      ),
      variant("type-empty", "A type with no items", () =>
        renderItemsPage({
          ...itemsBase,
          types: itemTypes({ ...BUSY_COUNTS, "core.event": 0 }),
          total: totalOf(BUSY_TYPES) - 31,
          view: { type: "core.event" },
          groups: [],
          rows: [],
          pagination: paginate(0, 1, 10),
        }),
      ),
      variant("search", "Search results", () =>
        renderItemsPage({
          ...itemsBase,
          types: BUSY_TYPES,
          total: totalOf(BUSY_TYPES),
          view: { query: "kitchen" },
          groups: [],
          rows: itemRows("core.note", 10),
          pagination: openPagination(1, 10, true),
        }),
      ),
      variant("search-none", "Search finds nothing", () =>
        renderItemsPage({
          ...itemsBase,
          types: BUSY_TYPES,
          total: totalOf(BUSY_TYPES),
          view: { query: "zzzz" },
          groups: [],
          rows: [],
          pagination: openPagination(1, 0, false),
        }),
      ),
      variant("long", "Long unbroken names", () =>
        renderItemsPage({
          ...itemsBase,
          types: BUSY_TYPES,
          total: totalOf(BUSY_TYPES),
          view: { type: "core.note" },
          groups: [],
          rows: itemRows("core.note", 3, [LONG_NAME]),
          pagination: paginate(3, 1, 10),
        }),
      ),
    ]),
    screen("type", "A type", [
      variant("built-in", "Built-in type", () =>
        renderTypePage({
          ...PAGE,
          types: BUSY_TYPES,
          schema: schemaOf("core.note"),
          provenance: { origin: "platform" },
          count: 412,
          trashed: 3,
          removable: false,
        }),
      ),
      variant("added", "Added by an app, can be removed", () =>
        renderTypePage({
          ...PAGE,
          types: itemTypes({ ...BUSY_COUNTS, "user.recipe": 0 }),
          schema: RECIPE_SCHEMA,
          provenance: {
            origin: "user",
            created_by: { kind: "app", id: uid(3001), name: "Notes for Mac" },
          },
          count: 0,
          trashed: 0,
          removable: true,
        }),
      ),
      variant("in-use", "Added by an app, still has items", () =>
        renderTypePage({
          ...PAGE,
          types: BUSY_TYPES,
          schema: RECIPE_SCHEMA,
          provenance: { origin: "user", created_by: null },
          count: 17,
          trashed: 2,
          removable: true,
          removalReason:
            "This type still has items, including items in the trash. Remove them before removing the type.",
        }),
      ),
      variant("missing", "Type is not there", () =>
        renderTypePage({ ...PAGE, types: BUSY_TYPES, count: 0, trashed: 0 }),
      ),
    ]),
    screen("trash", "Trash", [
      variant("empty", "Empty", () =>
        trash({ total: 0, rows: [], counts: {} }),
      ),
      variant("busy", "Busy: 24 items", () => trash({})),
      variant("one-type", "One type", () =>
        trash({
          type: "core.task",
          total: 24,
          pagination: paginate(6, 1, 10),
          rows: trashedRows(6),
        }),
      ),
      variant("search", "Search results", () =>
        trash({
          q: "notes",
          pagination: openPagination(1, 4, false),
          rows: trashedRows(4),
        }),
      ),
      variant("search-none", "Search finds nothing", () =>
        trash({ q: "zzzz", pagination: openPagination(1, 0, false), rows: [] }),
      ),
      variant("keep-forever", "Automatic deletion is off", () =>
        trash({
          days: 0,
          total: 6,
          pagination: paginate(6, 1, 10),
          rows: trashedRows(6),
        }),
      ),
      variant("long", "Long unbroken name", () =>
        trash({
          total: 1,
          pagination: paginate(1, 1, 10),
          rows: trashedRows(1).map((row) => ({ ...row, name: LONG_NAME })),
        }),
      ),
    ]),
    screen("keys", "API keys", [
      variant("none", "No keys yet", () =>
        renderKeyListPage({
          ...keyListBase,
          counts: { yours: 0, apps: 0 },
          rows: [],
          pagination: paginate(0, 1, 10),
        }),
      ),
      variant("few", "A few keys", () =>
        renderKeyListPage({
          ...keyListBase,
          counts: { yours: 3, apps: 2 },
          rows: yourKeys,
          pagination: paginate(3, 1, 10),
        }),
      ),
      variant("busy", "Busy: 24 keys", () =>
        renderKeyListPage({
          ...keyListBase,
          counts: { yours: 24, apps: 2 },
          rows: busyKeys,
          pagination: paginate(24, 1, 10),
        }),
      ),
      variant("apps", "Made by apps", () =>
        renderKeyListPage({
          ...keyListBase,
          tab: "apps",
          counts: { yours: 3, apps: 2 },
          rows: appKeys,
          pagination: paginate(2, 1, 10),
        }),
      ),
      variant("apps-none", "Made by apps: none", () =>
        renderKeyListPage({
          ...keyListBase,
          tab: "apps",
          counts: { yours: 3, apps: 0 },
          rows: [],
          pagination: paginate(0, 1, 10),
        }),
      ),
      variant("search-none", "Search finds nothing", () =>
        renderKeyListPage({
          ...keyListBase,
          query: "zzzz",
          counts: { yours: 3, apps: 2 },
          rows: [],
          pagination: paginate(0, 1, 10),
        }),
      ),
      variant("long", "Long unbroken name", () =>
        renderKeyListPage({
          ...keyListBase,
          counts: { yours: 1, apps: 0 },
          rows: [keyRow(30, LONG_NAME, KEY_READS, null, null)],
          pagination: paginate(1, 1, 10),
        }),
      ),
    ]),
    screen("create-key", "Create key", [
      variant("new", "New key", () =>
        renderCreateKeyPage({
          ...PAGE,
          access: buildAccess({
            scopes: scopesOf(CREATE_LITERALS),
            held: undefined,
            ...accessWords(CREATE_LITERALS),
            chooseTypes: CHOOSABLE_TYPES,
            bundles: getPermissionBundles(),
            start: "off",
          }),
        }),
      ),
    ]),
    screen("key", "A key", [
      variant("expiry", "Ends in two months", () => keyPage(BACKUP_KEY)),
      variant("never", "Never ends", () =>
        keyPage({ ...BACKUP_KEY, ends: null }),
      ),
      variant("soon", "Ends in three days", () =>
        keyPage({ ...BACKUP_KEY, ends: after(3 * DAY), lastUsed: null }),
      ),
      variant("app", "Made by an app", () =>
        keyPage({
          ...BACKUP_KEY,
          label: "inbox-sorter-sync",
          literals: ["core.note:read"],
          madeBy: { name: "Inbox Sorter", connected: true },
        }),
      ),
      variant("app-gone", "Made by an app that is no longer connected", () =>
        keyPage({
          ...BACKUP_KEY,
          label: "inbox-sorter-sync",
          literals: ["core.note:read"],
          madeBy: { name: "Inbox Sorter", connected: false },
        }),
      ),
      variant("denied", "Reads everything except one type", () =>
        keyPage({
          ...BACKUP_KEY,
          label: "home-dashboard",
          literals: ["*:read"],
          denied: {
            words: ["Bookmark"],
            keep: JSON.stringify({ type_permissions: ["core.bookmark"] }),
          },
        }),
      ),
      variant("no-access", "No access", () =>
        keyPage({
          ...BACKUP_KEY,
          label: "paused-key",
          literals: [],
          noAccess: true,
        }),
      ),
      variant("webhooks", "With webhooks", () =>
        keyPage({ ...BACKUP_KEY, webhooks: WEBHOOKS }),
      ),
      variant("webhooks-failed", "Webhooks could not be loaded", () =>
        keyPage({ ...BACKUP_KEY, webhooks: null }),
      ),
      variant("long", "Long unbroken name", () =>
        keyPage({ ...BACKUP_KEY, label: LONG_NAME }),
      ),
    ]),
    screen("gone-key", "Copy your key again", [
      variant("exists", "Key still exists", () =>
        renderGoneKeyPage({ ...PAGE, keyId: uid(2001) }),
      ),
      variant("revoked", "Key is gone", () => renderGoneKeyPage({ ...PAGE })),
    ]),
    screen("missing-key", "Key not found", [
      variant("missing", "Key not found", () => renderMissingKeyPage(PAGE)),
    ]),
    screen("apps", "Connected apps", [
      variant("none", "None connected", () =>
        renderAppListPage({
          ...PAGE,
          kind: "all",
          query: "",
          total: 0,
          rows: [],
          pagination: paginate(0, 1, 10),
        }),
      ),
      variant("few", "A few apps", () =>
        renderAppListPage({
          ...PAGE,
          kind: "all",
          query: "",
          total: 4,
          rows: APPS,
          pagination: paginate(4, 1, 10),
        }),
      ),
      variant("busy", "Busy: 24 apps", () =>
        renderAppListPage({
          ...PAGE,
          kind: "all",
          query: "",
          total: 24,
          rows: BUSY_APPS,
          pagination: paginate(24, 1, 10),
        }),
      ),
      variant("kind-none", "None of the kind chosen", () =>
        renderAppListPage({
          ...PAGE,
          kind: "cli",
          query: "",
          total: 3,
          rows: [],
          pagination: paginate(0, 1, 10),
        }),
      ),
      variant("search-none", "Search finds nothing", () =>
        renderAppListPage({
          ...PAGE,
          kind: "all",
          query: "zzzz",
          total: 4,
          rows: [],
          pagination: paginate(0, 1, 10),
        }),
      ),
      variant("long", "Long unbroken name", () =>
        renderAppListPage({
          ...PAGE,
          kind: "all",
          query: "",
          total: 1,
          rows: [appRow(40, LONG_NAME, "App", KEY_READS, null)],
          pagination: paginate(1, 1, 10),
        }),
      ),
    ]),
    screen("app", "A connected app", [
      variant("keys", "App that made keys", () => appPage(NOTES_APP)),
      variant("no-keys", "App that made no keys", () =>
        appPage({
          ...NOTES_APP,
          name: "Inbox Sorter",
          id: uid(3002),
          keys: [],
        }),
      ),
      variant("broad", "Asks for a lot", () =>
        appPage({
          ...NOTES_APP,
          name: "Marfa command line",
          id: uid(3004),
          details: appDetails("Command line", NOW - 20 * 60_000),
          scopes: A_LOT.filter(
            (literal) => literal !== "openid" && literal !== "offline_access",
          ),
          keys: [],
        }),
      ),
      variant("web", "Web page", () =>
        appPage({
          ...NOTES_APP,
          name: "Reader for web",
          id: uid(3003),
          details: appDetails("Web page", null, "reader.example.com"),
          scopes: ["core.bookmark:read"],
          keys: [],
        }),
      ),
      variant("no-access", "No access left", () =>
        appPage({
          ...NOTES_APP,
          name: "Inbox Sorter",
          id: uid(3002),
          scopes: [],
          keys: [],
        }),
      ),
      variant("webhooks", "With webhooks", () => appPage(NOTES_APP, WEBHOOKS)),
      variant("long", "Long unbroken name", () =>
        appPage({ ...NOTES_APP, name: LONG_NAME }),
      ),
    ]),
    screen("missing-app", "App not found", [
      variant("missing", "App not found", () => renderMissingAppPage(PAGE)),
    ]),
    screen("connectors", "Connectors", [
      variant("none", "No connectors", () =>
        renderConnectorListPage({
          ...PAGE,
          rows: [],
          pagination: paginate(0, 1, 10),
        }),
      ),
      variant("mixed", "Several states", () =>
        renderConnectorListPage({
          ...PAGE,
          rows: CONNECTORS,
          pagination: paginate(4, 1, 10),
        }),
      ),
      variant("busy", "Busy: 24 connectors", () =>
        renderConnectorListPage({
          ...PAGE,
          rows: BUSY_CONNECTORS,
          pagination: paginate(24, 1, 10),
        }),
      ),
      variant("long", "Long unbroken name", () =>
        renderConnectorListPage({
          ...PAGE,
          rows: [
            connectorRow(
              50,
              LONG_NAME,
              "Brings in data",
              "No runs yet",
              "Running",
            ),
          ],
          pagination: paginate(1, 1, 10),
        }),
      ),
    ]),
    screen("connector", "A connector", [
      variant("running", "Running", () => connectorBase({})),
      variant("failing", "Last run failed", () =>
        connectorBase({
          id: uid(3102),
          name: "Inbox Sorter",
          notice: {
            tone: "error",
            title: "The last run failed",
            description: "The mail server refused the sign-in.",
          },
          runs: [
            {
              title: "5 hours ago",
              value: "Failed",
              failed: true,
              description: "The mail server refused the sign-in.",
            },
            { title: "Yesterday", value: "Succeeded", failed: false },
          ],
        }),
      ),
      variant("problems", "Reported problems", () =>
        connectorBase({
          id: uid(3103),
          name: "Reading list",
          notice: { tone: "info", title: "The connector reported problems" },
          problems: [
            {
              title: "Two feeds are unreachable",
              description: "The addresses no longer answer.",
            },
            {
              title: "Rate limited",
              description: "The service asked it to slow down.",
            },
          ],
        }),
      ),
      variant("silent", "Not heard from", () =>
        connectorBase({
          id: uid(3104),
          name: "Photo importer",
          notice: {
            tone: "info",
            title: "Nothing heard for 3 days",
            description:
              "Check that the program is still running on its machine.",
          },
        }),
      ),
      variant("new", "New: no runs, key gone", () =>
        connectorBase({
          description: null,
          details: [
            { title: "Source", value: "calendar-sync" },
            { title: "Registered", value: "Just now" },
            { title: "Last heartbeat", value: "Never" },
            { title: "Key it uses", value: "A key that is gone" },
          ],
          runs: [],
        }),
      ),
      variant("long", "Long unbroken name", () =>
        connectorBase({ name: LONG_NAME, description: LONG_NAME }),
      ),
    ]),
    screen("missing-connector", "Connector not found", [
      variant("missing", "Connector not found", () =>
        renderMissingConnectorPage(PAGE),
      ),
    ]),
    screen("folders", "Folders", [
      variant("none", "No folders", () =>
        renderFolderList({
          ...folderBase,
          rows: [],
          next: null,
          continued: false,
          size: 10,
        }),
      ),
      variant("several", "Several folders", () =>
        renderFolderList({
          ...folderBase,
          rows: BUSY_FOLDERS.slice(0, 5),
          next: null,
          continued: false,
          size: 10,
        }),
      ),
      variant("busy", "Busy: first page of 25", () =>
        renderFolderList({
          ...folderBase,
          rows: BUSY_FOLDERS,
          next: "next-page",
          continued: false,
          size: 10,
        }),
      ),
      variant("later", "A later page", () =>
        renderFolderList({
          ...folderBase,
          rows: BUSY_FOLDERS.slice(0, 4),
          next: null,
          continued: true,
          size: 10,
        }),
      ),
      variant("past-end", "Past the last page", () =>
        renderFolderList({
          ...folderBase,
          rows: [],
          next: null,
          continued: true,
          size: 10,
        }),
      ),
      variant("unreadable", "Reports could not be read", () =>
        renderFolderList({
          ...folderBase,
          rows: [reading_(60, "Household", null)],
          next: null,
          continued: false,
          size: 10,
        }),
      ),
      variant("long", "Long unbroken name", () =>
        renderFolderList({
          ...folderBase,
          rows: [reading_(61, LONG_NAME, QUIET)],
          next: null,
          continued: false,
          size: 10,
        }),
      ),
    ]),
    screen("folder", "A folder", [
      variant("quiet", "No problems reported", () =>
        renderFolderDetail({
          ...folderBase,
          ...reading_(1, "Household", QUIET),
          siblings: folderSiblings,
        }),
      ),
      variant("waiting", "Work waiting", () =>
        renderFolderDetail({
          ...folderBase,
          ...reading_(2, "Photos to sort", WAITING),
          siblings: folderSiblings,
        }),
      ),
      variant("needs-look", "Every kind of problem", () =>
        renderFolderDetail({
          ...folderBase,
          ...reading_(3, "Work notes", NEEDS_LOOK),
          siblings: folderSiblings,
        }),
      ),
      variant("many", "Several sign-ins, one historical", () =>
        renderFolderDetail({
          ...folderBase,
          ...reading_(4, "Recipes", MANY_SIGN_INS),
          siblings: folderSiblings,
        }),
      ),
      variant("historical", "Historical reports only", () =>
        renderFolderDetail({
          ...folderBase,
          ...reading_(5, "Archive", HISTORICAL),
          siblings: folderSiblings,
        }),
      ),
      variant("no-reports", "No reports yet", () =>
        renderFolderDetail({
          ...folderBase,
          ...reading_(6, "Travel", NO_REPORTS),
          siblings: folderSiblings,
        }),
      ),
      variant("unreadable", "Reports could not be read", () =>
        renderFolderDetail({
          ...folderBase,
          ...reading_(7, "School", null),
          siblings: folderSiblings,
        }),
      ),
      variant("long", "Long unbroken name", () =>
        renderFolderDetail({
          ...folderBase,
          ...reading_(8, LONG_NAME, QUIET),
          siblings: folderSiblings,
        }),
      ),
    ]),
    screen("missing-folder", "Folder not found", [
      variant("missing", "Folder not found", () =>
        renderMissingFolder(folderBase),
      ),
    ]),
    screen("browsers", "Browsers", [
      variant("this-one", "Only this browser", () =>
        renderBrowsersPage({
          ...PAGE,
          rows: [
            {
              id: uid(7001),
              name: "Safari on macOS",
              current: true,
              description: "At 203.0.113.7. Signed in today.",
              value: "Used just now",
            },
          ],
        }),
      ),
      variant("several", "Several browsers", () =>
        renderBrowsersPage({
          ...PAGE,
          rows: [
            {
              id: uid(7001),
              name: "Safari on macOS",
              current: true,
              description: "At 203.0.113.7. Signed in today.",
              value: "Used just now",
            },
            {
              id: uid(7002),
              name: "Chrome on Windows",
              current: false,
              description: "At 198.51.100.24. Signed in 4 days ago.",
              value: "Used 2 hours ago",
            },
            {
              id: uid(7003),
              name: "Firefox on Linux",
              current: false,
              description: "Signed in October 3.",
              value: "Used 6 days ago",
            },
          ],
        }),
      ),
      variant("none", "No browser is signed in", () =>
        renderBrowsersPage({ ...PAGE, rows: [] }),
      ),
      variant("long", "Long unbroken name", () =>
        renderBrowsersPage({
          ...PAGE,
          rows: [
            {
              id: uid(7001),
              name: "Safari on macOS",
              current: true,
              description: "Signed in today.",
              value: "Used just now",
            },
            {
              id: uid(7002),
              name: LONG_NAME,
              current: false,
              description: LONG_NAME,
              value: "Used 2 hours ago",
            },
          ],
        }),
      ),
    ]),
    screen("activity", "Activity", [
      variant("none", "No activity yet", () =>
        renderActivityPage({
          ...activityBase,
          view: {},
          rows: [],
          pagination: openPagination(1, 0, false),
        }),
      ),
      variant("busy", "Busy: a full page and more", () =>
        renderActivityPage({
          ...activityBase,
          view: {},
          rows: activityRows(10),
          pagination: openPagination(1, 10, true),
        }),
      ),
      variant("last-page", "Last page", () =>
        renderActivityPage({
          ...activityBase,
          view: { page: 3 },
          rows: activityRows(4),
          pagination: openPagination(3, 4, false),
        }),
      ),
      variant("filtered", "Filtered", () =>
        renderActivityPage({
          ...activityBase,
          view: { kind: "access", when: "week" },
          rows: activityRows(5),
          pagination: openPagination(1, 5, false),
        }),
      ),
      variant("filtered-none", "Filtered, nothing matches", () =>
        renderActivityPage({
          ...activityBase,
          view: { kind: "settings", when: "day", query: "zzzz" },
          rows: [],
          pagination: openPagination(1, 0, false),
        }),
      ),
      variant("forever", "Activity kept forever", () =>
        renderActivityPage({
          ...activityBase,
          retentionDays: 0,
          view: {},
          rows: activityRows(3),
          pagination: openPagination(1, 3, false),
        }),
      ),
    ]),
    screen("health", "Health", [
      variant("working", "Everything working", () =>
        renderHealthPage({
          ...PAGE,
          now: nowRows(COMPONENTS_OK, OK),
          jobs: jobRows(HEALTHY_JOBS, NOW),
        }),
      ),
      variant("trouble", "Slow, full and failing", () =>
        renderHealthPage({
          ...PAGE,
          now: nowRows(
            {
              ...COMPONENTS_OK,
              database: { status: "degraded" },
              disk: { status: "down" },
              blob_storage: { status: "degraded" },
            },
            { status: "down" },
          ),
          jobs: jobRows(FAILING_JOBS, NOW),
        }),
      ),
      variant("jobs-unreadable", "Jobs could not be read", () =>
        renderHealthPage({
          ...PAGE,
          now: nowRows(COMPONENTS_OK, null),
          jobs: null,
        }),
      ),
    ]),
    screen("export", "Export and restore", [
      variant("files", "With files and added types", () =>
        renderExportPage({
          ...PAGE,
          types: exportTypes(true),
          files: "37 files, 14.2 MB",
          signInLeft: 240_000,
        }),
      ),
      variant("no-files", "No files, built-in types only", () =>
        renderExportPage({
          ...PAGE,
          types: exportTypes(false),
          files: "No files",
        }),
      ),
    ]),
    screen("settings", "All settings", [
      variant("index", "Every group", () =>
        renderSettingsIndexPage({
          ...settingsBase,
          query: "",
          groups: settingGroups(),
          matches: [],
        }),
      ),
      variant("search", "Search with matches", () =>
        renderSettingsIndexPage({
          ...settingsBase,
          query: "trash",
          groups: settingGroups(),
          matches: SETTINGS_ENTRIES.filter((entry) =>
            /trash/i.test(`${entry.label} ${entry.name}`),
          ),
        }),
      ),
      variant("search-none", "Search finds nothing", () =>
        renderSettingsIndexPage({
          ...settingsBase,
          query: "zzzz",
          groups: settingGroups(),
          matches: [],
        }),
      ),
    ]),
    screen("settings-group", "A settings group", [
      variant("address", "Address and network", () =>
        settingsGroup("Address and network"),
      ),
      variant("secrets", "Sign-in and access: secrets", () =>
        settingsGroup("Sign-in and access"),
      ),
      variant("live", "Keeping things: changeable in General", () =>
        settingsGroup("Keeping things"),
      ),
      variant("missing", "Group not found", () =>
        renderSettingsMissingPage(settingsBase),
      ),
    ]),
    screen("general", "General", [
      variant("standing", "Standard values", () => general(null)),
      variant("changed", "Changed values", () => general(CHANGED)),
      variant("long", "Long unbroken name", () =>
        general({ ...CHANGED, name: LONG_NAME }, LONG_NAME),
      ),
    ]),
    screen("profile", "Profile", [
      variant("new", "Name and email, no picture", () =>
        renderProfilePage({ ...PAGE, owner: profileOwner }),
      ),
      variant("picture", "With a picture address", () =>
        renderProfilePage({
          ...PAGE,
          owner: { ...OWNER, avatar: "https://images.example.com/jonah.png" },
        }),
      ),
      variant("long", "Long unbroken name and email", () =>
        renderProfilePage({
          ...PAGE,
          owner: {
            name: LONG_NAME,
            email: `${LONG_NAME}@example.com`,
            avatar: `https://images.example.com/${LONG_NAME}.png`,
          },
        }),
      ),
    ]),
    screen("password", "Password and passkeys", [
      variant("none", "No passkeys yet", () =>
        renderPasswordPage({ ...passwordBase, passkeys: [] }),
      ),
      variant("some", "Two passkeys, one unnamed", () =>
        renderPasswordPage({
          ...passwordBase,
          passkeys: [passkey(1, "Passkey on macOS"), passkey(2, null)],
        }),
      ),
      variant("address", "Passkeys cannot work at this address", () =>
        renderPasswordPage({
          ...passwordBase,
          passkeys: [],
          addressProblem: true,
        }),
      ),
      variant("long", "Long unbroken name", () =>
        renderPasswordPage({
          ...passwordBase,
          passkeys: [passkey(3, LONG_NAME)],
        }),
      ),
    ]),
  ],
};

export const TABS: GalleryTab[] = [GETTING_IN, CONSOLE];

export function resolveVariant(
  tabId: string,
  screenId: string,
  variantId: string,
):
  | { tab: GalleryTab; screen: GalleryScreen; variant: GalleryVariant }
  | undefined {
  const tab = TABS.find((candidate) => candidate.id === tabId);
  const found = tab?.screens.find((candidate) => candidate.id === screenId);
  if (tab === undefined || found === undefined) return undefined;
  const chosen = [...found.variants, ...(found.designVariants ?? [])].find(
    (candidate) => candidate.id === variantId,
  );
  return chosen === undefined
    ? undefined
    : { tab, screen: found, variant: chosen };
}
