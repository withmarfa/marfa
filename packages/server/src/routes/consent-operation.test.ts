/**
 * A consent row says what an app may do, not only what it may reach.
 *
 * Every term in both surfaces' copy chains is keyed on the type pattern, and
 * a type pattern carries no verb. So `core.note:read` and `core.note:write`
 * resolved to the same string on both screens, and what told them apart was
 * which section of the layout each row landed in — a property of the
 * arrangement, invisible to anything reading a row on its own, and the
 * reason the "Already allowed" section could not be shortened without losing
 * the distinction entirely.
 *
 * **Written against a merged section rather than against today's layout**,
 * because today's layout is exactly what was standing in for the label. The
 * cases below put both operations for one type in one group, which is what
 * the default bundles happen never to do, and hold the rows apart there.
 */
import { describe, it, expect } from "vitest";
import type { ParsedScope, PermissionBundle } from "@withmarfa/shared";
import { parseScope } from "@withmarfa/shared";
import { renderConsentScreen } from "./consent.js";
import { renderDeviceConsentScreen } from "./device-pages.js";
import { buildScopeDescriptions } from "./auth-consent.js";
import { buildDefaultPermissionBundles } from "../auth/default-bundles.js";
import { scopeOperation } from "./scope-operation.js";

const parse = (literal: string): ParsedScope => {
  const parsed = parseScope(literal);
  if (!parsed) throw new Error(`unparseable: ${literal}`);
  return parsed;
};

/**
 * A single bundle claiming both operations over one type, which is the
 * merged section the acceptance is written about. Passing it as `bundles`
 * reaches the same code path a future density fix would, so the guarantee is
 * tested rather than inferred from the arrangement that happens to ship.
 */
const MERGED_BUNDLE: PermissionBundle[] = [
  {
    id: "everything",
    label: "Your content",
    description: "One tile holding both halves of the grant.",
    scopes: ["core.note:read", "core.note:write"],
    default_on: true,
  },
];

const authorize = (
  scopes: ParsedScope[],
  extra: Partial<Parameters<typeof renderConsentScreen>[0]> = {},
): string =>
  renderConsentScreen({
    clientName: "Fieldwork",
    clientId: "fieldwork",
    oauthQuery: "sig=signed",
    scopes,
    descriptions: buildScopeDescriptions(scopes),
    ...extra,
  });

const device = (scopes: ParsedScope[]): string =>
  renderDeviceConsentScreen({
    clientName: "Fieldwork",
    userCode: "ABCD-EFGH",
    scopes,
    descriptions: buildScopeDescriptions(scopes),
  });

/** Every toggle row's label, with the second line stripped and the group it
 *  sat in discarded — which is the whole question this file asks. */
