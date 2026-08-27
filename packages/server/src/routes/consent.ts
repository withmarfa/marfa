/**
 * OAuth consent screen renderer.
 *
 * The shared `/auth/static/auth.css` design tokens style the screen, unifying
 * it with sign-in / sign-up / device-flow.
 *
 * Layout: the requested scopes are grouped by capability into collapsible
 * soft-tile groups — "Read your content", "Write your content", "Your
 * profile". Every group is collapsed by default; expanding one reveals a
 * per-type toggle (Notes, Tasks, Calendar, …). Each toggle is a real
 * `name="scopes"` checkbox carrying the concrete scope literal, so the no-JS
 * path still submits the ticked set and the issued token narrows to
 * exactly what the user keeps on. A group's master toggle drives its members
 * (JS enhancement); members reflect back onto the master (indeterminate when
 * partially ticked).
 *
 * A group starts ticked or unticked according to its bundle's `default_on`.
 * An off-by-default bundle renders offered but not granted: leaving it alone
 * grants nothing from it, and ticking it is the act that grants exactly its
 * scopes. That is what makes a bundle expressible whose contents a person
 * should have to reach for, and it is also how an app already registered for
 * a scope set can be offered something new without every client having to
 * re-register.
 *
 * **`default_on` governs the first offer only.** The re-consent diff's
 * "Already allowed" section renders from the prior grant and ignores the
 * flag, because a scope the user granted last time is being shown rather
 * than offered. Rendering one unticked there would put the choice inside a
 * collapsed tile the reader never opens, and the decision route reads the
 * resulting submission as a narrowing, which revokes the client's live
 * tokens. An untouched Continue would kill a working integration.
 *
 * **This screen is one of two, and the other cannot express the flag.** The
 * device-approval screen confirms a scope list with no per-scope toggle, so
 * a tick is not available to it. Rather than granting on one click what the
 * flag exists to withhold, device-flow initiation refuses a scope that only
 * an off-by-default bundle offers.
 *
 * Per-type narrowing works because the requested scopes are concrete (see
 * `DEFAULT_PERMISSION_BUNDLES`): the OAuth provider only accepts a consent
 * grant whose scopes are a subset of what was literally requested, so ticking
 * a subset of concrete scopes both passes that check and narrows the token.
 *
 * Re-consent diff: when the caller passes `priorScopes` (the scope set the
 * user previously approved on this client), the screen renders three labelled
 * sections — "New", "Already allowed", and "No longer needed" — instead of the
 * first-time grouping. First-time consent (no prior grant) renders the plain
 * three-group shape.
 *
 * Authorization flow: the @better-auth/oauth-provider plugin signs the full
 * authorize-request query string and redirects here carrying that signed blob.
 * The form POSTs back to `/auth/authorize/decision` with `{ accept, scopes[],
 * oauth_query }` — the decision route validates the ticked scopes are a subset
 * of the signed set, projects the grant, then proxies to the plugin's
 * `/oauth2/consent`.
 */

import type { ParsedScope, PermissionBundle } from "@withmarfa/shared";
import {
  GLOBAL_TYPE_WILDCARD,
  HIDDEN_MECHANISM_SCOPES,
  scopesOfferedOffByDefaultOnly,
  scopesToMetadataPermissions,
  subtreeWildcardRoot,
} from "@withmarfa/shared";
import { getPermissionBundles } from "../config.js";
import { CAPABILITY_LABELS, capabilityShort } from "./capability-labels.js";
import { oidcLabel, oidcShort } from "./oidc-labels.js";
import { renderAuthLayout } from "./auth-layout.js";
import { computeConsentDiff } from "./consent-diff.js";
import { escapeHtml } from "./auth-html.js";

