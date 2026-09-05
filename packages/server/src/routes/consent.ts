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
  HIDDEN_MECHANISM_SCOPES,
  parseScope,
  scopesOfferedOffByDefaultOnly,
} from "@withmarfa/shared";
import { getPermissionBundles } from "../config.js";
import { CAPABILITY_LABELS, capabilityShort } from "./capability-labels.js";
import { oidcLabel, oidcShort } from "./oidc-labels.js";
import { renderAuthLayout } from "./auth-layout.js";
import { computeConsentDiff } from "./consent-diff.js";
import { escapeHtml } from "./auth-html.js";
import {
  isOpenEnded,
  OPEN_ENDED_EXPANSION_TAIL,
  OPEN_ENDED_LINE,
} from "./scope-openness.js";
import {
  operationSentence,
  scopeOperation,
  sharedOperationSentence,
  withOperation,
} from "./scope-operation.js";

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
/**
 * One toggle row: a scope, and whether it starts ticked.
 *
 * **`defaultOn` belongs to the row rather than to the group, and moving it
 * here is what unblocks the density work.** It used to sit on `ScopeGroup`,
 * read off the owning bundle's `default_on`, with the re-consent diff
 * overriding the whole group to `true` for the standing grant. That made two
 * stacks of tiles impossible to combine: one group would hold an added
 * off-by-default scope beside a kept one, and a single flag has no answer
 * that is not destructive in one direction. On, and a scope nobody agreed to
 * rides in ticked. Off, and an untouched Continue submits a narrowing, which
 * the decision route reads as a promise that the removed access stops
 * working and acts on by revoking the client's live tokens.
 *
 * Per row there is no such conflict: a kept scope is `true` because it is
 * being shown rather than offered, and an added one keeps its bundle's
 * answer, in the same group.
 */
interface ScopeRow {
  scope: ParsedScope;
  /**
   * Whether this toggle starts ticked.
   *
   * From the owning bundle's `default_on` where the scope is being offered.
   * An off-by-default bundle is the shape a bundle needs when it carries
   * something a person should have to reach for rather than merely leave
   * alone, and it is also what lets an already-registered client be offered
   * something new without every client having to re-register to get it.
   *
   * Forced `true` for a scope the user has already granted, because the
   * question the flag answers does not arise a second time: that scope is
   * being shown, not offered.
   */
  defaultOn: boolean;
}

