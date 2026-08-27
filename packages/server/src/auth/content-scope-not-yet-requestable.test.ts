/**
 * The content category parses, projects and merges — and is not yet a scope
 * anybody can ask for.
 *
 * **This file is a withholding, not an oversight, and deleting it is the
 * plan.** `content:read` and `content:write` are absent from
 * {@link buildAllowedScopes} for one reason: neither consent surface can tell
 * a person which of the two they are approving. Both literals share the type
 * pattern `content`, and both screens resolve copy on that pattern rather
 * than on the whole literal, so the authorize screen renders one identical
 * toggle for the read level and the write level.
 *
 * **The device screen fails differently, and worse, and which failure it
 * shows depends on whether copy exists.** With none it prints the two bare
 * literals, `content:read` and `content:write`, legible only to somebody who
 * reads scope grammar — that is the state the gallery snapshots preview.
 * Write a sentence for the pattern and it prints ONE row rather than two:
 * `describeCapabilities` dedupes on the resolved string, and both literals
 * resolve the same string. So copy does not merely fail to distinguish the
 * levels there, it removes one of them from the screen, and a person
 * approving both is shown nothing that says a write was granted.
 *
 * A grant nobody can be asked for correctly is not one to make askable, and
 * the alternative to writing this down was leaving the literals published and
 * trusting that somebody would notice. Telling the levels apart needs a label
 * that carries its operation, which is a separate change — and the same
 * change is what ends the collapse, because two rows that resolve different
 * strings no longer dedupe into one.
 *
 * **What is NOT missing is the disclosure of the category's reach.**
 * {@link isOpenEnded} has an explicit arm for the kind and answers `true`, so
 * both screens already carry the sentence about reaching things that do not
 * exist yet. That is asserted below rather than assumed, because it is the
 * half of this that was silently wrong once and the same silence is what
 * publishing over would look like.
 *
 * **When the label change lands: publish the two literals in
 * `buildAllowedScopes`, and delete this file.** The label and description
 * tests here are the precondition, so they redden the moment the copy exists
 * — which is the signal that the withholding is now the wrong assertion
 * rather than the right one. `../routes/consent-copy-coverage.test.ts`
 * already lists `content` among the kinds it checks, so it takes over as the
 * guard on the same commit that publishes them.
 */
import { describe, it, expect } from "vitest";
import { expandBundlesToScopes, parseScope } from "@withmarfa/shared";
import type { ParsedScope, PermissionBundle } from "@withmarfa/shared";
import { buildAllowedScopes } from "./oauth-provider.js";
import { bundlePublishedScopes } from "./ceiling-catchup.js";
import { DEFAULT_PERMISSION_BUNDLES } from "../config.js";
import {
  CONSENT_SCOPE_DESCRIPTIONS,
  buildScopeDescriptions,
} from "../routes/auth-consent.js";
import { renderConsentScreen, SCOPE_LABELS } from "../routes/consent.js";
import { renderDeviceConsentScreen } from "../routes/device-pages.js";
import { escapeHtml } from "../routes/auth-html.js";
import { isOpenEnded } from "../routes/scope-openness.js";

const CONTENT_PATTERN = "content";
const CONTENT_LITERALS = ["content:read", "content:write"] as const;

/**
 * A bundle an operator could write today. `MARFA_PERMISSION_BUNDLES` is
 * arbitrary JSON and both readers below fold a bundle's scopes into what a
 * client may hold, so this is the shape that reaches past the shipped set —
 * and the shipped set is the only thing the rest of this file exercises.
 */
const CONFIGURED_CONTENT_BUNDLE: PermissionBundle[] = [
  {
    id: "everything",
    label: "Everything",
    description: "A bundle naming the content category.",
    scopes: [...CONTENT_LITERALS, "core.note:read"],
    default_on: false,
  },
];

const parsed = (literal: string): ParsedScope => {
  const scope = parseScope(literal);
  // Held rather than assumed: the withholding is about the allowlist, and a
  // build where the literals stopped parsing would satisfy every assertion
  // below for the wrong reason.
  if (!scope) throw new Error(`content literal no longer parses: ${literal}`);
  return scope;
};

