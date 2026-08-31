/**
 * The copy review, aimed at the scopes a client can request.
 *
 * The gallery snapshots are the copy review for the screens they preview,
 * and what they can review is decided by a hand-written fixture. The edge
 * scopes in that fixture were `edge.authored-by` and `edge.references`, both
 * curated; `edge.in-collection` was not in it, had no curated copy, and fell
 * through to the edge registry's containment-model rationale — which reached
 * a device approval screen as a row, with no preview and no snapshot to move.
 * Nothing about the snapshots was broken. They answered a narrower question
 * than everybody read them as answering, because the fixture never asked for
 * that scope.
 *
 * So this file asks the allowlist instead. The set comes from
 * `buildAllowedScopes` — the literals the OAuth plugin will actually accept —
 * folded together with `TYPE_REGISTRY` and `EDGE_TYPE_REGISTRY`, and a scope
 * nobody thought to list fails here rather than shipping.
 *
 * **The two floors, which are the two ways a person is shown machine text.**
 * The device approval screen has no toggles and no labels: its row is
 * `descriptions[pattern] ?? literal`, so a pattern with no copy renders as
 * `todoist.task:read` and a pattern with only registry copy renders as
 * several hundred characters written for somebody reading API docs. The
 * authorize screen's row is `SCOPE_LABELS[pattern] ?? descriptions[pattern]
 * ?? humanizeType(pattern)`, so the same absence arrives there as a
 * title-cased fragment of the literal. Both are the same defect: a person
 * asked to approve a grant described in the vocabulary of the thing that
 * implements it.
 *
 * **This is the same fix as the description-map tests in
 * `consent-render.test.ts`, one level up.** Those derive their sets from the
 * registries so that a tenth edge type or a third metadata sub-resource
 * fails there rather than shipping. The set above them — what a client can
 * actually request — was still hand-listed, which is the same defect the
 * level below had just closed.
 */
import { describe, it, expect } from "vitest";
import type { ParsedScope } from "@withmarfa/shared";
import {
  CAPABILITY_SCOPES,
  EDGE_TYPE_REGISTRY,
  parseScope,
  TYPE_REGISTRY,
} from "@withmarfa/shared";
import { buildAllowedScopes } from "../auth/oauth-provider.js";
import { getPermissionBundles } from "../config.js";
import { buildScopeDescriptions } from "./auth-consent.js";
import { humanizeType, renderConsentScreen, SCOPE_LABELS } from "./consent.js";
import { CAPABILITY_LABELS, capabilityLabel } from "./capability-labels.js";
import { oidcLabel } from "./oidc-labels.js";
import { renderDeviceConsentScreen } from "./device-pages.js";
import { escapeHtml } from "./auth-html.js";

/**
 * A publisher handle of the shape boot installs from the `custom_types`
 * table, injected rather than assumed.
 *
 * The allowlist is not knowable from source alone. `setRuntimeNamespaceRoots`
 * is called at boot with every publisher root any space has registered, and
 * `buildAllowedScopes` folds each one in as `<root>.*:read|write` plus
 * `edge.<root>.*:read|write`. In a test process nothing has booted, so the
 * roots are empty and the widest family in the grammar would be missing from
 * the derived set entirely — the guard would pass by not looking, which is
 * the failure it exists to catch.
 *
 * Passed as the parameter rather than installed through the setter, so this
 * file cannot leave module state behind for anything sharing its worker.
 * The name is deliberately not a namespace this build ships; the precondition
 * test below pins that by checking the allowlist does not already publish it.
 */
const RUNTIME_PUBLISHER_ROOT = "acme";

/** Throws rather than filtering. A literal the grammar rejects would
 *  otherwise leave a shorter set that still satisfies every assertion about
 *  what is present. */
const parse = (literal: string): ParsedScope => {
  const parsed = parseScope(literal);
  if (!parsed) throw new Error(`unparseable requestable scope: ${literal}`);
  return parsed;
};