interface ConsentParams {
  clientName: string;
  /**
   * When `true`, the client has no verified identity — a public / DCR client
   * (PKCE, `token_endpoint_auth_method: none`). The screen shows a single
   * boxed caution next to the self-asserted name; a scammer can register a
   * client named "Google Drive", so the name alone is not trustworthy.
   */
  unverified?: boolean;
  scopes: ParsedScope[];
  clientId: string;
  /**
   * The full signed query string the plugin's authorize endpoint forwarded.
   * Threaded into a hidden field and POSTed back to the decision route so the
   * plugin can verify the signature and re-hydrate the request parameters.
   */
  oauthQuery: string;
  /**
   * Plain-English description per scope, keyed by `typePattern`. Used as a
   * label fallback for scopes outside the curated label map.
   */
  descriptions?: Record<string, string>;
  /**
   * The literal scope set the user previously approved on this client. When
   * present the screen renders the re-consent diff; when absent it renders the
   * first-time three-group shape.
   */
  priorScopes?: readonly string[];
  /**
   * For wildcard scopes, the display names of the types the pattern matches
   * in this space today, keyed by type pattern (e.g. `user.*` → the space's
   * custom types). Informative only: the checkbox still carries the wildcard
   * literal, and the copy states that later-defined types are covered too.
   */
  wildcardExpansions?: Record<string, string[]>;
  /**
   * When set, renders an inline error banner above the form (e.g. a
   * zero-scopes accept bounced back as "tick at least one permission").
   */
  errorMessage?: string;
  /**
   * The bundle set to group scopes under. The consent route passes the
   * consenting space's own derivation here (its runtime custom-namespace
   * roots folded in), so a space's registered types group under the custom
   * tile rather than the fallback buckets. Absent, the instance-wide
   * active bundles apply — correct for keys mode and for callers with no
   * space to scope to.
   */
  bundles?: PermissionBundle[];
}

/** A rendered soft-tile group: a bundle's scopes, or a fallback bucket for
 *  scopes outside every bundle. */
interface ScopeGroup {
  label: string;
  desc: string;
  scopes: ParsedScope[];
  /**
   * Whether the group's toggles start ticked, from the owning bundle's
   * `default_on`.
   *
   * An off-by-default bundle is the shape a bundle needs when it carries
   * something a person should have to reach for rather than merely leave
   * alone, and it is also what lets an already-registered client be offered
   * something new without every client having to re-register to get it.
   *
   * Read only where a scope is being offered. The re-consent diff sets it
   * `true` for scopes the user has already granted, since the question the
   * flag answers does not arise a second time.
   */
  defaultOn: boolean;
}

/**
 * Partition scopes into groups derived from the configured permission
 * bundles — the same definitions the discovery document advertises, so
 * the screen and the advertisement cannot drift. A scope belongs to the
 * first bundle whose `scopes` list carries its literal; scopes outside
 * every bundle (an app's custom request) fall back to read/write
 * buckets so nothing renders ungrouped.
 */