interface ScopeGroup {
  label: string;
  desc: string;
  rows: ScopeRow[];
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
  /**
   * Force every row ticked, for the standing grant on the re-consent diff.
   *
   * `default_on` answers "should this start ticked the first time it is
   * offered", and a scope the user granted on a previous visit is not being
   * offered. Asking the flag about it is asking the wrong question, and the
   * answer it gives is destructive: the "Already allowed" section is
   * collapsed, so an off-by-default scope rendered unticked there is
   * invisible, an untouched Continue submits without it, and the decision
   * route reads a narrowing rather than a no-op. A narrowing is treated as a
   * promise that the removed access stops working, so it revokes the
   * client's live tokens. The user is shown nothing and a working
   * integration dies.
   *
   * A parameter here rather than a post-hoc rewrite of the built groups,
   * which is what it was: that rewrite could only speak at group
   * granularity, and this one is per row.
   */
  forceDefaultOn = false,
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
  const bundleDefaultOn = new Map<string, boolean>();
  for (const bundle of bundles) {
    byBundle.set(bundle.id, {
      label: bundle.label,
      desc: bundle.description,
      rows: [],
    });
    bundleDefaultOn.set(bundle.id, bundle.default_on);
  }
  // The fallback buckets stay ticked. They hold what an app named explicitly
  // and no bundle claims, so there is no declaration to honor: `default_on`
  // is a property of a bundle, and unticking a scope no bundle describes
  // would be this screen inventing a policy rather than rendering one.
  const otherRead: ScopeGroup = {
    label: "Other read access",
    desc: "Additional things this app asked to read.",
    rows: [],
  };
  const otherWrite: ScopeGroup = {
    label: "Other write access",
    desc: "Additional things this app asked to change.",
    rows: [],
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
    rows: [],
  };
  for (const scope of scopes) {
    // `forceDefaultOn` is the standing grant's answer and outranks every
    // rule below, because a scope already granted is being shown rather than
    // offered. Applied per row, so one group may hold a forced row beside an
    // ordinary one — which is the whole point of the move.
    const bundle = literalToBundle.get(scopeLiteralFor(scope));
    if (bundle) {
      byBundle.get(bundle.id)?.rows.push({
        scope,
        defaultOn: forceDefaultOn || (bundleDefaultOn.get(bundle.id) ?? true),
      });
    } else if (scope.kind === "capability") {
      otherCapability.rows.push({ scope, defaultOn: forceDefaultOn });
    } else if (scope.kind !== "oidc" && scope.operation === "write") {
      otherWrite.rows.push({ scope, defaultOn: true });
    } else {
      otherRead.rows.push({ scope, defaultOn: true });
    }
  }
  // Administrative access last: it is the widest thing on the screen, and a
  // reader scanning downward should not meet it between two content groups.
  return [...byBundle.values(), otherRead, otherWrite, otherCapability]
    .filter((g) => g.rows.length > 0)
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
 * An open-ended scope is the one case where "and more" is honest, because the
 * grant really does extend to types that do not exist yet. Which scopes those
 * are is {@link isOpenEnded}'s answer rather than a second one read off the
 * spelling. This asked whether the pattern held a `*`, and bare `metadata`
 * holds none while reaching every metadata sub-resource, so the two
 * derivations disagreed on the one heading that most needed the clause and
 * it was the only open-ended group that never got it.
 *
 * **What the group permits is stated too, and the de-duplication is keyed on
 * it.** These names resolve through a chain keyed on the type pattern, which
 * carries no verb, so `core.note:read` and `core.note:write` both produced
 * the word "Notes" and the second was dropped as a repeat of the first. That
 * is the mechanism by which a summary of a read-and-write request read
 * exactly like a summary of a read one. Where every scope in the group
 * permits the same thing the sentence says so once at the end; where they
 * disagree, which is what a merged section is, each name carries it.
 *
 * **A pattern held at both operations contributes one name**, in the write
 * form, because a write grant confers read. The reason that is worth doing
 * is the four-name truncation below rather than the redundancy; the note at
 * the collapse itself carries it. What the group permits is then asked of
 * what survives that collapse, so a group holding both halves of one grant
 * states the operation once at the end like any other group whose members
 * agree.
 */
function summarize(group: ScopeGroup): string {
  // Asked of every scope the group holds, including the ones the collapse
  // below drops and the ones no chain finds a word for: a group reaching
  // things that do not exist yet does so whether or not this sentence ends
  // up naming the scope that reaches them.
  const groupScopes = group.rows.map((r) => r.scope);
  const openEnded = groupScopes.some((scope) => isOpenEnded(scope));
  // **A pattern the group holds at both operations is stated once, in the
  // write form.** A write grant confers read, so "Notes (read and write)" is
  // the whole truth where "Notes (read only), Notes (read and write)" is one
  // fact said twice.
  //
  // Redundancy is the smaller half of it. This sentence names four and then
  // counts, so doubling the names halves the threshold, and the shipped
  // `custom` bundle emits both halves for every writable root: at two of
  // them the list tipped into "and N more", which is the branch that
  // replaces the clause saying the grant reaches types nobody has registered
  // yet. That clause went missing on the one bundle whose own description
  // promises exactly that.
  //
  // **The collapse raises that threshold; it does not decouple the two.**
  // The `custom` bundle reaches four names at three own roots and tips at
  // four, where the count takes the slot the clause was in and the sentence
  // stops saying the grant reaches types nobody has registered yet. The
  // sentence did that before the collapse existed, at five names instead of
  // four, so it is the truncation's defect rather than this fold's. What
  // `scope-openness.ts` guarantees is narrower than it looks: both surfaces
  // read one answer for *which* scopes are open-ended, which is what stopped
  // the two derivations disagreeing, and it cannot keep a sentence that has
  // run out of room from dropping the clause. Fixing that means giving the
  // count and the clause separate room rather than one slot;
  // `consent-operation.test.ts` pins where the clause dies today so that
  // whoever does it can see what they are changing.
  //
  // **Keyed on the family and the pattern, not on the rendered name.** Two
  // patterns can resolve to one word, and merging those would claim write
  // over a grant that only carries read.
  //
  // The family half is redundant against anything `parseScope` produced,
  // which derives kind and pattern from the same literal and so cannot
  // answer one pattern for two families. It is here because that guarantee
  // lives in another file while this fold is the thing that would go wrong:
  // `ParsedScope` is an ordinary interface, `device-pages.test.ts` already
  // hand-builds literals of it, and a hand-built pair sharing a pattern
  // across two families would silently fold one family's read into the
  // other's write. Keyed this way the collapse can only ever fold a pattern
  // into itself, whatever built the value.
  //
  // **Only here, and what makes it the exception is the truncation rather
  // than the redundancy.** This sentence names four and then counts, so a
  // name the collapse does not have to spend is a name the futurity clause
  // can have. Neither other surface is short of room, and both keep the
  // pair. A toggle row is a separately tickable grant whose literal is what
  // the form submits, so folding one into the other would hide a checkbox.
  // The device screen prints every line it resolves and truncates nothing,
  // so folding there would drop a line to buy space nothing was competing
  // for, and cost the reader the shape of the request the client actually
  // made. `consent-operation.test.ts` holds both surfaces to that.
  const foldKey = (scope: ParsedScope): string =>
    `${scope.kind}:${scope.typePattern}`;
  const writable = new Set(
    groupScopes
      .filter((scope) => scopeOperation(scope) === "write")
      .map(foldKey),
  );
  const stated = groupScopes.filter(
    (scope) =>
      !(scopeOperation(scope) === "read" && writable.has(foldKey(scope))),
  );
  // Asked of what survives the collapse rather than of what the group holds,
  // because the collapse is what decides how many operations the sentence
  // still has to distinguish. A group holding both halves of one grant has
  // one name left and one thing to say about it, and saying it once at the
  // end is what this function does with every other shared property.
  const shared = sharedOperationSentence(stated);
  const names: string[] = [];
  const seen = new Set<string>();
  for (const scope of stated) {
    // Nearly the chain the toggle list uses, humanized floor included.
    // Stopping at the curated map left an uncurated scope out of this
    // sentence while the list below still showed it, so the summary
    // undercounted exactly the scopes a reader is least likely to recognize.
    // It is the same failure this function's own docstring describes, from
    // the other end.
    //
    // **Nearly, and the missing link is worth naming rather than rounding
    // off.** `labelFor` falls SCOPE_LABELS → the description map →
    // `humanizeType`; this omits the middle one. So a pattern that no
    // curated label names but a description does is summarized by a
    // title-cased fragment of its own pattern while its row below reads the
    // sentence, and the heading is then vaguer than the list it heads. That
    // predates the content category and is not fixed here: threading the
    // descriptions through would put paragraph-length registry prose into a
    // comma-joined sentence, which is the failure the docstring above is
    // about, so the fix is a short form rather than the map — the shape
    // `capabilityShort` and `oidcShort` already take.
    //
    // Capabilities and the profile scopes resolve through their inline-list
    // forms rather than their toggle labels. A toggle label sits alone above
    // a switch, so it is capitalized and free to carry a comma; joined into
    // a sentence, the capital lands mid-clause and the comma turns one item
    // into two. `CAPABILITY_SHORT` exists for precisely this and says so.
    const label =
      capabilityShort(scope.typePattern) ??
      oidcShort(scope.oidcScope ?? scope.typePattern) ??
      scopeShort(scope.typePattern) ??
      SCOPE_LABELS[scope.typePattern] ??
      (scope.kind === "oidc" ? undefined : humanizeType(scope.typePattern));
    if (!label) continue;
    // Keyed on what the row permits as well as on what it names, so two
    // grants that differ only in operation survive as two. The rendered name
    // carries the operation only where the group has no single answer to
    // state at the end, and either way the key does, so the two shapes
    // cannot de-duplicate differently.
    const key = `${label} ${scopeOperation(scope) ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(shared === undefined ? withOperation(scope, label) : label);
  }
  if (names.length === 0) return group.desc;

  const listed = names.slice(0, 4);
  const remainder = names.length - listed.length;
  let list = listed.join(", ");
  if (listed.length > 1) {
    const last = listed[listed.length - 1] ?? "";
    list = `${listed.slice(0, -1).join(", ")} and ${last}`;
  }
  // **The count and the clause need separate room, and used to share one
  // slot.** Past four names the sentence said how many were left INSTEAD of
  // saying the grant reaches things nobody has created yet — so it stopped
  // stating the open-endedness exactly as the grant got wide enough to need
  // truncating, which is the point at which that fact matters most. Each row
  // still carries its own futurity line, so nothing was lost outright; but
  // the groups are collapsed by default, so this sentence is what most
  // people act on.
  //
  // "plus" rather than a second "and", which is the whole reason the two
  // branches are not one string: "and 3 more, and anything else of that
  // kind" reads as a list item rather than as a second clause.
  if (remainder > 0) {
    list += `, and ${String(remainder)} more`;
    if (openEnded) list += ", plus anything else of that kind";
  } else if (openEnded) {
    list += ", and anything else of that kind";
  }

  // The labels are written for a toggle row, where each one starts a line of
  // its own and a capital is right. Joined into a sentence they carry that
  // capital into the middle of it, which read as "Your name and Your email
  // address". Only the labels that are phrases rather than category names
  // have a sentence form, so the fix is not a general lowercasing pass: a
  // brand keeps its capital wherever it lands, and "Notes, Tasks and Files"
  // is a list of names that reads correctly as it stands.
  const sentence = `${list.charAt(0).toUpperCase()}${list.slice(1)}.`;
  return shared === undefined ? sentence : `${sentence} ${shared}`;
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
 * **A brand is the one member of that list "Organizations" does not name,
 * and it stays as stated residue rather than being fixed.** Three things
 * decide it. The type's own fields are organization-shaped: an officially
 * registered legal name, a founding date, a logo. The grant reaches exactly
 * one type, so unlike "People and places" nothing separately requestable
 * goes unnamed by it, and the rule this docstring states is about reach.
 * And no conjunction-free word covers a brand as well as a school, while
 * "Organizations and brands" is precisely the shape the paragraph below
 * refuses, so buying that member back costs the list-join rule. What is not
 * acceptable is the label and the description disagreeing about it, which is
 * why the description now stops where the label does.
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
 *
 * **`CONSENT_SCOPE_DESCRIPTIONS` is under the same prohibition, for a
 * different reason.** A description cannot carry it because a description is
 * sometimes this label: `labelFor` falls through to one wherever nothing
 * curated names the pattern, so a futurity clause written there for the
 * device screen's sake lands on a toggle row already about to state the same
 * fact. Both screens compose their own sentence from {@link isOpenEnded}
 * instead, so neither map has to hold one and no renderer has to read
 * English to find out whether a string it was handed has said it already.
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
  // "Connected accounts" named less than the description beside it: a
  // connection need not have a login, so the label narrowed the grant to the
  // case that happens to have one. "Connections" is what the description
  // already says.
  //
  // **`system.activity` has the same defect and cannot be fixed here.** Its
  // label drops notifications, which is the half a reader cares about, and
  // every label that carries both halves needs a conjunction — which the
  // separator guard in `consent-render.test.ts` forbids, correctly, because
  // `summarize` joins these into a list and an "and" inside one arrives there
  // as two items. Closing it needs a short inline form distinct from the
  // toggle label, the shape `CAPABILITY_SHORT` already takes for exactly this
  // reason. That is a map, not a word, so it is not in this pass.
  "system.connection": "Connections",
  "system.integration": "Available integrations",
  "system.device": "Devices",
  "system.webhook": "Webhooks",
  "system.activity": "Activity and notifications",
  profile: "Profile",
  "profile.name": "Name",
  "profile.email": "Email address",
  "profile.avatar": "Avatar",
  metadata: "Definitions in your space",
  // The two metadata sub-resources had no entry at all, so `labelFor` fell to
  // `humanizeType` and answered "Types" and "Edge types" while the row beneath
  // printed the full sentence. Same scope, two registers, one screen — the
  // same defect as the two labels above, arriving through an absence rather
  // than through a wording choice.
  "metadata.types": "Custom data types",
  "metadata.edge_types": "Custom relationship types",
  // The content category. A name rather than a description of reach,
  // like every entry above it: what the grant covers is the description
  // map's sentence, and that it covers types nobody has registered yet
  // is the row's second line, composed from `isOpenEnded`. Saying either
  // here would need a conjunction, and a conjunction in this map arrives
  // in `summarize` as two list items.
  content: "Your content",
};

/**
 * Inline-list forms for type-axis scopes, for a sentence naming several at
 * once.
 *
 * Lower case and free of anything that reads as an item boundary, because
 * {@link summarize} joins these into a list. That is the same contract
 * `CAPABILITY_SHORT` and `OIDC_SHORT` carry, and this is the third and last
 * family in that chain to get one — type scopes were the one branch of
 * `summarize`'s resolution with no short form, so a label was doing both
 * jobs and could only ever be good at the harder one.
 *
 * **Sparse on purpose. An entry here is for a pattern whose toggle label
 * needs to say more than a list item may.** Everything else resolves through
 * `SCOPE_LABELS` exactly as before, so this is not a second name for every
 * scope — which is what the duplicate-copy guard exists to stop.
 *
 * The separator guard over `SCOPE_LABELS` is what makes the split
 * load-bearing rather than decorative: a label carrying a conjunction is
 * refused UNLESS the pattern has an entry here to be summarized through.
 */
export const SCOPE_SHORT: Record<string, string> = {
  // The label reads "Activity and notifications", and the notifications half
  // is the one a reader cares about — it is the difference between a log
  // nobody looks at and something that reaches them. It could not be said
  // before this map existed: the conjunction that says it is exactly what a
  // joined list breaks on, so "Notes, Activity and notifications and Files"
  // was the sentence a label carrying both halves produced.
  //
  // The short form names the thing rather than both halves, which is what a
  // list item can be. The row is where the reader gets the rest.
  "system.activity": "activity",
};

/** The inline-list form for a type pattern, or undefined where its toggle
 *  label is already fit to be joined into a list. */
export function scopeShort(typePattern: string): string | undefined {
  return SCOPE_SHORT[typePattern];
}

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
 * Human toggle label for a scope, saying both what the grant reaches and
 * what it permits.
 *
 * **The name half is keyed on the type pattern, which carries no verb**, so
 * every term in the chain below answers the same string for a read and a
 * write over one type. The operation is composed on top rather than curated
 * into the maps, and it is applied over the whole chain rather than inside
 * it so that the humanized floor an uncurated pattern falls to carries it as
 * well. A distinction that held only for the curated set would be none: a
 * third-party app's custom request is the grant a person has least other
 * information about.
 *
 * **Which of the two forms carries it is decided by what the name half
 * turned out to be, rather than by the scope.** The parenthesis
 * {@link withOperation} appends is written for a name, and `SCOPE_LABELS`,
 * the OIDC and capability maps and the humanized floor all answer one:
 * "Notes (read and write)" is what that form is for. The description map
 * answers a sentence instead, so a row resolved through it read "Everything
 * in your space. (read only)", with the bracket stranded past the period.
 * That is not a corner of this screen: every wildcard but `user.*`, every
 * edge type and three of the `system.*` types have no curated label at all,
 * and a runtime-registered type's description is whatever prose its author
 * wrote. A sentence therefore takes {@link operationSentence}, which is the
 * string the device screen already prints for the same scope, so the two
 * surfaces end up saying one grant one way wherever both fall this far.
 *
 * **Splitting the forms is also what makes the parenthesis's own reason
 * true.** {@link withOperation} is bracketed because {@link summarize}
 * joins names into a list sentence and a comma or an "and" inside one
 * arrives there as two items. That argument is about names, and `summarize`
 * resolves through `SCOPE_LABELS` and the humanized floor without ever
 * consulting a description — so it covered every path except the one that
 * was rendering wrong.
 *
 * The verb-less families take neither form, decided on `kind` in an
 * exhaustive switch rather than on which branch below returned.
 */
function labelFor(
  scope: ParsedScope,
  descriptions: Record<string, string> | undefined,
): string {
  const name = scopeName(scope, descriptions);
  if (!name.isSentence) return withOperation(scope, name.text);
  const permits = operationSentence(scope);
  return permits === undefined
    ? name.text
    : `${endStopped(name.text)} ${permits}`;
}

/** What the grant reaches, with no statement of what it permits, and whether
 *  the chain answered with a name or with a sentence. */
interface ScopeName {
  text: string;
  isSentence: boolean;
}

/**
 * Resolves the name half, and reports which register it came from.
 *
 * `isSentence` is set by which branch answered rather than by inspecting
 * the string. Every other branch reads a map this repository curates under
 * a rule that keeps its entries names; the description branch is the one
 * that can end up holding a runtime-registered type's own prose, which
 * nothing here governs. Sniffing for a trailing period instead would make
 * the form depend on how an unrelated author punctuated, and would take the
 * bracket off any curated label that ever gained one.
 */
function scopeName(
  scope: ParsedScope,
  descriptions: Record<string, string> | undefined,
): ScopeName {
  if (scope.kind === "oidc") {
    const lit = scope.oidcScope ?? scope.typePattern;
    return { text: oidcLabel(lit) ?? humanizeType(lit), isSentence: false };
  }
  if (scope.kind === "capability" && scope.capability) {
    return { text: CAPABILITY_LABELS[scope.capability], isSentence: false };
  }
  const curated = SCOPE_LABELS[scope.typePattern];
  if (curated !== undefined) return { text: curated, isSentence: false };
  const described = descriptions?.[scope.typePattern];
  if (described !== undefined) return { text: described, isSentence: true };
  return { text: humanizeType(scope.typePattern), isSentence: false };
}

/**
 * The sentence with a full stop on it, added only where one is missing.
 *
 * A description is a sentence, but only the curated map guarantees it is
 * punctuated as one: an uncurated pattern falls through to its registry
 * entry, and that is prose somebody wrote for an API reference. Without the
 * stop the operation would run into the last word of it.
 */
function endStopped(text: string): string {
  return /[.!?]["')\]]?$/.test(text) ? text : `${text}.`;
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
    // Open-endedness is stated for every open-ended pattern rather than only
    // for the ones a space can name members of today, and stated once.
    // {@link isOpenEnded} is the whole of the condition: this row asks the
    // grammar and nothing else, so no string anywhere can talk it out of
    // saying so.
    //
    // **It was conditioned on the copy, and that is the bug this shape
    // exists to make unrepresentable.** A curated label cannot carry the
    // fact, because `SCOPE_LABELS` entries are joined into the group summary
    // sentence and futurity needs a conjunction to say, which breaks the
    // list. But a label is not always curated: `labelFor` falls through to
    // the scope's description, and the description used to carry a futurity
    // clause of its own for the device screen's sake. So the same sentence
    // arrived as this row's label with the line about to repeat it, and the
    // suppression that followed asked whether the label contained the word
    // "later". A clause meaning futurity in other words slipped past it and
    // was stated twice. A "later" meaning something else entirely, as in a
    // deletion that stays recoverable, suppressed the line on a grant that
    // then said nothing about reaching types nobody has registered. The copy
    // no longer states it on either surface: `OPEN_ENDED_SENTENCE` is how
    // the device screen gets it, composed there the same way.
    //
    // The expansion line absorbs the clause where there is one, since that
    // line names today's members as well and a wildcard's reach reads as one
    // fact rather than two. Which branch runs is a question about the
    // enumeration, not about what any string says.
    const open = isOpenEnded(scope);
    const detailText =
      matched && matched.length > 0
        ? `Today this covers ${matched.join(", ")}${open ? OPEN_ENDED_EXPANSION_TAIL : ""}`
        : open
          ? OPEN_ENDED_LINE
          : "";
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
    if (g.rows.length === 0) return "";
    // **Keyed on the literal, never on the rendered label.** T-997's fix
    // makes a read-and-write pair render two rows that differ only in their
    // operation, and both resolve the same name — so a `seen` set keyed on
    // what the row says would collapse the pair and take the write half off
    // the screen, which is the defect this file already carries a docstring
    // about avoiding. `scopeLiteralFor` is what the checkbox submits, so two
    // rows share a key exactly when they are the same grant.
    //
    // The parse deduplicates too, and this is not that check repeated.
    // `renderConsentScreen` is exported and its `scopes` parameter is
    // whatever a caller hands it; the device screen has carried the same set
    // one file over since before either surface had a parse to rely on.
    const seen = new Set<string>();
    const rows = g.rows
      .filter((r) => {
        const literal = scopeLiteralFor(r.scope);
        if (seen.has(literal)) return false;
        seen.add(literal);
        return true;
      })
      .map((r) => subRow(r.scope, r.defaultOn))
      .join("");
    // The master carries no `name`, so it submits nothing and is purely the
    // control that drives its members. It still starts in the group's state,
    // or an off-by-default group would open showing a ticked master over
    // unticked rows.
    // **Every row, not the group's own flag, which no longer exists.** The
    // master drives its members and submits nothing itself, so the only
    // honest starting state is the one its members already have: ticked when
    // they all are. A group holding one off-by-default row among ticked ones
    // opens with an unticked master over mostly-ticked rows, which reads
    // correctly — the master is not yet true of everything under it.
    const masterChecked = g.rows.every((r) => r.defaultOn) ? " checked" : "";
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
     * Whether these scopes are already granted. Threaded into `buildGroups`
     * so it lands on each row; the reasoning is at that parameter.
     */
    alreadyGranted = false,
  ): string => {
    const tiles = buildGroups(scopes, bundles, alreadyGranted)
      .map(group)
      .join("");
    return `<div class="t-soft">${tiles}</div>`;
  };

  let contentHtml: string;
  let asksForMore = false;
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
    asksForMore = addedVisible.length > 0;

    const newSection =
      addedVisible.length > 0
        ? `<p class="lsec" style="margin-top:8px">New</p>${groupedTiles(addedVisible)}`
        : "";
    // The standing grant keeps the same partition the new request uses, and
    // it renders collapsed rather than as a second full stack of tiles. That
    // stack was most of the height between the reader and the buttons, on a
    // screen whose entire job is being read to the end.
    //
    // **Collapsed, not merged into "New".** Merging is the other way to buy
    // the height and it erases new-versus-kept, which is the distinction
    // this whole diff exists to draw — a person returning to a consent
    // screen is being asked about what changed, and a screen that cannot say
    // which rows are new has answered a different question.
    //
    // Both things that made this unsafe are now gone. The read and write
    // halves of a grant were told apart by their bundle headings and by
    // nothing else, until `withOperation` put the operation on the row
    // itself; and `defaultOn` was a property of a group, so the standing
    // grant's forced-on could only be stated for a whole group at a time.
    // It is per row now, which is what lets a kept scope be shown ticked
    // beside an offered one that is not.
    //
    // **The rows stay in the DOM while it is shut.** A closed `<details>`
    // still submits its controls, so an untouched Continue carries the
    // standing grant exactly as it did when the section was open. That is
    // the property to preserve: anything that removes or disables these
    // rows turns the same Continue into a narrowing, which the decision
    // route treats as a promise that the removed access stops working and
    // acts on by revoking the client's live tokens.
    const keptCount = new Set(keptVisible.map(scopeLiteralFor)).size;
    const keptSection =
      keptVisible.length > 0
        ? `<details class="ksec"><summary><span class="glabel">Already allowed</span><span class="kcount">${escapeHtml(
            `${String(keptCount)} permission${keptCount === 1 ? "" : "s"}, unchanged`,
          )}</span>${CHEVRON}</summary>${groupedTiles(keptVisible, true)}</details>`
        : "";
    // Removed scopes are being dropped, not re-granted, so their group names
    // render as a quiet line with no toggles.
    //
    // Joined into that line, so a capability resolves through its inline-list
    // form for the same reason the summaries do: the toggle labels are
    // capitalized and two of them carry a comma, which turns one item in this
    // list into two fragments.
    //
    // Carrying what each dropped grant permitted, for the reason every other
    // row on this screen does. Giving up the write half of a type while
    // keeping the read half is an ordinary shape of a narrowing, and without
    // the operation this line prints the same word that "Already allowed" is
    // still showing two sections above it.
    //
    // The literal is put through the grammar for that half rather than sliced
    // for it, since the verb-less families are precisely the ones whose
    // literal carries no colon. A stored grant the grammar refuses — one
    // written under an older build — keeps the hand-recovered pattern and
    // says nothing about an operation nothing could read.
    const removedLabels = Array.from(
      new Set(
        diff.removed.map((lit) => {
          const parsed = parseScope(lit);
          const lastColon = lit.lastIndexOf(":");
          const typePattern =
            parsed?.typePattern ??
            (lastColon > 0 ? lit.slice(0, lastColon) : lit);
          const name =
            capabilityShort(typePattern) ??
            oidcLabel(typePattern) ??
            SCOPE_LABELS[typePattern] ??
            humanizeType(typePattern);
          return parsed ? withOperation(parsed, name) : name;
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
  // A diff with nothing under "New" is an app confirming what it already
  // holds, which happens when a request narrows or when the standing grant
  // covers it but the provider asked for a fresh decision. "A little more"
  // would then be a claim the screen itself contradicts two lines down.
  const sub = showDiff
    ? asksForMore
      ? `You have used <b>${safeClient}</b> before. It is asking for a little more.`
      : `You have used <b>${safeClient}</b> before. It is asking you to confirm what it already has.`
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