/**
 * Every scope literal a client can request of this build, with one runtime
 * publisher root folded in.
 *
 * The single binding both the derivation test and the coverage test read,
 * which is the arrangement that makes them separable: replace this with a
 * hand-written array and the coverage test still passes on whatever it was
 * given, while the derivation test says so.
 */
const REQUESTABLE_LITERALS: readonly string[] = buildAllowedScopes(
  getPermissionBundles(),
  [RUNTIME_PUBLISHER_ROOT],
);

const REQUESTABLE: readonly ParsedScope[] = REQUESTABLE_LITERALS.map(parse);

/**
 * One representative scope per `typePattern`, which is the key both consent
 * surfaces resolve copy on. `core.note:read` and `core.note:write` read the
 * same line, so holding both to it says the same thing twice and reports one
 * missing sentence as two.
 */
function distinctPatterns(
  kinds: readonly ParsedScope["kind"][],
): ParsedScope[] {
  const seen = new Map<string, ParsedScope>();
  for (const scope of REQUESTABLE) {
    if (!kinds.includes(scope.kind)) continue;
    if (!seen.has(scope.typePattern)) seen.set(scope.typePattern, scope);
  }
  return [...seen.values()];
}

/**
 * The kinds whose row is resolved through the description map. OIDC and
 * capability literals are not among them: both renderers answer those from
 * their own label maps and return before the description map is read, so
 * they are held to those maps instead, further down.
 *
 * **`content` was listed here before it reached anything, and that is why
 * this guard covered the commit that published it.** The set checked here is
 * derived from the allowlist, so while the category's two literals were
 * withheld `distinctPatterns` found no content pattern and every assertion
 * below passed over an empty arm. Listing it anyway armed the guard for the
 * commit that published them rather than for some later one where a reviewer
 * would have had to notice the omission — which is how the category reached
 * a screen undescribed the first time. It is now a live arm rather than a
 * latch, and the file that held the withholding is gone.
 *
 * A `never` guard here would be the stronger shape and does not fit: the
 * list is deliberately a subset of `ParsedScope["kind"]`, so exhaustiveness
 * is the wrong property. What holds the subset honest is that every kind
 * excluded from it is held to its own map further down in this file.
 */
const DESCRIBED_KINDS = ["type", "edge", "metadata", "content"] as const;

/** What a person would see if nothing curated named this pattern. Rebuilt
 *  rather than imported because `scopeLiteralFor` is private to the
 *  renderer; sound here because the verb-less families it exists to handle
 *  are exactly the kinds this function is never called with. */
const literalOf = (scope: ParsedScope): string =>
  `${scope.typePattern}:${scope.operation}`;

/** The developer-facing sentence the description map falls through to, for
 *  the two kinds that have a registry behind them. */
function registryDescriptionFor(scope: ParsedScope): string | undefined {
  if (scope.kind === "edge") {
    return scope.edgeType
      ? EDGE_TYPE_REGISTRY.get(scope.edgeType)?.description
      : undefined;
  }
  if (scope.kind === "type") {
    return TYPE_REGISTRY.get(scope.typePattern)?.description;
  }
  // A metadata sub-resource is not a registered type, so nothing holds a
  // description for one and the curated map is the only possible source.
  return undefined;
}

/**
 * Why this pattern would reach a person as machine text, or `undefined`
 * where curated copy answers for it.
 *
 * Asked of `buildScopeDescriptions` — the call both routes make — rather
 * than of `CONSENT_SCOPE_DESCRIPTIONS` directly. Reading the map would
 * assert that somebody wrote a string, not that the string is what resolves;
 * the fallback chain sits between the two and is where the defect lived.
 */
function uncoveredBecause(
  scope: ParsedScope,
  descriptions: Record<string, string>,
): string | undefined {
  const shown = descriptions[scope.typePattern];
  const registry = registryDescriptionFor(scope);
  if (shown === undefined) {
    return (
      `nothing describes it. The device approval screen renders ` +
      `"${literalOf(scope)}" as the row, and the authorize screen's toggle ` +
      `reads "${humanizeType(scope.typePattern)}"`
    );
  }
  if (registry !== undefined && shown === registry) {
    return (
      `only the type registry describes it. The device approval screen ` +
      `renders ${String(registry.length)} characters written for a developer`
    );
  }
  return undefined;
}