function buildGroups(
  scopes: ParsedScope[],
  bundles: PermissionBundle[],
): ScopeGroup[] {
  // A scope may appear in more than one bundle, and the two readers of that
  // overlap have to resolve it the same way or the same configuration means
  // different things on different surfaces.
  //
  // `scopesOfferedOffByDefaultOnly` withholds a scope only when no
  // on-by-default bundle REACHES it, so first-bundle-wins on its own would
  // render a scope in one on- and one off-by-default bundle unticked here,
  // if the off one happened to be listed first, while the device flow reads
  // the same pair as on-by-default and grants it in one click. An ordinary
  // operator config mistake reaches this, so the tie-break is explicit: an
  // on-by-default bundle claims a scope ahead of an off-by-default one, and
  // first-listed breaks the tie within each half.
  //
  // The second half of that tie-break asks the withholding function itself
  // rather than re-deriving its answer. Reaching is not naming: an
  // on-by-default bundle offering `core.*:write` gives the user
  // `core.task:write` already, so an off-by-default bundle naming that
  // literal withholds nothing, and letting it claim the scope here would
  // untick something the device flow grants. Re-deriving coverage instead
  // would put a second answer to one question back in the code, which is the
  // shape of the defect rather than the fix. A literal an off-by-default
  // bundle cannot withhold therefore stays unclaimed and lands in a fallback
  // bucket, ticked: no bundle heading on this screen is true of it, and
  // inventing one would be worse than the plainer label.
  const withheld = scopesOfferedOffByDefaultOnly(bundles);
  const literalToBundle = new Map<string, PermissionBundle>();
  for (const bundle of bundles) {
    if (!bundle.default_on) continue;
    for (const literal of bundle.scopes) {
      if (!literalToBundle.has(literal)) literalToBundle.set(literal, bundle);
    }
  }
  for (const bundle of bundles) {
    for (const literal of bundle.scopes) {
      if (!bundle.default_on && !withheld.has(literal)) continue;
      if (!literalToBundle.has(literal)) literalToBundle.set(literal, bundle);
    }
  }
  const byBundle = new Map<string, ScopeGroup>();
  for (const bundle of bundles) {
    byBundle.set(bundle.id, {
      label: bundle.label,
      desc: bundle.description,
      scopes: [],
      defaultOn: bundle.default_on,
    });
  }
  // The fallback buckets stay ticked. They hold what an app named explicitly
  // and no bundle claims, so there is no declaration to honor: `default_on`
  // is a property of a bundle, and unticking a scope no bundle describes
  // would be this screen inventing a policy rather than rendering one.
  const otherRead: ScopeGroup = {
    label: "Other read access",
    desc: "Additional things this app asked to read.",
    scopes: [],
    defaultOn: true,
  };
  const otherWrite: ScopeGroup = {
    label: "Other write access",
    desc: "Additional things this app asked to change.",
    scopes: [],
    defaultOn: true,
  };
  // A capability needs a bucket of its own, and the reason is the heading
  // rather than the tidiness. The read/write split is decided on
  // `operation`, which a capability sets to `"none"`, so without this arm
  // every one of them fell through to the read bucket and a grant to
  // register webhooks or revoke keys was filed under "Additional things this
  // app asked to read". A heading that states the opposite of what the
  // toggle does is worse than no heading.
  //
  // Unticked, and this is the one bucket where that is right. The other two
  // start ticked because a scope the app asked for and no bundle claimed is
  // still ordinary access to content, and unticking it by default would have
  // this screen invent a policy. A capability is the opposite case: it is
  // authority the platform would otherwise let a token inherit from a role
  // without anybody naming it, and the whole reason it became a scope is so
  // somebody has to say yes. Arriving pre-ticked would grant it by silence,
  // which is what it exists to stop.
  const otherCapability: ScopeGroup = {
    label: "Administrative access",
    desc: "Parts of your space this app asked to manage.",
    scopes: [],
    defaultOn: false,
  };
  for (const scope of scopes) {
    const bundle = literalToBundle.get(scopeLiteralFor(scope));
    if (bundle) {
      byBundle.get(bundle.id)?.scopes.push(scope);
    } else if (scope.kind === "capability") {
      otherCapability.scopes.push(scope);
    } else if (scope.kind !== "oidc" && scope.operation === "write") {
      otherWrite.scopes.push(scope);
    } else {
      otherRead.scopes.push(scope);
    }
  }
  // Administrative access last: it is the widest thing on the screen, and a
  // reader scanning downward should not meet it between two content groups.
  return [...byBundle.values(), otherRead, otherWrite, otherCapability]
    .filter((g) => g.scopes.length > 0)
    .map((g) => ({ ...g, desc: summarize(g) }));
}

/**
 * Describe a group by what is in it.
 *
 * A consent screen's whole job is stating the size of a grant accurately,
 * and the groups are collapsed by default, so that sentence is what most
 * people read and act on. A fixed per-bundle description would give a
 * request for three scopes and a request for every type the same copy, "Your
 * notes, tasks, bookmarks, files, media, and more," and naming things the app
 * never asked for fails in both directions at once: a cautious person refuses
 * an app that wanted very little, and a trusting one learns the copy does not
 * track the request.
 *
 * A wildcard is the one case where "and more" is honest, because the grant
 * really does extend to types that do not exist yet.
 */