const rowLabels = (html: string): string[] =>
  [
    ...html.matchAll(
      /<div class="subrow"><span>(.*?)<\/span><label class="sw">/g,
    ),
  ]
    .map((m) => (m[1] ?? "").replace(/<span class="rmeta".*$/, ""))
    .map((s) => s.replace(/&#39;/g, "'").replace(/&amp;/g, "&"));

/** Every group summary sentence, likewise without its heading. */
const summaries = (html: string): string[] =>
  [...html.matchAll(/<span class="gdesc">([^<]*)<\/span>/g)].map(
    (m) => m[1] ?? "",
  );

/** Every line on the device screen. The rows are toggles now and share the
 *  authorize screen's row markup, so the class moved with them. */
const deviceLines = (html: string): string[] =>
  [...html.matchAll(/<div class="subrow"><span>([^<]*)<\/span>/g)].map((m) =>
    (m[1] ?? "").replace(/&#39;/g, "'").replace(/&amp;/g, "&"),
  );

describe("a consent row states the operation, not only the type", () => {
  /**
   * **The mutation check.** Drop the operation from the label and this is
   * the case that reddens: both rows resolve to "Notes" and the two
   * assertions below become one string tested against itself.
   */
  it("tells a read grant and a write grant over one type apart from the label alone", () => {
    const labels = rowLabels(
      authorize([parse("core.note:read"), parse("core.note:write")]),
    );
    expect(labels).toHaveLength(2);
    const [first, second] = labels;
    expect(first).not.toBe(second);
    // Not merely different: each says which of the two it is, so a reader
    // meeting one row on its own can answer the question.
    expect(labels).toContain("Notes (read only)");
    expect(labels).toContain("Notes (read and write)");
  });

  it("keeps them apart when the sections that separated them are merged", () => {
    const html = authorize(
      [parse("core.note:read"), parse("core.note:write")],
      { bundles: MERGED_BUNDLE },
    );
    // One tile, so the layout is contributing nothing.
    expect(summaries(html)).toHaveLength(1);
    const labels = rowLabels(html);
    expect(labels).toEqual(["Notes (read only)", "Notes (read and write)"]);
  });

  it("does not let a group summary de-duplicate the two into one word", () => {
    // `summarize` skipped a name it had already seen, and the name was
    // resolved from the type pattern alone, so a group holding both halves
    // of a grant summarized as though it held one word — the same word a
    // read-only request produced. It now says the stronger of the two, which
    // is the whole truth about the pair, and still cannot be mistaken for
    // the read-only request. Asserted on the merged bundle because that is
    // where the two can meet.
    const [summary] = summaries(
      authorize([parse("core.note:read"), parse("core.note:write")], {
        bundles: MERGED_BUNDLE,
      }),
    );
    expect(summary).toBe("Notes. Read and write.");

    // And the read-only half of the same request must not summarize
    // identically to the both-halves request, which is what it did. Both
    // take the group-level sentence, because after the collapse each group
    // has one thing to say; what separates them is the sentence itself.
    const [readOnly] = summaries(
      authorize([parse("core.note:read")], { bundles: MERGED_BUNDLE }),
    );
    expect(readOnly).toBe("Notes. Read only.");
    expect(readOnly).not.toBe(summary);
  });

  it("collapses a pattern held at both operations and nothing else", () => {
    // The collapse is keyed on the pattern rather than on the word, so two
    // separate grants stay two names even where one carries write. Merging
    // them would claim write over the one that only has read.
    const bundles: PermissionBundle[] = [
      {
        id: "pair",
        label: "Your content",
        description: "Two different types, one of them writable.",
        scopes: ["core.note:read", "core.task:write"],
        default_on: true,
      },
    ];
    const [summary] = summaries(
      authorize([parse("core.note:read"), parse("core.task:write")], {
        bundles,
      }),
    );
    expect(summary).toBe("Notes (read only) and Tasks (read and write).");
  });

  it("states a shared operation once for the group rather than on every name", () => {
    // A summary describes its group, so a property every member shares is
    // the group's rather than each name's. The distinction still survives:
    // a group where every scope permits the same thing has no two rows that
    // differ in operation to lose.
    const [summary] = summaries(
      authorize([parse("core.note:read"), parse("core.task:read")]),
    );
    expect(summary).toBe("Notes and Tasks. Read only.");
  });

  it("says the same thing about one grant on the device screen", () => {
    // That screen has no sections and no second line: one
    // sentence per grant is the whole of what it says, and it de-duplicated
    // on that sentence, so a read and a change over one type arrived as a
    // single row saying neither.
    const lines = deviceLines(
      device([parse("core.note:read"), parse("core.note:write")]),
    );
    expect(lines).toEqual(["Notes. Read only.", "Notes. Read and write."]);
  });

  it("uses one vocabulary across both surfaces", () => {
    // The two screens render nothing alike, so what has to agree is the
    // word. A read grant that is "read only" on one and something else on
    // the other is the state this whole module exists to make
    // unrepresentable.
    const scopes = [parse("core.note:read"), parse("core.note:write")];
    const rows = rowLabels(authorize(scopes)).join(" | ");
    const lines = deviceLines(device(scopes)).join(" | ");
    // Case-folded: the row form sits mid-phrase after a name and the device
    // form starts a sentence of its own, so the register differs and the
    // words are what have to match.
    for (const surface of [rows.toLowerCase(), lines.toLowerCase()]) {
      expect(surface).toContain("read only");
      expect(surface).toContain("read and write");
    }
  });

  it("reaches the humanized floor an uncurated pattern falls to", () => {
    // A third-party app's custom request resolves through neither label map
    // nor description, so if the operation were curated alongside the names
    // the distinction would hold only for the scopes somebody had already
    // thought about — which is the set a person needs it least for.
    const labels = rowLabels(
      authorize([parse("acme.widget:read"), parse("acme.widget:write")]),
    );
    expect(labels).toContain("Widget (read only)");
    expect(labels).toContain("Widget (read and write)");
  });

  /**
   * **The form follows the copy, because the chain answers in two
   * registers.** A curated label is a name and takes a parenthesis; a
   * description is a sentence and takes one of its own. Bracketing both put
   * "Everything on your server. (read only)" on the screen, with the suffix
   * stranded past a full stop, and that is not a corner case: every
   * wildcard but `user.*`, every edge type and three `system.*` types reach
   * the description because nothing curated names them.
   */
  it("ends a description-derived row as a sentence rather than a stranded bracket", () => {
    const labels = rowLabels(
      authorize([parse("*:read"), parse("edge.about:write")]),
    );
    expect(labels).toContain("Everything on your server. Read only.");
    expect(labels).toContain("What an item is about. Read and write.");
    for (const label of labels) expect(label).not.toMatch(/\.\s*\(read/);
  });

  it("keeps the parenthesis on a row whose label is a name", () => {
    // The two forms are chosen by which register the chain answered in, so
    // a curated label and the humanized floor both keep the bracket while a
    // description beside them does not. Collapsing to one form is what
    // produced the defect above in one direction and would produce "Notes.
    // Read only." in the other.
    const labels = rowLabels(
      authorize([parse("core.note:read"), parse("acme.widget:write")]),
    );
    expect(labels).toContain("Notes (read only)");
    expect(labels).toContain("Widget (read and write)");
  });

  it("says a description-derived grant in the same words as the device screen", () => {
    // The description is the whole of what the device screen prints, and it
    // is also this row's label wherever nothing curated names the pattern.
    // Where both surfaces fall that far they now render one identical
    // string, which is the agreement the operation module exists for.
    // `metadata.edge_types` was this case's example until it gained a curated
    // label, which moved it off the description path this asserts about. An
    // edge type is the same population and the docstring above already names
    // it.
    const scopes = [parse("edge.about:write")];
    const row = rowLabels(authorize(scopes))[0];
    expect(deviceLines(device(scopes))).toContain(row);
  });

  it("punctuates an unpunctuated description before appending the operation", () => {
    // A curated entry is a sentence with a stop on it, but an uncurated
    // pattern falls through to its registry description, and that is prose
    // written for an API reference by whoever registered the type. Without
    // the stop the operation runs into the last word of it.
    const labels = rowLabels(
      authorize([parse("acme.widget:read")], {
        descriptions: { "acme.widget": "Widgets Acme keeps for you" },
      }),
    );
    expect(labels).toContain("Widgets Acme keeps for you. Read only.");
  });

  it("separates a dropped write from a kept read under No longer needed", () => {
    const html = authorize([parse("core.note:read")], {
      priorScopes: ["core.note:read", "core.note:write"],
    });
    expect(html).toContain("Already allowed");
    expect(html).toContain("Notes (read only)");
    // Without the operation this line prints the same word the section above
    // it is still showing, so the screen says a grant is both kept and
    // dropped.
    expect(html).toContain("No longer needed");
    expect(html).toContain("Notes (read and write)");
  });
});

describe("a scope family with no read/write axis is given none", () => {
  it("attaches nothing to an OIDC literal or a permission", () => {
    const scopes = [parse("profile"), parse("webhooks.manage")];
    const rendered = [
      ...rowLabels(authorize(scopes)),
      ...deviceLines(device(scopes)),
    ];
    expect(rendered.length).toBeGreaterThan(0);
    for (const line of rendered) {
      expect(line, line).not.toMatch(/read only|read and write/i);
    }
  });

  it("answers on the kind rather than on the spelling", () => {
    // `operation` is typed across the whole union and parsing sets it to
    // "none" for the verb-less families, so a rule reading that field
    // without asking the kind would attach an operation to a permission
    // the moment the value moved. Asked here of the discriminant.
    expect(scopeOperation(parse("profile"))).toBeUndefined();
    expect(scopeOperation(parse("webhooks.manage"))).toBeUndefined();
    expect(scopeOperation(parse("core.note:read"))).toBe("read");
    expect(scopeOperation(parse("edge.about:write"))).toBe("write");
    expect(scopeOperation(parse("metadata.types:write"))).toBe("write");
    expect(scopeOperation(parse("*:read"))).toBe("read");
  });

  it("collapses a group summary's shared answer when a verb-less scope is in it", () => {
    // "Read only." would be false of `openid`, and a sentence true of most
    // of a list is the shape of copy this screen has shipped wrong before.
    // Each name carries its own instead.
    const bundles: PermissionBundle[] = [
      {
        id: "mixed",
        label: "Your content and you",
        description: "Both kinds in one tile.",
        scopes: ["core.note:read", "email"],
        default_on: true,
      },
    ];
    const [summary] = summaries(
      authorize([parse("core.note:read"), parse("email")], { bundles }),
    );
    expect(summary).toBe("Notes (read only) and your email address.");
  });
});

/**
 * The clause saying a grant reaches things nobody has registered yet, on the
 * bundle whose own description promises exactly that.
 *
 * `summarize` names four and then counts, and "and N more" replaces the
 * futurity clause rather than joining it. So anything that multiplies the
 * names in a group moves the threshold at which that clause disappears, and
 * carrying the operation on every name doubled them: the shipped `custom`
 * bundle emits a read and a write wildcard for every writable root, which
 * tipped it over at two roots — one registered namespace besides `user`.
 */
describe("an open-ended group keeps saying it is open-ended", () => {
  /** The `custom` bundle as this server holds it: `user` plus whatever
   *  `resolveRegisteredNamespaceRoots` returned. */
  const customBundleAt = (
    ownRoots: string[],
  ): { scopes: ParsedScope[]; bundles: PermissionBundle[] } => {
    const bundles = buildDefaultPermissionBundles({ own: ownRoots });
    const custom = bundles.find((b) => b.id === "custom");
    if (!custom) throw new Error("no custom bundle");
    return { scopes: custom.scopes.map(parse), bundles };
  };

  const customSummary = (ownRoots: string[]): string => {
    const { scopes, bundles } = customBundleAt(ownRoots);
    const [summary] = summaries(authorize(scopes, { bundles }));
    return summary ?? "";
  };

  /**
   * **The mutation check, and it reddens two ways.** Delete the
   * `else if (openEnded)` clause in `summarize` and the tail goes; stop
   * collapsing a pattern held at both operations and the six names push the
   * list past four, so the count replaces the tail instead.
   */
  it("says so at three roots, where six scopes resolve to three names", () => {
    expect(customSummary(["acme", "zed"])).toBe(
      "Your custom types, Acme (all) and Zed (all), and anything else of " +
        "that kind. Read and write.",
    );
  });

  it("says so at one root too", () => {
    expect(customSummary([])).toBe(
      "Your custom types, and anything else of that kind. Read and write.",
    );
  });

  it("still offers both halves as separately tickable rows", () => {
    // The collapse is the summary's alone. Each literal is its own grant and
    // its own checkbox, and the form submits what is ticked. Six rows is the
    // subject here; what they are called is not.
    //
    // **The two forms below are one screen's two shapes, not a
    // disagreement.** `user.*` has a curated `SCOPE_LABELS` name, so it
    // takes the parenthesis form a name is written for. A publisher root has
    // no name and now has a derived description, so `labelFor` resolves the
    // sentence and appends the operation as a sentence — the split
    // `labelFor` documents, and the reason a description never carries a
    // bracket stranded past its period.
    //
    // These read "Acme (all) (read only)" until the derivation landed: the
    // humanized floor, a title-cased fragment of the pattern, which is the
    // raw-literal experience the derivation exists to end.
    //
    // The summary above these rows still says "Acme (all)", because
    // `summarize` omits the description map by design. That divergence
    // predates this and is recorded at `consent.ts`; the derivation widens
    // the population it applies to rather than introducing it.
    const { scopes, bundles } = customBundleAt(["acme", "zed"]);
    const html = authorize(scopes, { bundles });
    expect(rowLabels(html)).toEqual([
      "Your custom types (read only)",
      "Your custom types (read and write)",
      "Everything Acme saves on your server. Read only.",
      "Everything Acme saves on your server. Read and write.",
      "Everything Zed saves on your server. Read only.",
      "Everything Zed saves on your server. Read and write.",
    ]);
  });

  /**
   * **The count and the clause no longer share a slot, pinned at the
   * threshold rather than as one case.** Past four names the sentence used
   * to say how many were left INSTEAD of saying the grant reaches things
   * nobody has created yet — so it stopped stating the open-endedness
   * exactly as the grant got wide enough to need truncating.
   *
   * Both sides are asserted together so a change to the truncation cannot
   * move the threshold without one of them reddening.
   */
  it("keeps the clause once an open-ended group is truncated", () => {
    // Four names, all of them under one open-ended grant: the clause is the
    // last thing the sentence says.
    expect(customSummary(["acme", "frob", "quux"])).toBe(
      "Your custom types, Acme (all), Frob (all) and Quux (all), and " +
        "anything else of that kind. Read and write.",
    );
    // One more root. The count arrives and the clause survives beside it —
    // "plus" rather than a second "and", which would read as a list item
    // rather than as a second clause.
    expect(customSummary(["acme", "frob", "quux", "zed"])).toBe(
      "Your custom types, Acme (all), Frob (all) and Quux (all), and 1 " +
        "more, plus anything else of that kind. Read and write.",
    );
  });

  it("counts rather than promising when a group genuinely holds five names", () => {
    // The truncation itself is untouched: past four names the sentence says
    // how many are left, and that branch really does replace the clause.
    // What changed is which requests reach it.
    const scopes = [
      "core.note:read",
      "core.task:read",
      "core.bookmark:read",
      "core.file:read",
      "core.media:read",
    ];
    const bundles: PermissionBundle[] = [
      {
        id: "five",
        label: "Your content",
        description: "Five names, none of them open-ended.",
        scopes,
        default_on: true,
      },
    ];
    const [summary] = summaries(authorize(scopes.map(parse), { bundles }));
    expect(summary).toContain(", and 1 more.");
  });
});

describe("one literal named twice is one row", () => {
  /**
   * The measurement behind this case, reproduced here as the fixture:
   *
   *   input:  core.note:read, core.note:read, core.task:read
   *   before: ["Notes (read only)", "Notes (read only)", "Tasks (read only)"]
   *
   * Two rows carried the same checkbox `value`, and the decision handler
   * takes the union of what was submitted — so unticking the row in front of
   * you reliably did nothing and granted the scope anyway. Deterministic,
   * and worse for a reader than a coin toss, because the screen showed a
   * choice it did not have.
   */
  const DUPLICATED = ["core.note:read", "core.note:read", "core.task:read"];

  it("renders one row per literal, not one per mention", () => {
    const rows = rowLabels(authorize(DUPLICATED.map(parse)));
    expect(rows).toEqual(["Notes (read only)", "Tasks (read only)"]);
  });

  it("keeps a read-and-write pair as two rows", () => {
    // The constraint the fix has to respect, and the reason the `seen` set
    // is keyed on the literal rather than on the rendered label. Both of
    // these resolve the name "Notes", so a label-keyed set would collapse
    // them and take the write half off the screen — the same defect the
    // consent screen closes, arriving here from the other direction.
    const rows = rowLabels(
      authorize(["core.note:read", "core.note:write"].map(parse)),
    );
    expect(rows).toEqual(["Notes (read only)", "Notes (read and write)"]);
  });

  it("agrees with the summary above it about how many things are asked for", () => {
    // `summarize` always deduplicated, reading the same array the rows read.
    // So the sentence said two things while the list below showed three, and
    // neither was marked as the authority. Asserted as agreement rather than
    // as two separate expected values, because the defect was the two
    // disagreeing.
    const html = authorize(DUPLICATED.map(parse));
    const [summary] = summaries(html);
    expect(summary).toBe("Notes and Tasks. Read only.");
    expect(rowLabels(html)).toHaveLength(2);
  });

  it("still matches the device screen, which never had the defect", () => {
    // The surface that got it right all along, kept in the same case so a
    // fix that made the authorize screen consistent with itself but not with
    // its sibling still fails.
    expect(deviceLines(device(DUPLICATED.map(parse)))).toEqual([
      "Notes. Read only.",
      "Tasks and to-dos. Read only.",
    ]);
  });
});

describe("a fallback bucket says what is in it", () => {
  /**
   * **The residue this settles rather than removes.** "Other
   * read access" and "Other write access" can each render twice on the
   * incremental screen, because `buildGroups` runs once per section and a
   * scope outside every bundle lands in a fallback bucket either way. The
   * original complaint was that one label meant two things on one screen.
   *
   * Two things answer it. The heading is no longer all a reader gets: every
   * group's description is overwritten with `summarize(g)`, so each instance
   * names the scopes actually in it and the two are not identical text under
   * one label. And the standing grant is collapsed now, so by default only
   * one of them is on the screen at all.
   *
   * The static `desc` strings survive as the floor for a bucket where
   * nothing resolves a name, which is the only case that can still print
   * them.
   */
  const CUSTOM = ["user.recipes:read", "user.recipes:write"];
  const NARROW: PermissionBundle[] = [
    {
      id: "notes",
      label: "Your notes",
      description: "Notes only.",
      scopes: ["core.note:read"],
      default_on: true,
    },
  ];

  it("names its members rather than printing its static description", () => {
    const scopes = ["core.note:read", ...CUSTOM].map(parse);
    const html = authorize(scopes, { bundles: NARROW });
    const said = summaries(html);
    // The precondition: the fallback buckets have to have been reached, or
    // this passes on a screen that never built one.
    expect(html).toContain(">Other read access<");
    expect(html).toContain(">Other write access<");
    // What a reader gets is the generated sentence, not the placeholder.
    expect(said).not.toContain("Additional things this app asked to read.");
    expect(said).not.toContain("Additional things this app asked to change.");
    expect(said.join(" ")).toContain("Recipes");
  });
});
