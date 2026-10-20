import { describe, it, expect, afterEach } from "vitest";
import type { ParsedScope } from "@withmarfa/shared";
import { parseScope } from "@withmarfa/shared";
import {
  renderConsentScreen,
  renderDeviceConsentScreen,
} from "./test-render.js";
import { SCOPE_LABELS } from "./scope-copy.js";
import {
  PERMISSIONS,
  EDGE_TYPE_REGISTRY,
  seedPlatformTypes,
  shippedPlatformTypes,
  TYPE_REGISTRY,
} from "@withmarfa/shared";
import { PERMISSION_LABELS } from "./permission-labels.js";
import { buildAllowedScopes } from "../auth/oauth-provider.js";
import {
  buildScopeDescriptions,
  CONSENT_SCOPE_DESCRIPTIONS,
} from "./auth-consent.js";
import { deriveWildcardDescription } from "./wildcard-copy.js";
import { visibleText } from "../test-html.js";

afterEach(() => {
  // `TYPE_REGISTRY` is a module-level binding every suite in this process
  // shares, and one case below seeds a retired platform row into it.
  seedPlatformTypes(shippedPlatformTypes());
});

const SIGNED_OAUTH_QUERY =
  "response_type=code&client_id=client-abc&redirect_uri=http%3A%2F%2Flocalhost%2Fcallback&scope=core.note%3Aread&state=abc&code_challenge=def&code_challenge_method=S256&exp=1778957000&sig=somesignaturehash";

const PARAMS = {
  clientName: "Test CLI",
  clientId: "client-abc",
  oauthQuery: SIGNED_OAUTH_QUERY,
};

describe("consent copy names only types that exist", () => {
  it("has no label or description for a concrete type the registry does not hold", () => {
    // Coverage runs from type to copy; this runs the other way, so a
    // sentence left behind for a removed type fails rather than waiting for
    // a scope nobody can request.
    const concrete = (key: string) =>
      /^(core|system)\.[^*]+$/.test(key) && !key.endsWith(".*");
    const keys = [
      ...Object.keys(SCOPE_LABELS),
      ...Object.keys(CONSENT_SCOPE_DESCRIPTIONS),
    ].filter(concrete);
    // Witness: both maps name concrete types, so the filter reached rows.
    expect(keys).toContain("core.note");
    expect(keys).toContain("system.connection");
    for (const key of keys) {
      expect(TYPE_REGISTRY.has(key), `${key} names no shipped type`).toBe(true);
    }
  });
});

// The description axis: one answer per scope, whichever screen asks.
//
// Distinct from the label maps above, and the distinction is what the
// renderer runs on. A label is the short name on a toggle row; a description
// is the plain-English line, and a row falls back from the first to the
// second. One map holds descriptions, so nothing can disagree about whether a
// metadata scope or a wildcard gets one.
// ---------------------------------------------------------------------------

/** Throws rather than filtering, so a fixture typo cannot leave an empty
 *  scope list and quietly satisfy an assertion about what is absent. */
const parse = (literal: string): ParsedScope => {
  const parsed = parseScope(literal);
  if (!parsed) throw new Error(`unparseable scope literal: ${literal}`);
  return parsed;
};

const describeAll = (...literals: string[]): Record<string, string> =>
  buildScopeDescriptions(literals.map(parse));