function summarize(group: ScopeGroup): string {
  const names: string[] = [];
  let openEnded = false;
  for (const scope of group.scopes) {
    if (scope.typePattern.includes("*")) openEnded = true;
    // Same chain the toggle list uses, humanized floor included. Stopping at
    // the curated map left an uncurated scope out of this sentence while the
    // list below still showed it, so the summary undercounted exactly the
    // scopes a reader is least likely to recognize. It is the same failure
    // this function's own docstring describes, from the other end.
    //
    // Capabilities and the profile scopes resolve through their inline-list
    // forms rather than their toggle labels. A toggle label sits alone above
    // a switch, so it is capitalized and free to carry a comma; joined into
    // a sentence, the capital lands mid-clause and the comma turns one item
    // into two. `CAPABILITY_SHORT` exists for precisely this and says so.
    const label =
      capabilityShort(scope.typePattern) ??
      oidcShort(scope.oidcScope ?? scope.typePattern) ??
      SCOPE_LABELS[scope.typePattern] ??
      (scope.kind === "oidc" ? undefined : humanizeType(scope.typePattern));
    if (label && !names.includes(label)) names.push(label);
  }
  if (names.length === 0) return group.desc;

  const listed = names.slice(0, 4);
  const remainder = names.length - listed.length;
  let list = listed.join(", ");
  if (listed.length > 1) {
    const last = listed[listed.length - 1] ?? "";
    list = `${listed.slice(0, -1).join(", ")} and ${last}`;
  }
  if (remainder > 0) list += `, and ${String(remainder)} more`;
  else if (openEnded) list += ", and anything else of that kind";

  // The labels are written for a toggle row, where each one starts a line of
  // its own and a capital is right. Joined into a sentence they carry that
  // capital into the middle of it, which read as "Your name and Your email
  // address". Only the labels that are phrases rather than category names
  // have a sentence form, so the fix is not a general lowercasing pass: a
  // brand keeps its capital wherever it lands, and "Notes, Tasks and Files"
  // is a list of names that reads correctly as it stands.
  return `${list.charAt(0).toUpperCase()}${list.slice(1)}.`;
}

/**
 * Short, human toggle labels keyed by type pattern. Curated for the types the
 * default grant requests; anything outside this map falls back to the scope's
 * registry description, then a humanized type name. A test pins every
 * default-bundle scope to an entry here, so widening a bundle without a
 * label fails the suite instead of shipping an auto-generated toggle.
 *
 * **A label may be shorter than its description. It may never be narrower
 * than its scope.** An entry here wins over the description, so it is the
 * whole of what this screen says about that grant, while the device screen
 * has no toggles and reads the description out in full. A label naming a
 * proper subset of what its pattern reaches therefore puts the smaller
 * answer on the screen where somebody is ticking boxes, and the direction is
 * what makes that a defect rather than a matter of taste: a grant that
 * overstates its reach makes a person hesitate, and a grant that understates
 * it makes them approve something larger than they think they are approving.
 *
 * `metadata` was "Type definitions" under that rule and is the worked
 * example. The bare root projects to `{ "*": verb }`, so it reaches every
 * metadata sub-resource, and its own list says it grows; the label named one
 * of the two that exist today.
 *
 * **The rule has a second half: a label may not name a type its scope does
 * not reach.** `core.entity` was "People and places", and a bare
 * `core.entity` grant is exact, so `grantCoversScope` answers false for
 * `core.entity.person` and false for `core.entity.place`. Both are
 * requestable on their own and carry their own rows, labeled "Contacts" and
 * "Places", so somebody ticking this one for their contacts granted nothing
 * of the kind, and the type it does reach went unnamed. The registry calls
 * `core.entity` a non-person entity and lists a company, a band, a team, a
 * charity, a brand and a school, so "Organizations" is what the grant
 * reaches. That half is asked of `grantCoversScope` rather than curated: a
 * label naming a descendant its own pattern does not cover fails the suite.
 *
 * **Open-endedness is the one thing a label here cannot carry**, and the
 * constraint is the sentence rather than the space above a switch.
 * {@link summarize} joins these into a list, so an entry holding a comma or
 * an "and" arrives there as two items: "Definitions in your space and any
 * added later" joined with "Edge types" reads as one unpunctuated run of
 * three. Saying that a grant reaches things which do not exist yet needs a
 * conjunction, so a label cannot say it and stay a name. {@link subRow}
 * states it on the row's second line instead, for every open-ended pattern
 * rather than for the ones somebody remembered, which is what keeps this
 * rule from needing a curator.
 */