interface UncoveredPattern {
  pattern: string;
  because: string;
  /**
   * Set on the entries this file invented rather than found: the injected
   * publisher root's pair. They are gaps in the same sense as the rest and
   * nobody can ever close them by writing a sentence, because the root is
   * synthetic, so they must not be counted as work outstanding on a
   * shipping surface. Anybody counting the gaps wants the number without
   * these two.
   */
  synthetic?: true;
}

/**
 * Patterns a client can request today that no curated copy answers for.
 *
 * **This list is a debt, not a policy.** Every entry is a scope somebody can
 * be asked to approve while being shown either a raw literal or a paragraph
 * of schema rationale. It is written down rather than filtered out because
 * the alternative shapes are both worse: narrowing the derived set puts the
 * fixture problem back one level up, and writing copy to make a test green
 * lands user-facing words in a change nobody reviews as words. Copy is
 * reviewed as copy or it is not reviewed.
 *
 * **Emptying it is the point, and the test below holds both halves of
 * that.** One half is that the list cannot outlive a gap: an entry whose
 * pattern has since been given copy is refused. The other half is that it
 * cannot be fed a new one, which needs a count rather than a per-entry
 * check, because every conceivable new entry is individually well-formed.
 * Without the count the escape hatch is a paste: delete a curated sentence,
 * add a plausible line here, and the surface has quietly shrunk again in
 * exactly the way this file exists to stop one level down.
 *
 * Three families, and they need different fixes. The first two are counted
 * separately because only one of them is work anybody can do.
 */
const KNOWN_UNCOVERED: readonly UncoveredPattern[] = [
  // ---------------------------------------------------------------------
  // SHIPPING NAMESPACE WILDCARDS, of which there are eleven. The registry
  // cannot close these at all: a wildcard matches at check time and reaches
  // types nobody has registered yet, so there is nothing for a map keyed on
  // concrete ids to return. Four are curated (`*`, `core.*`, `user.*`,
  // `app.*`) and the rest never were — the curated map predates the
  // wildcards being publishable.
  //
  // A per-wildcard entry closes today's set and reopens on the next
  // integration, so the fix is a rule that derives a wildcard's sentence
  // from its root, with the curated four kept where they say something a
  // rule cannot.
  // ---------------------------------------------------------------------
  {
    pattern: "edge.*",
    because:
      "The wildcard over every relationship type, explicitly published as " +
      "requestable and never described on either screen. The widest edge " +
      "grant expressible, rendered as its own literal.",
  },
  {
    pattern: "edge.user.*",
    because:
      "The relationship half of a space's own runtime types. `user.*` is " +
      "curated and its edge counterpart was not.",
  },
  {
    pattern: "edge.app.*",
    because:
      "The relationship half of the types an app defines for itself. " +
      "`app.*` is curated and its edge counterpart was not.",
  },
  {
    pattern: "google.*",
    because: "Integration namespace wildcard, never described.",
  },
  {
    pattern: "edge.google.*",
    because: "Integration namespace edge wildcard, never described.",
  },
  {
    pattern: "raindrop.*",
    because: "Integration namespace wildcard, never described.",
  },
  {
    pattern: "edge.raindrop.*",
    because: "Integration namespace edge wildcard, never described.",
  },
  {
    pattern: "readwise.*",
    because: "Integration namespace wildcard, never described.",
  },
  {
    pattern: "edge.readwise.*",
    because: "Integration namespace edge wildcard, never described.",
  },
  {
    pattern: "todoist.*",
    because: "Integration namespace wildcard, never described.",
  },
  {
    pattern: "edge.todoist.*",
    because: "Integration namespace edge wildcard, never described.",
  },

  // ---------------------------------------------------------------------
  // SYNTHETIC. The injected publisher root's pair, and the only two entries
  // here that name nothing this build ships. They are marked and counted
  // apart because a reader tallying the wildcard gaps wants ELEVEN, not
  // thirteen: `acme` is this file's fixture, so no sentence anybody writes
  // can close these, and a ticket that lists them is asking for work that
  // does not exist.
  //
  // They are still carried rather than filtered, because they are the one
  // instance proving the shape: the root arrives from the database at boot,
  // so no list written at authoring time can name it and only a derivation
  // rule reaches it. Whatever closes the eleven above has to close these
  // too, and if it cannot then it was a table rather than a rule.
  // ---------------------------------------------------------------------
  {
    pattern: `${RUNTIME_PUBLISHER_ROOT}.*`,
    synthetic: true,
    because:
      "A publisher root installed at boot. Unknowable when copy is " +
      "written, so only a derivation can describe it.",
  },
  {
    pattern: `edge.${RUNTIME_PUBLISHER_ROOT}.*`,
    synthetic: true,
    because:
      "The relationship half of a boot-installed publisher root. Same " +
      "reason as the pattern above.",
  },
];