describe("buildScopeDescriptions covers every kind a person can be shown", () => {
  it("describes the metadata scopes instead of skipping them", () => {
    // The skip rested on these being self-explanatory to whoever requests
    // them. Whoever requests them is not who reads the screen.
    const out = describeAll("metadata:read", "metadata.types:write");
    expect(out.metadata).toMatch(/\S/);
    expect(out["metadata.types"]).toBe("Custom data types on your server.");
  });

  it("names what a metadata scope reaches rather than what it permits", () => {
    // One entry serves both operations, because `typePattern` carries no
    // verb: `metadata.types:read` and `metadata.types:write` read the same
    // line. All three lines opened "Register and update", so a person
    // approving a read was shown a sentence about writing, which is the
    // direction that matters on the screen where they decide whether to
    // trust an app.
    //
    // Asked of the allowlist for the same reason the test below is: the
    // fourth sub-resource has to arrive here rather than on a screen.
    //
    // Scoped to the metadata entries deliberately, and the reason is about
    // this family rather than about the rest of the map. Every metadata line
    // is a plain noun phrase, so the leading word settles the question on its
    // own. Elsewhere the map is written to no such rule, and a leading-word
    // check applied across it would be testing a convention nothing else
    // holds — passing or failing on how an entry happens to open rather than
    // on whether it names an act.
    const metadata = buildAllowedScopes()
      .map(parse)
      .filter((s) => s.kind === "metadata");
    const out = buildScopeDescriptions(metadata);
    expect(Object.keys(out)).toHaveLength(
      new Set(metadata.map((s) => s.typePattern)).size,
    );
    for (const [pattern, copy] of Object.entries(out)) {
      expect(copy, `${pattern} opens with an act`).not.toMatch(
        /^(?:register|update|create|add|change|edit|delete|remove|manage|set|read|write)\b/i,
      );
    }
  });

  it("describes every metadata scope a client can actually request", () => {
    // Asked of the allowlist rather than a list beside it, so a third
    // sub-resource added to the grammar arrives here without copy and fails,
    // rather than reaching a screen as its own literal. `metadata.edge_types`
    // is why: it has been requestable as long as `metadata.types` has, and
    // the map that described one had never heard of the other.
    const metadata = buildAllowedScopes()
      .map(parse)
      .filter((s) => s.kind === "metadata");
    expect(metadata.length).toBeGreaterThan(2);
    const out = buildScopeDescriptions(metadata);
    for (const scope of metadata) {
      expect(out[scope.typePattern], scope.typePattern).toMatch(/\S/);
    }
  });

  it("describes every edge type a client can actually request", () => {
    // The axis that actually had the gap. `in-collection` is a shipping core
    // edge, `buildAllowedScopes` publishes `edge.in-collection:read|write`,
    // and nothing curated described it, so the builder fell through to the
    // registry and roughly 700 characters of schema rationale rendered as a
    // row on the device approval screen.
    //
    // Derived from `EDGE_TYPE_REGISTRY` rather than from a list beside it,
    // so a tenth edge type fails here rather than shipping a paragraph. And
    // held to being the curated line rather than to being non-empty: the
    // fallback is non-empty too, which is the whole defect, so a presence
    // check would have admitted the very thing it was meant to catch.
    const edges = [...EDGE_TYPE_REGISTRY.keys()];
    expect(edges.length).toBeGreaterThan(4);
    const out = buildScopeDescriptions(
      edges.map((edgeType) => parse(`edge.${edgeType}:read`)),
    );
    for (const edgeType of edges) {
      const registry = EDGE_TYPE_REGISTRY.get(edgeType)?.description;
      expect(
        registry,
        `fixture assumes the registry describes ${edgeType}`,
      ).toMatch(/\S/);
      expect(out[`edge.${edgeType}`], edgeType).toMatch(/\S/);
      expect(out[`edge.${edgeType}`], edgeType).not.toBe(registry);
    }
  });

  it("describes every type it ships without reaching the registry", () => {
    // The other half of the claim the map's docstring makes, asked of
    // `TYPE_REGISTRY` rather than read off the map, and asked of the whole
    // registry with no exemption: an uncurated type reaches a person as the
    // schema's own rationale on the screen where they decide whether to
    // trust an application. A type added to the shipped set with no curated
    // sentence fails here, and it cannot be waved through from
    // `consent-copy-coverage.test.ts`, because that file's known-uncovered
    // list is not read here.
    const shipped = [...TYPE_REGISTRY.keys()];
    // Both families, so a filter on the line above cannot pass every
    // assertion below on whatever survived it.
    expect(shipped.some((id) => id.startsWith("core."))).toBe(true);
    expect(shipped.some((id) => id.startsWith("system."))).toBe(true);
    const out = buildScopeDescriptions(
      shipped.map((id) => parse(`${id}:read`)),
    );
    for (const typeId of shipped) {
      const registry = TYPE_REGISTRY.get(typeId)?.description;
      expect(
        registry,
        `fixture assumes the registry describes ${typeId}`,
      ).toMatch(/\S/);
      expect(out[typeId], typeId).toMatch(/\S/);
      expect(out[typeId], typeId).not.toBe(registry);
    }
  });

  it("describes a wildcard, which nothing else can", () => {
    const out = describeAll(
      "*:read",
      "core.*:read",
      "user.*:read",
      "app.*:read",
    );
    expect(Object.keys(out).sort()).toEqual(["*", "app.*", "core.*", "user.*"]);
    for (const [pattern, copy] of Object.entries(out)) {
      expect(copy, pattern).toMatch(/\S/);
    }
    // A publisher wildcard is derived from its root rather than curated,
    // which is the only shape that reaches a root installed at boot. Held
    // to naming the service and to NOT being any concrete type's copy: the
    // failure this replaces would be one matched type's sentence standing
    // in for a whole namespace, and a bare non-empty check admits that.
    const derived = describeAll("acme.*:read")["acme.*"];
    expect(derived).toContain("Acme");
    for (const id of TYPE_REGISTRY.keys()) {
      expect(derived, id).not.toBe(TYPE_REGISTRY.get(id)?.description);
    }
  });

  it("derives a wildcard for a root this build has never heard of", () => {
    // The property that makes the rule a rule. `buildAllowedScopes` folds in
    // publisher roots boot installs from the `types` table, so a
    // wildcard can reach a consent screen on a running instance that no list
    // written here could name. A table closes today's set and reopens on the
    // next connector; this is the case that tells the two apart.
    //
    // The root is deliberately hyphenated, because the display name is the
    // half a person reads.
    const out = describeAll("acme-corp.*:read", "edge.acme-corp.*:read");
    expect(out["acme-corp.*"]).toBe(
      "Everything Acme Corp saves on your server.",
    );
    expect(out["edge.acme-corp.*"]).toBe("How Acme Corp connects your items.");

    // The precondition, because both assertions pass vacuously against a
    // build that happened to ship this root: it must be unknown here.
    expect(TYPE_REGISTRY.has("acme-corp")).toBe(false);
    expect(
      [...TYPE_REGISTRY.keys()].some((id) => id.startsWith("acme-corp.")),
    ).toBe(false);
  });

  it("declines to derive a sentence for a structural root", () => {
    // The arm that keeps the rule off the roots the map curates. Without it
    // a deleted curated entry does not go missing, it goes wrong: `core.*`
    // would read as a service called "Core" rather than as the standard
    // content types, and nothing else in this file would notice.
    for (const pattern of ["core.*", "user.*", "app.*", "marfa.*", "*"]) {
      expect(deriveWildcardDescription(pattern), pattern).toBeUndefined();
    }
    // A subtree of a root is not a root. Not requestable today, and a
    // sentence that becomes nonsense the moment it is would be worse than
    // none.
    expect(deriveWildcardDescription("core.media.*")).toBeUndefined();
  });

  it("cannot get a wildcard's copy from the type registry", () => {
    // The premise the wildcard arm does not rely on, pinned so that a
    // registry which started answering patterns fails here and points at the
    // arm rather than shipping one type's sentence as a namespace's.
    for (const pattern of ["*", "core.*", "user.*", "app.*"]) {
      expect(TYPE_REGISTRY.get(pattern), pattern).toBeUndefined();
    }
  });

  it("leaves a permission out, because both screens name one without it", () => {
    // The row title, which both screens take from `scopeTitle`, resolves a
    // permission through `permission-labels.ts` and returns before
    // it reaches this map, so an entry would be computed and discarded on
    // every render. That is the whole reason the map has nothing for one.
    //
    // Held by rendering with no map at all rather than by asserting what the
    // map holds. The absence is only safe while both screens still name a
    // permission unaided, and asserting the absence alone would pass
    // equally well on a screen that had started needing an entry and lost the
    // words.
    expect(PERMISSIONS.length).toBeGreaterThan(0);
    const scopes = PERMISSIONS.map(parse);
    expect(buildScopeDescriptions(scopes)).toEqual({});

    const authorize = renderConsentScreen({
      clientName: "Test CLI",
      clientId: "client-abc",
      oauthQuery: SIGNED_OAUTH_QUERY,
      scopes,
    });
    const device = renderDeviceConsentScreen({
      clientName: "Test CLI",
      scopes,
      userCode: "ABCD-EFGH",
    });

    for (const literal of PERMISSIONS) {
      expect(visibleText(authorize), literal).toContain(
        PERMISSION_LABELS[literal],
      );
      expect(visibleText(device), literal).toContain(
        PERMISSION_LABELS[literal],
      );
    }
  });

  it("answers nothing for an OIDC literal", () => {
    // The row title, which both screens take from `scopeTitle`, resolves one
    // through `oidc-labels.ts` and returns before it reaches this
    // map, so an entry would be computed and discarded on every render.
    expect(describeAll("openid", "profile", "email", "offline_access")).toEqual(
      {},
    );
  });

  it("prefers curated copy to the registry's, and falls back to it", () => {
    // The fallback cannot serve a type registered at runtime: such a
    // registration goes to an overlay that `TYPE_REGISTRY` does not expose,
    // and a custom type is not requestable as a row of its own anyway, only
    // through its namespace wildcard. Every shipped type is curated, so a
    // fixture drawn from the shipped set would prove the opposite.
    //
    // The population that remains is a platform row this build does not
    // ship. `seedPlatformTypes` refills the registry at boot from the rows
    // the instance holds, so an instance carrying a retired type resolves
    // it here, and no curated sentence can ever exist for it. That is what
    // this seeds.
    const retired = {
      schema: {
        id: "acme.retired_widget",
        version: 1,
        fields: {},
        description:
          "A widget shape a previous build shipped and this one does not.",
      },
      family: "core" as const,
    };
    seedPlatformTypes([...shippedPlatformTypes(), retired]);

    // Preconditions, because every assertion below passes vacuously without
    // them: the seed has to have taken, and the row has to be uncurated.
    expect(TYPE_REGISTRY.get(retired.schema.id)?.description).toBe(
      retired.schema.description,
    );
    expect(CONSENT_SCOPE_DESCRIPTIONS[retired.schema.id]).toBeUndefined();

    const out = describeAll("core.note:read", `${retired.schema.id}:read`);
    // The registry's own sentence is written for a developer reading API
    // docs, so both screens show the curated one.
    expect(out["core.note"]).toBe("Notes.");
    expect(out["core.note"]).not.toBe(
      TYPE_REGISTRY.get("core.note")?.description,
    );
    expect(out[retired.schema.id]).toBe(retired.schema.description);
  });

  it("does not let one kind read another kind's copy off the flat map", () => {
    // `typePattern` carries a different namespace per kind, so one map across
    // four kinds is only sound while no two can produce the same key. The
    // edge entries were keyed on the bare edge type id, where `*` is an edge
    // type the scope allowlist publishes and `metadata` is a name an edge
    // type can be registered under. Both would have read the type axis's copy
    // the moment the wildcard entries landed beside them.
    const out = describeAll("*:read", "edge.*:read", "edge.metadata:read");
    expect(out["*"]).toBe("Everything on your server.");
    // `edge.*` has copy of its own now, which makes this check sharper
    // rather than weaker: the failure it guards is `edge.*` resolving the
    // TYPE axis's sentence off the flat map, and an undefined could never
    // have told that apart from the entry simply not existing yet. Now it
    // can, so the assertion is inequality against the string it must not be.
    expect(out["edge.*"]).toBe("How everything on your server is connected.");
    expect(out["edge.*"]).not.toBe(out["*"]);
    expect(out["edge.metadata"]).toBeUndefined();
    // The curated edge copy still resolves, keyed on the pattern. Held
    // against the registry's line rather than against emptiness: revert the
    // `edge.` prefix on these keys and the lookup falls through to
    // `EDGE_TYPE_REGISTRY`, whose description is also non-empty, so a
    // `toMatch(/\S/)` here admitted the broken keying it was written to
    // pin.
    const registry = EDGE_TYPE_REGISTRY.get("parent-of")?.description;
    expect(
      registry,
      "fixture assumes the registry describes parent-of",
    ).toMatch(/\S/);
    const curated = describeAll("edge.parent-of:write")["edge.parent-of"];
    expect(curated).toMatch(/\S/);
    expect(curated).not.toBe(registry);
  });

  it("keeps an edge type's schema rationale off both screens", () => {
    // `in-collection` is the instance the derived test above generalizes,
    // and this is what it looked like where a person met it: a paragraph
    // about containment models, cardinality and cascade behavior, rendered
    // as one row of a consent decision.
    //
    // Asserted on a leading fragment rather than on the whole registry
    // string, because both renderers escape what they print and the
    // description carries an apostrophe. Matching the raw string would pass
    // on a screen that was showing the paragraph in full, which is the
    // failure this is here to see.
    const registry = EDGE_TYPE_REGISTRY.get("in-collection")?.description ?? "";
    const fragment = registry.split(/["'&<>]/)[0] ?? "";
    expect(
      fragment.length,
      "fixture assumes a long unescaped run of registry copy",
    ).toBeGreaterThan(40);

    const scopes = [parse("edge.in-collection:read")];
    const descriptions = buildScopeDescriptions(scopes);
    const curated = descriptions["edge.in-collection"];
    expect(curated).toMatch(/\S/);
    expect(curated).not.toBe(registry);

    const authorize = renderConsentScreen({ ...PARAMS, scopes, descriptions });
    const device = renderDeviceConsentScreen({
      clientName: "Test CLI",
      scopes,
      userCode: "ABCD-EFGH",
      descriptions,
    });
    for (const html of [authorize, device]) {
      expect(visibleText(html)).toContain((curated ?? "").replace(/\.$/, ""));
      expect(visibleText(html)).not.toContain(fragment);
    }
  });
});

describe("the authorize screen and the device screen describe a scope alike", () => {
  // Literals with no `SCOPE_LABELS` entry, which is the population this
  // describes: a literal with a curated label renders the label on the
  // authorize screen where this fixture needs the description.
  // `edge.about:read` stands for the family that has no labels at all.
  const UNLABELED = ["edge.about:read", "core.*:read", "app.*:read"];

  it("renders the same copy on both, from the one map", () => {
    const scopes = UNLABELED.map(parse);
    const descriptions = buildScopeDescriptions(scopes);
    // Every literal described, or the loop below asserts over less than it
    // reads as asserting over.
    expect(Object.keys(descriptions)).toHaveLength(UNLABELED.length);

    const authorize = renderConsentScreen({ ...PARAMS, scopes, descriptions });
    const device = renderDeviceConsentScreen({
      clientName: "Test CLI",
      scopes,
      userCode: "ABCD-EFGH",
      descriptions,
    });

    for (const [pattern, copy] of Object.entries(descriptions)) {
      // A sentence titles its row without the full stop.
      const title = copy.replace(/\.$/, "");
      expect(visibleText(authorize), pattern).toContain(title);
      expect(visibleText(device), pattern).toContain(title);
    }
  });
});