export const SCOPE_LABELS: Record<string, string> = {
  "core.note": "Notes",
  "core.task": "Tasks",
  "core.bookmark": "Bookmarks",
  "core.highlight": "Highlights",
  "core.event": "Calendar",
  "core.message": "Messages",
  "core.entity": "Organizations",
  "core.entity.person": "Contacts",
  "core.entity.place": "Places",
  "core.file": "Files",
  "core.file.audio": "Audio files",
  "core.file.image": "Images",
  "core.file.video": "Videos",
  "core.media": "Media",
  "core.media.album": "Albums",
  "core.media.article": "Articles",
  "core.media.book": "Books",
  "core.media.episode": "Episodes",
  "core.media.film": "Films",
  "core.media.series": "Series",
  "core.media.song": "Songs",
  "google.calendar.event": "Google Calendar events",
  "google.contacts.contact": "Google Contacts",
  "google.drive.file": "Google Drive files",
  "google.tasks.task": "Google Tasks",
  "google.youtube.channel": "YouTube channels",
  "google.youtube.playlist": "YouTube playlists",
  "google.youtube.video": "YouTube videos",
  "marfa.captured_email": "Captured emails",
  "marfa.podcast.episode": "Podcast episodes",
  "marfa.podcast.show": "Podcast shows",
  "raindrop.collection": "Raindrop collections",
  "raindrop.raindrop": "Raindrop bookmarks",
  "readwise.book": "Readwise books",
  "readwise.document": "Readwise Reader documents",
  "readwise.highlight": "Readwise highlights",
  "todoist.task": "Todoist tasks",
  "user.*": "Your custom types",
  "system.connection": "Connected accounts",
  "system.integration": "Available integrations",
  "system.device": "Devices",
  "system.webhook": "Webhooks",
  "system.activity": "Activity",
  metadata: "Definitions in your space",
};