describe("the content category is not yet requestable", () => {
  it("is withheld from the allowlist at every bundle configuration", () => {
    // Both call shapes, because they are separately reachable: the discovery
    // metadata advertises `buildAllowedScopes(undefined, [])` and the
    // provider validates against `buildAllowedScopes()`.
    for (const scopes of [
      buildAllowedScopes(),
      buildAllowedScopes(DEFAULT_PERMISSION_BUNDLES),
      buildAllowedScopes(DEFAULT_PERMISSION_BUNDLES, []),
    ]) {
      for (const literal of CONTENT_LITERALS) {
        expect(
          scopes,
          `${literal} is requestable. If the consent copy has landed, that is ` +
            `correct — delete this file. If it has not, a person can be asked ` +
            `to approve the widest grant in the grammar with no words for it.`,
        ).not.toContain(literal);
      }
      // Not reachable by another spelling either. `content.*:read` is the
      // shape that would otherwise parse as an ordinary subtree grant.
      expect(scopes.filter((s) => s.startsWith("content"))).toEqual([]);
    }
  });

  it("is offered by no bundle, which was already true and stays true", () => {
    // Independent of the allowlist and worth its own check: a bundle
    // referencing a scope is what folds that scope back into the allowlist,
    // so a bundle naming the category would undo the withholding above from
    // a file nobody reading this one would think to look at.
    const offered = new Set(expandBundlesToScopes(DEFAULT_PERMISSION_BUNDLES));
    for (const literal of CONTENT_LITERALS) {
      expect(offered.has(literal), literal).toBe(false);
    }
  });

  it("stays withheld when an operator's bundle names it", () => {
    // The vector the two tests above cannot see, because both ask the shipped
    // bundles. `buildAllowedScopes` folds every grammatically valid bundle
    // scope into the allowlist, and both content literals are grammatical, so
    // absence alone stopped enforcing the withholding the moment they started
    // parsing: before this build the grammar refused such a bundle and said
    // so. The explicit drop is what replaced that, and this is what holds it.
    const scopes = buildAllowedScopes(CONFIGURED_CONTENT_BUNDLE, []);
    for (const literal of CONTENT_LITERALS) {
      expect(
        scopes,
        `${literal} became requestable through a configured permission ` +
          `bundle. The withholding is enforced by a drop in the bundle loop, ` +
          `not by the literal's absence from the list above it.`,
      ).not.toContain(literal);
    }
    // The bundle's other scope still lands, so the drop is the literal's and
    // not the whole bundle silently going missing.
    expect(scopes).toContain("core.note:read");
  });

  it("stays out of what a bundle publishes into a client's ceiling", () => {
    // A second door into the same room, and the one that does not go through
    // the allowlist at all. `catchUpClientScopeCeiling` widens a client's
    // stored `auth_oauth_client.scopes` by the scopes a bundle publishes, and
    // every reader of that row is an exact membership test — so a literal
    // written there is one the vendored provider will accept on its own terms.
    const published = bundlePublishedScopes(CONFIGURED_CONTENT_BUNDLE);
    for (const literal of CONTENT_LITERALS) {
      expect(
        published.has(literal),
        `${literal} would be written into a client's stored scope ceiling. ` +
          `From there the provider's exact test admits it and the person is ` +
          `shown a grant nothing can describe.`,
      ).toBe(false);
    }
    expect(published.has("core.note:read")).toBe(true);
  });

  it("has no curated label to tell its two levels apart", () => {
    // The authorize screen keys labels on the type pattern, and both literals
    // carry the same one, so a single entry here would render read and write
    // identically. An entry appearing is the copy landing.
    expect(
      SCOPE_LABELS[CONTENT_PATTERN],
      "the content category now has a label — publish the literals and " +
        "delete this file",
    ).toBeUndefined();
  });

  it("has no description either screen could show", () => {
    // The map, because that is where the copy gets written and an entry
    // appearing has to redden something. `describeScope` resolves the content
    // arm out of this map the way the metadata arm does, so an entry here is
    // copy on both screens the moment somebody adds it — which is exactly the
    // signal this file exists to give.
    expect(
      CONSENT_SCOPE_DESCRIPTIONS[CONTENT_PATTERN],
      "the content category now has a description — publish the literals " +
        "and delete this file",
    ).toBeUndefined();
    // And what the renderers actually ask for, which is a second question:
    // the fallback chain sits between the map and the screen, and it is where
    // copy went missing once before.
    const descriptions = buildScopeDescriptions(
      CONTENT_LITERALS.map((l) => parsed(l)),
    );
    expect(
      descriptions[CONTENT_PATTERN],
      "the content category now resolves a description — publish the " +
        "literals and delete this file",
    ).toBeUndefined();
  });

  it("carries copy through to both screens the moment the map holds it", () => {
    // The test above says nothing is written. This one says writing it is
    // enough, and the two are different claims: an arm returning `undefined`
    // outright satisfies the first forever and makes the second impossible.
    // That is the shape the withholding took at one point — a hard return in
    // `describeScope` with a comment sending whoever lands the copy to the
    // maps, where writing it would have changed nothing on either surface.
    // The entry is injected rather than shipped so this reddens on the arm
    // regressing, not on the copy arriving.
    //
    // **Rendered rather than resolved, and the difference is the whole of
    // what this test is worth.** `buildScopeDescriptions` answering is not a
    // person reading the answer: each renderer has its own fallback chain
    // between the map and the markup, and the map is one link in it. An
    // earlier version of this test stopped at the returned record, and it
    // stayed green under the mutation it names itself after — delete
    // `descriptions?.[scope.typePattern]` from `labelFor` and
    // `descriptions?.[s.typePattern]` from `describeCapabilities`, so that
    // neither screen reads the map at all, and the record still holds the
    // string. Both screens are rendered here so that mutation reddens.
    const written = "Everything you have stored, except the platform's own.";
    const escaped = escapeHtml(written);
    const occurrences = (html: string): number =>
      html.split(escaped).length - 1;

    CONSENT_SCOPE_DESCRIPTIONS[CONTENT_PATTERN] = written;
    try {
      const scopes = CONTENT_LITERALS.map((l) => parsed(l));
      const descriptions = buildScopeDescriptions(scopes);
      expect(
        descriptions[CONTENT_PATTERN],
        `a \`${CONTENT_PATTERN}\` entry in CONSENT_SCOPE_DESCRIPTIONS does ` +
          `not resolve. Both renderers read this family out of the map this ` +
          `builds, so copy written for it is discarded before either screen ` +
          `is reached.`,
      ).toBe(written);

      const authorize = renderConsentScreen({
        clientName: "Fieldwork",
        clientId: "fieldwork-client",
        oauthQuery: "client_id=fieldwork-client&scope=...&sig=signed",
        scopes,
        descriptions,
      });
      const device = renderDeviceConsentScreen({
        clientName: "Fieldwork",
        scopes,
        userCode: "ABCD-EFGH",
        descriptions,
      });

      expect(
        authorize,
        `the authorize screen does not print a \`${CONTENT_PATTERN}\` ` +
          `description. Its row falls SCOPE_LABELS → description → ` +
          `humanizeType, and nothing curates this family, so losing the ` +
          `middle link leaves the widest grant in the grammar labelled with ` +
          `a title-cased fragment of its own pattern.`,
      ).toContain(escaped);
      expect(
        device,
        `the device approval screen does not print a ` +
          `\`${CONTENT_PATTERN}\` description. Its row is the description ` +
          `or the bare literal, and this screen has no labels to fall back ` +
          `on, so losing that link is the difference between a sentence and ` +
          `\`content:read\`.`,
      ).toContain(escaped);

      // The device screen's negative floor, and it can fire: that screen
      // renders no form fields carrying scope literals, so a literal in its
      // markup is the fallback having been taken. The authorize screen has
      // no equivalent — it submits each grant as a checkbox whose value is
      // the literal, so the literal is in its markup either way and a floor
      // written there would assert nothing.
      for (const literal of CONTENT_LITERALS) {
        expect(
          device,
          `${literal} is printed raw on the device approval screen while ` +
            `copy for it resolves. The description is not reaching the row.`,
        ).not.toContain(literal);
      }

      // **The two rows become one, and that is a property of this family
      // rather than an artifact of the fixture.** `describeCapabilities`
      // dedupes on the resolved string, and both literals resolve the same
      // one, so copy does not merely fail to tell the levels apart on this
      // screen — it removes a level from it. With no copy the screen shows
      // two rows, `content:read` and `content:write`; with copy it shows
      // one, and nothing on it says a write was granted.
      //
      // This is why the withholding is the right call rather than a
      // cautious one, and it is asserted here because it is the half a
      // reader of the gallery snapshots cannot see: the snapshots preview
      // the pre-copy state, where two rows exist. Publishing the literals
      // therefore takes more than writing a sentence. It takes a row label
      // that carries its operation, at which point the two resolve
      // differently and the dedupe stops matching them.
      expect(
        occurrences(device),
        `the device approval screen no longer collapses the two content ` +
          `levels into one row. If a label now carries its operation, that ` +
          `is the change this file is waiting for — publish the literals ` +
          `and delete it.`,
      ).toBe(1);
      expect(
        occurrences(authorize),
        `the authorize screen no longer renders a row per content level. ` +
          `It groups read and write apart, so both rows survive there, and ` +
          `the contrast with the device screen above is the point.`,
      ).toBe(2);
    } finally {
      Reflect.deleteProperty(CONSENT_SCOPE_DESCRIPTIONS, CONTENT_PATTERN);
    }
  });

  it("does disclose its own reach, which is the half that is not missing", () => {
    // Not a property of the withholding — a property this file records so
    // that publishing later cannot quietly regress it. `isOpenEnded` reached
    // the wrong answer here once, by having no arm for the kind at all and
    // sending it down the pattern path: `content` is not the global wildcard,
    // carries no subtree wildcard, and projects nothing into the metadata
    // permission map, so the widest grant in the grammar reported `false` and
    // both screens went silent about its reach. The explicit arm is what
    // fixed it, and this is what holds the fix.
    for (const literal of CONTENT_LITERALS) {
      expect(
        isOpenEnded(parsed(literal)),
        `${literal} no longer reports as open-ended. The category reaches ` +
          `every non-system type including ones registered after the grant, ` +
          `so both consent screens must say so.`,
      ).toBe(true);
    }
  });
});