const KNOWN_UNCOVERED_PATTERNS = new Set(KNOWN_UNCOVERED.map((u) => u.pattern));

describe("the consent copy guard derives the scopes it checks", () => {
  it("runs against registries and an allowlist that are actually populated", () => {
    // The registries are filled at boot from the generated type set, and a
    // guard that derives from an empty one enumerates nothing and reports a
    // confident pass. Every floor below is a precondition of the tests that
    // follow rather than a property worth asserting for its own sake.
    expect(TYPE_REGISTRY.size).toBeGreaterThan(20);
    expect(EDGE_TYPE_REGISTRY.size).toBeGreaterThan(4);
    expect(REQUESTABLE.length).toBeGreaterThan(100);
    expect(distinctPatterns(["metadata"]).length).toBeGreaterThan(2);
    expect(distinctPatterns(["edge"]).length).toBeGreaterThan(
      EDGE_TYPE_REGISTRY.size,
    );

    // The boot-installed half, which nothing in this process would provide
    // on its own. Both halves are asserted: that the injected root reached
    // the allowlist, and that it was not already there — a root the static
    // registry publishes would satisfy the first check while testing
    // nothing about the path that goes through the database.
    expect(REQUESTABLE_LITERALS).toContain(`${RUNTIME_PUBLISHER_ROOT}.*:read`);
    expect(REQUESTABLE_LITERALS).toContain(
      `edge.${RUNTIME_PUBLISHER_ROOT}.*:write`,
    );
    expect(buildAllowedScopes(getPermissionBundles(), [])).not.toContain(
      `${RUNTIME_PUBLISHER_ROOT}.*:read`,
    );
  });

  it("takes its set from the allowlist and the registries, not from a list", () => {
    // The separable half of this file. The coverage test below asserts a
    // property of whatever set it is handed and would pass just as happily
    // on three scopes somebody typed out; this one is what says the set is
    // the surface. Both are needed: the first without the second reports on
    // a subset, which is the defect, and the second without the first pins
    // a derivation nothing reads.
    expect([...REQUESTABLE_LITERALS].sort()).toEqual(
      buildAllowedScopes(getPermissionBundles(), [
        RUNTIME_PUBLISHER_ROOT,
      ]).sort(),
    );

    // Held against the sources as well as against the allowlist, so a
    // derivation that has quietly narrowed — a filter, a slice, a cached
    // literal list — fails here rather than shrinking what gets reviewed.
    for (const edgeType of EDGE_TYPE_REGISTRY.keys()) {
      expect(REQUESTABLE_LITERALS, edgeType).toContain(`edge.${edgeType}:read`);
    }
    for (const typeId of TYPE_REGISTRY.keys()) {
      expect(REQUESTABLE_LITERALS, typeId).toContain(`${typeId}:write`);
    }
  });

  it("shows a person words rather than a literal or the registry's prose", () => {
    const patterns = distinctPatterns(DESCRIBED_KINDS);
    const descriptions = buildScopeDescriptions(patterns);

    // Collected rather than thrown on the first failure. This is the list
    // whoever closes the gap works from, and a message naming one pattern
    // out of thirteen makes the work look thirteen times smaller than it is.
    const failures: string[] = [];
    for (const scope of patterns) {
      const because = uncoveredBecause(scope, descriptions);
      if (!because) continue;
      if (KNOWN_UNCOVERED_PATTERNS.has(scope.typePattern)) continue;
      failures.push(`${scope.typePattern}: ${because}`);
    }
    expect(failures.sort()).toEqual([]);
  });

  it("holds the known-uncovered list to its size and lets it only shrink", () => {
    // **The bound is the point of this test, not a tidiness check.**
    //
    // The per-entry checks below are each necessary and together they are
    // not sufficient, because every entry somebody might add tomorrow
    // satisfies all of them: a pattern that is requestable and genuinely
    // uncovered is exactly what a newly un-curated scope looks like. So the
    // hatch is a paste. Delete a sentence from the description map, add a
    // plausible line to the list, and the coverage check goes green over a
    // surface that has quietly shrunk — which is this ticket's own defect,
    // one level up from where it was found.
    //
    // A count is what closes it, because a count is the one property a
    // paste cannot satisfy. Held to equality rather than a ceiling: a
    // ceiling still admits a swap, one entry out and one entry in, and a
    // swap is the same silent narrowing wearing a stable number.
    //
    // So growth is a digit somebody had to change, which puts it in the
    // diff and in front of a reviewer. **Lowering these numbers is the
    // work**: closing the wildcards takes the first to zero, and writing
    // consent copy for the integration types takes the third to zero. The
    // synthetic pair goes when a derivation rule reaches it, and never by
    // anybody writing a sentence.
    //
    // Nothing today depends on this bound being right rather than merely
    // present, and that is luck rather than design. The description-map
    // tests in `consent-render.test.ts` hold the whole of both registries,
    // so every core, system and edge pattern is independently guarded and a
    // paste naming one would fail there instead. An integration shipping a
    // type outside `core.` and `system.` sits outside their reach, and is
    // the case this bound is actually for.
    const wildcards = KNOWN_UNCOVERED.filter((u) => u.pattern.endsWith(".*"));
    const synthetic = KNOWN_UNCOVERED.filter((u) => u.synthetic === true);
    expect(KNOWN_UNCOVERED).toHaveLength(13);
    expect(wildcards.filter((u) => !u.synthetic)).toHaveLength(11);
    expect(synthetic).toHaveLength(2);
    expect(
      KNOWN_UNCOVERED.filter((u) => !u.pattern.endsWith(".*")),
    ).toHaveLength(0);
    // Every synthetic entry is a wildcard, so the three counts partition the
    // list and no entry can be added to one bucket by leaving another.
    expect(synthetic.every((u) => u.pattern.endsWith(".*"))).toBe(true);

    // The per-entry half. An entry whose pattern has since been given copy
    // would go on suppressing a check that now passes, and an entry naming a
    // pattern no client can request would suppress a check that never ran —
    // both leave the list looking like work outstanding when it is not.
    const patterns = distinctPatterns(DESCRIBED_KINDS);
    const descriptions = buildScopeDescriptions(patterns);
    const byPattern = new Map(patterns.map((s) => [s.typePattern, s]));

    for (const entry of KNOWN_UNCOVERED) {
      expect(entry.because, entry.pattern).toMatch(/\S/);
      const scope = byPattern.get(entry.pattern);
      expect(scope, `${entry.pattern} is no longer requestable`).toBeDefined();
      if (!scope) continue;
      expect(
        uncoveredBecause(scope, descriptions),
        `${entry.pattern} now has copy — delete its entry`,
      ).toBeDefined();
    }
  });

  it("names an OIDC literal and a capability without the description map", () => {
    // Both renderers resolve these through their own maps and return before
    // the description map is read, so the check above cannot see them and
    // an unnamed one would render as its literal on the device screen.
    const oidc = distinctPatterns(["oidc"]);
    expect(oidc.length).toBeGreaterThan(3);
    for (const scope of oidc) {
      const literal = scope.oidcScope ?? scope.typePattern;
      expect(oidcLabel(literal), literal).toMatch(/\S/);
    }

    // No bundle emits a capability literal today, so this loop is usually
    // empty — which is why the set is also held directly below it. A
    // capability becoming requestable is the event that makes the loop
    // matter, and it should not be the event that first writes the check.
    for (const scope of distinctPatterns(["capability"])) {
      const capability = scope.capability ?? scope.typePattern;
      // Through the guard the device screen uses rather than an indexed
      // lookup, so a literal outside the closed set is answered rather than
      // asserted into a map that has no entry for it.
      expect(capabilityLabel(capability), capability).toMatch(/\S/);
    }
    expect(CAPABILITY_SCOPES.length).toBeGreaterThan(0);
    for (const literal of CAPABILITY_SCOPES) {
      expect(CAPABILITY_LABELS[literal], literal).toMatch(/\S/);
    }
  });

  it("resolves that copy through the screens, not only through the map", () => {
    // The map answering is not the same claim as a person reading it. The
    // renderers each have their own fallback chain between the two, and the
    // authorize screen's is what the description map is often not reached
    // through at all: `SCOPE_LABELS` wins where it has an entry.
    //
    // Rendered as one request rather than one page per scope, deliberately.
    // The allowlist publishes around 150 literals and a page each is not a
    // review anybody performs.
    const covered = distinctPatterns(DESCRIBED_KINDS).filter(
      (s) => !KNOWN_UNCOVERED_PATTERNS.has(s.typePattern),
    );
    expect(covered.length).toBeGreaterThan(40);
    const descriptions = buildScopeDescriptions(covered);

    const device = renderDeviceConsentScreen({
      clientName: "Fieldwork",
      scopes: covered,
      userCode: "ABCD-EFGH",
      descriptions,
    });
    const authorize = renderConsentScreen({
      clientName: "Fieldwork",
      clientId: "fieldwork-client",
      oauthQuery: "client_id=fieldwork-client&scope=...&sig=signed",
      scopes: covered,
      descriptions,
    });

    // Both screens escape what they print, and several curated sentences
    // carry an apostrophe, so the copy is escaped before it is looked for
    // rather than the assertions being written around the ones that do not.
    for (const scope of covered) {
      const copy = descriptions[scope.typePattern];
      // Positive first, and it is the half that keeps the negatives from
      // being satisfied by a row that never rendered at all.
      expect(copy ?? "", scope.typePattern).toMatch(/\S/);
      expect(device, scope.typePattern).toContain(escapeHtml(copy ?? ""));

      // The authorize screen resolves a row's label from the curated label
      // where there is one and from the description otherwise. Held to
      // whichever of those applies rather than to "not `humanizeType`":
      // `core.media.series` is curated as "Series" and humanizes to
      // "Series", so a check on the two differing would report a
      // coincidence as a defect.
      const label = SCOPE_LABELS[scope.typePattern] ?? copy ?? "";
      expect(authorize, scope.typePattern).toContain(escapeHtml(label));
    }
    // **No negative floor is asserted here, and the omission is deliberate
    // rather than an oversight to be corrected.** Two were written and both
    // were unreachable, which is worse than absent: an assertion that cannot
    // fire reads to the next person as a floor that is being held.
    //
    // On the authorize screen, `not.toContain("<span>" + literal + "<")`
    // cannot fire at all. `labelFor` falls `SCOPE_LABELS` → description →
    // `humanizeType`, and `humanizeType` returns a title-cased segment of
    // the pattern, so the literal is not a string that chain can produce.
    //
    // On the device screen the equivalent cannot fire because the positive
    // above already requires copy to have resolved, and the literal floor is
    // reached only when it did not. A floor that could fire would also have
    // to be written differently: `openEndedSuffixed` renders an uncovered
    // open-ended scope as `edge.*:read Also covers anything added later.`,
    // so matching on `<span>literal</span>` would miss the shape the gallery
    // snapshot actually shows.
    //
    // The floors are held where they can be, which is the coverage check
    // above: it asks the resolution rather than the markup, and it is what
    // reddens when copy goes missing.
  });
});