const CHEVRON = `<svg class="gchev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;

/**
 * The literal a parsed scope came from, which is what the checkbox has to
 * carry: the decision route validates the ticked set against the scopes the
 * plugin signed, so a reconstruction that differs by one character grants
 * nothing and reads as the user having unticked it.
 *
 * The verb-less families are named rather than defaulted. Appending
 * `:${operation}` to one produces `capability.webhooks:none`, a literal
 * nothing signed and no parser accepts, and the failure is silent all the
 * way to a token that is missing the permission the user just approved.
 */
function scopeLiteralFor(scope: ParsedScope): string {
  if (scope.kind === "oidc") return scope.oidcScope ?? scope.typePattern;
  if (scope.kind === "capability") return scope.capability ?? scope.typePattern;
  return `${scope.typePattern}:${scope.operation}`;
}

/** Title-case the most specific segment of a dotted type pattern, for scopes
 *  outside the curated label map (e.g. a third-party app's custom request). */
export function humanizeType(typePattern: string): string {
  if (typePattern === "*") return "Everything";
  const base = typePattern.replace(/\.\*$/, "");
  const seg = base.split(".").filter(Boolean).pop() ?? base;
  const words = seg.replace(/_/g, " ").trim();
  if (!words) return typePattern;
  const titled = words.charAt(0).toUpperCase() + words.slice(1);
  return typePattern.endsWith(".*") ? `${titled} (all)` : titled;
}

/**
 * Whether a scope reaches things that do not exist yet.
 *
 * Two shapes qualify and they share nothing in the grammar, so both are
 * asked rather than inferred from the spelling. A subtree wildcard covers
 * its root and everything under it, later registrations included. The bare
 * `metadata` root carries no wildcard character at all and is the one that
 * reads as concrete: it projects to `{ "*": verb }`, which matches any
 * sub-resource, so it covers the two that exist today and whatever the list
 * grows next.
 *
 * The second arm asks the projection rather than a list of open-ended roots
 * kept here. A list beside the grammar is a second answer to a question the
 * grammar already settles, and the way it fails is that the screen keeps
 * rendering while quietly going narrow about one pattern.
 */
function isOpenEnded(scope: ParsedScope): boolean {
  if (scope.kind === "oidc" || scope.kind === "capability") return false;
  const pattern = scope.typePattern;
  if (pattern === GLOBAL_TYPE_WILDCARD) return true;
  if (subtreeWildcardRoot(pattern) !== null) return true;
  const projected = scopesToMetadataPermissions([
    `${pattern}:${scope.operation}`,
  ]);
  return projected["*"] !== undefined;
}

/** Human toggle label for a scope. */
function labelFor(
  scope: ParsedScope,
  descriptions: Record<string, string> | undefined,
): string {
  if (scope.kind === "oidc") {
    const lit = scope.oidcScope ?? scope.typePattern;
    return oidcLabel(lit) ?? humanizeType(lit);
  }
  if (scope.kind === "capability" && scope.capability) {
    return CAPABILITY_LABELS[scope.capability];
  }
  return (
    SCOPE_LABELS[scope.typePattern] ??
    descriptions?.[scope.typePattern] ??
    humanizeType(scope.typePattern)
  );
}

/** Renders the OAuth consent screen as an HTML string. */
export function renderConsentScreen(params: ConsentParams): string {
  const safeClient = escapeHtml(params.clientName);
  const safeClientId = escapeHtml(params.clientId);
  const safeOauthQuery = escapeHtml(params.oauthQuery);
  const showDiff = params.priorScopes !== undefined;

  const parsedByLiteral = new Map<string, ParsedScope>();
  for (const s of params.scopes) parsedByLiteral.set(scopeLiteralFor(s), s);

  // `openid` and `offline_access` are OAuth mechanisms (identity base +
  // refresh token), not data permissions — they ride along as always-on
  // hidden fields rather than per-type toggles.
  //
  // `default_on` deliberately does not reach them. A hidden field a person
  // cannot see is not something they can be said to have declined, so
  // rendering one unticked would drop a mechanism silently rather than
  // offer a choice. A bundle that means to withhold one has to stop
  // requesting it.
  const isHidden = (s: ParsedScope): boolean =>
    s.kind === "oidc" &&
    s.oidcScope !== undefined &&
    HIDDEN_MECHANISM_SCOPES.includes(s.oidcScope);

  const hiddenFields = (scopes: ParsedScope[]): string =>
    scopes
      .filter(isHidden)
      .map(
        (s) =>
          `<input type="checkbox" name="scopes" value="${escapeHtml(scopeLiteralFor(s))}" checked hidden>`,
      )
      .join("");

  /** A single per-type toggle row. A wildcard row lists the types the
   *  pattern matches today, since the grant itself names no types. */
  const subRow = (scope: ParsedScope, defaultOn: boolean): string => {
    const literal = escapeHtml(scopeLiteralFor(scope));
    const label = escapeHtml(labelFor(scope, params.descriptions));
    const matched =
      scope.kind !== "oidc"
        ? params.wildcardExpansions?.[scope.typePattern]
        : undefined;
    // The row's second line is where open-endedness is stated, and it is
    // stated for every open-ended pattern rather than only for the ones a
    // space can name members of today.
    //
    // It cannot live in the label. `SCOPE_LABELS` entries are also joined
    // into the group summary sentence, and open-endedness needs a
    // conjunction to say, so a label that says it breaks the list it is
    // joined into. It cannot live in the description either, because a
    // curated label suppresses that. So the two known offenders were not a
    // pair of bad strings: they were the only place left for the fact to go
    // being one that could not hold it. Both said less than the device
    // screen, which has no toggle labels and so reads the description out
    // whole, and the narrower of the two answers was the one on the screen
    // where somebody is ticking boxes.
    //
    // The expansion line wins where there is one: it already ends "plus any
    // you add later", so it says this and names today's members too.
    const openEndedLine = isOpenEnded(scope)
      ? "Covers what exists today plus anything added later"
      : "";
    const detailText =
      matched && matched.length > 0
        ? `Today this covers ${matched.join(", ")}, plus any you add later`
        : openEndedLine;
    const detail = detailText
      ? `<span class="rmeta" style="display:block">${escapeHtml(detailText)}</span>`
      : "";
    // The per-type checkbox is what the form submits, so this attribute is
    // the whole of what `default_on: false` means: the literal is offered,
    // and ticking it is the grant.
    const checked = defaultOn ? " checked" : "";
    return `<div class="subrow"><span>${label}${detail}</span><label class="sw"><input type="checkbox" name="scopes" value="${literal}"${checked}><span class="tk" aria-hidden="true"></span></label></div>`;
  };

  /** One collapsed soft-tile group: a master toggle in the summary, per-type
   *  toggles in the body. */
  const group = (g: ScopeGroup): string => {
    if (g.scopes.length === 0) return "";
    const rows = g.scopes.map((s) => subRow(s, g.defaultOn)).join("");
    // The master carries no `name`, so it submits nothing and is purely the
    // control that drives its members. It still starts in the group's state,
    // or an off-by-default group would open showing a ticked master over
    // unticked rows.
    const masterChecked = g.defaultOn ? " checked" : "";
    return `<details class="grp">
      <summary>
        <span class="gmain">
          <span class="gtop"><span class="glabel">${escapeHtml(g.label)}</span>${CHEVRON}</span>
          <span class="gdesc">${escapeHtml(g.desc)}</span>
        </span>
        <label class="sw" onclick="event.stopPropagation()"><input type="checkbox"${masterChecked} aria-label="${escapeHtml(g.label)}"><span class="tk" aria-hidden="true"></span></label>
      </summary>
      <div class="gsub">${rows}</div>
    </details>`;
  };

  const bundles = params.bundles ?? getPermissionBundles();

  /** Partition a scope set into bundle-derived groups and render the
   *  non-empty ones, in bundle order, inside a soft-tile stack. */
  const groupedTiles = (
    scopes: ParsedScope[],
    /**
     * Whether these scopes are already granted, which overrides the bundle's
     * `default_on`.
     *
     * `default_on` answers "should this start ticked the first time it is
     * offered". A scope the user granted on a previous visit is not being
     * offered, it is being shown, so asking the flag about it is asking the
     * wrong question and the answer it gives is destructive. The "Already
     * allowed" tile is collapsed and sits below "New", so an off-by-default
     * scope rendered unticked there is invisible; an untouched Continue then
     * submits without it, and the decision route reads a narrowing rather
     * than a no-op. A narrowing is treated as a promise that the removed
     * access stops working, so it revokes the client's live tokens. The user
     * is shown nothing and a working integration dies.
     */
    alreadyGranted = false,
  ): string => {
    const tiles = buildGroups(scopes, bundles)
      .map((g) => (alreadyGranted ? { ...g, defaultOn: true } : g))
      .map(group)
      .join("");
    return `<div class="t-soft">${tiles}</div>`;
  };

  let contentHtml: string;
  if (showDiff) {
    const nextLiterals = params.scopes.map(scopeLiteralFor);
    const diff = computeConsentDiff(params.priorScopes ?? [], nextLiterals);
    const lookup = (lits: readonly string[]): ParsedScope[] =>
      lits
        .map((lit) => parsedByLiteral.get(lit))
        .filter((s): s is ParsedScope => s !== undefined);

    const added = lookup(diff.added);
    const kept = lookup(diff.kept);
    const addedVisible = added.filter((s) => !isHidden(s));
    const keptVisible = kept.filter((s) => !isHidden(s));

    const newSection =
      addedVisible.length > 0
        ? `<p class="lsec" style="margin-top:8px">New</p>${groupedTiles(addedVisible)}`
        : "";
    // The standing grant keeps the same partition the new request uses, and
    // that is deliberate rather than untouched.
    //
    // It costs something real: "Other read access" and "Other write access"
    // render in both sections, covering different scopes each time, and the
    // second stack is most of the height between the reader and the buttons.
    // Collapsing it into one tile fixes both and loses more than it fixes,
    // because the read and write halves of a grant are told apart by their
    // bundle headings and by nothing else. `labelFor` resolves a row from
    // `typePattern` alone, so `core.note:read` and `core.note:write` are both
    // the word "Notes"; merged into one body they become two identical rows,
    // and `summarize` de-duplicates them into one word. A screen that cannot
    // say an app may write your notes has failed at the only job it has.
    //
    // So the shorter standing grant is structural work rather than a smaller
    // edit: it needs the operation carried by the row, or the section
    // summarized without re-listing it. Left whole here on purpose.
    const keptSection =
      keptVisible.length > 0
        ? `<p class="lsec" style="margin-top:24px">Already allowed</p>${groupedTiles(keptVisible, true)}`
        : "";
    // Removed scopes are being dropped, not re-granted, so their group names
    // render as a quiet line with no toggles.
    //
    // Joined into that line, so a capability resolves through its inline-list
    // form for the same reason the summaries do: the toggle labels are
    // capitalized and two of them carry a comma, which turns one item in this
    // list into two fragments.
    const removedLabels = Array.from(
      new Set(
        diff.removed.map((lit) => {
          const lastColon = lit.lastIndexOf(":");
          const typePattern = lastColon > 0 ? lit.slice(0, lastColon) : lit;
          return (
            capabilityShort(typePattern) ??
            oidcLabel(typePattern) ??
            SCOPE_LABELS[typePattern] ??
            humanizeType(typePattern)
          );
        }),
      ),
    );
    // Capitalized on the same rule the summaries use, since an inline-list
    // form is stored lowercase and can land first here.
    const removedList = removedLabels.join(", ");
    const removedSection =
      removedLabels.length > 0
        ? `<p class="lsec" style="margin-top:24px">No longer needed</p><p class="rmeta" style="padding-top:2px">${escapeHtml(
            `${removedList.charAt(0).toUpperCase()}${removedList.slice(1)}`,
          )}</p>`
        : "";

    // Hidden mechanisms (openid / offline_access) that survive the diff
    // still need to submit.
    contentHtml = `${newSection}${keptSection}${removedSection}${hiddenFields([...added, ...kept])}`;
  } else {
    const visible = params.scopes.filter((s) => !isHidden(s));
    contentHtml = `${groupedTiles(visible)}${hiddenFields(params.scopes)}`;
  }

  // One boxed caution for an unverified (public / DCR) client — no inline
  // badge, no second warning.
  const callout = params.unverified
    ? `<div class="callout"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg><span>Marfa hasn't verified this app. Anyone can use this name, so only allow access if you trust it.</span></div>`
    : "";

  const errorBanner = params.errorMessage
    ? `<div class="banner banner--error" role="alert">${escapeHtml(params.errorMessage)}</div>`
    : "";

  // Re-consent copy reads as a continuation, not as an app demanding more.
  //
  // "wants to change what it can access" was accurate and misleading at once.
  // The usual reason this screen appears is that Marfa's own type registry
  // gained something since the last grant, so the app is asking for a new
  // kind of content that did not exist when the person first approved it.
  // Phrasing that as the app changing its mind invites a refusal on a
  // suspicion the situation does not warrant. The wording below is true in
  // both cases without claiming a cause the server cannot always know.
  const title = showDiff ? "One more thing" : "Allow access";
  const sub = showDiff
    ? `You have used <b>${safeClient}</b> before. It is asking for a little more.`
    : `<b>${safeClient}</b> wants to access your space. You can change this anytime in settings.`;
  const primaryLabel = showDiff ? "Continue" : "Allow access";

  // Each group's master toggle drives its members; members reflect back as an
  // indeterminate master when partially ticked. Scoped per `.grp` so the
  // duplicate groups in a re-consent diff don't cross-wire. The master toggle
  // carries no `name`, so only the per-type members submit. Minified with
  // `replace(/\s+/g, " ")` — no `//` line comments.
  const enhancementScript = `
    (function () {
      document.querySelectorAll('.grp').forEach(function (grp) {
        var master = grp.querySelector(':scope > summary input[type="checkbox"]');
        var members = grp.querySelectorAll('.gsub input[type="checkbox"]');
        if (!master || !members.length) return;
        master.addEventListener('change', function () {
          members.forEach(function (m) { m.checked = master.checked; });
        });
        function sync() {
          var any = false, all = true;
          members.forEach(function (m) { if (m.checked) any = true; else all = false; });
          master.checked = any;
          master.indeterminate = any && !all;
        }
        members.forEach(function (m) { m.addEventListener('change', sync); });
        sync();
      });
    })();
  `
    .trim()
    .replace(/\s+/g, " ");

  const bodyHtml = `
    <h1 class="title">${escapeHtml(title)}</h1>
    <p class="sub">${sub}</p>
    ${callout}
    ${errorBanner}
    <form method="POST" action="/auth/authorize/decision" class="consent-form" novalidate>
      <input type="hidden" name="client_id" value="${safeClientId}">
      <input type="hidden" name="oauth_query" value="${safeOauthQuery}">
      ${contentHtml}
      <div class="actions">
        <button type="submit" name="accept" value="true" class="btn btn--primary" data-loading-label="${escapeHtml(primaryLabel)}...">${escapeHtml(primaryLabel)}</button>
        <button type="submit" name="accept" value="false" class="btn btn--ghost">Deny</button>
      </div>
    </form>
    <script>${enhancementScript}</script>
    <script src="/auth/static/submit-state.js"></script>
  `;

  return renderAuthLayout({
    title: showDiff
      ? `Update access for ${params.clientName}`
      : `Authorize ${params.clientName}`,
    bodyHtml,
  });
}
