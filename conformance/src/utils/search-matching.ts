/**
 * The corpus and the queries the server's search fixtures and the device's
 * hold to one answer (`search-and-filters/search-stem` to `search-and-filters/excerpt-markup`, and `device.md` 123 to 145). Both halves create
 * these rows under a type of their own and search that type, so a case names
 * the rows it expects by key and the other rows on the server cannot change
 * the answer.
 */

export interface MatchingRow {
  key: string;
  properties: Record<string, unknown>;
  tags?: string[];
}

/** Created in this order, so a later row's identifier sorts after an earlier one's. */
export const MATCHING_ROWS: MatchingRow[] = [
  {
    key: "running",
    properties: { title: "Running shoes", body: "A pair for the track" },
  },
  {
    key: "runner",
    properties: { title: "Runner notes", body: "Tracks and trails" },
  },
  {
    key: "runs",
    properties: { title: "Morning", body: "She runs along the tracks" },
  },
  {
    key: "marsh",
    properties: { title: "Marshland", body: "A quiet landscape" },
  },
  {
    key: "hangar",
    properties: {
      description: "Zeppelin hangar",
      name: "Gondola",
      summary: "Dirigible",
      secret: "Blimp",
      remark: "Airship",
    },
    tags: ["balloon"],
  },
  { key: "blimp", properties: { summary: "Blimp airship" } },
  // Written in the order a phrase would not match them in, so that the order
  // the index joins them in is what the cases below read.
  {
    key: "ordered",
    properties: { zeta: "zetaword", alpha: "alphaword" },
    tags: ["zulutag", "alphatag"],
  },
  { key: "k1", properties: { body: "kiwi kiwi kiwi" } },
  { key: "k2", properties: { body: "kiwi kiwi pear" } },
  { key: "k3", properties: { body: "kiwi pear pear" } },
  { key: "k4", properties: { body: "kiwi pear pear" } },
  // The same match in the other column, created first: an index that weighted
  // the title above the body would put `mango-title` first, and equal weights
  // leave the tie to the identifier.
  { key: "mango-body", properties: { title: "alpha beta", body: "mango" } },
  { key: "mango-title", properties: { title: "mango", body: "alpha beta" } },
  {
    key: "long",
    properties: {
      body: `${Array.from({ length: 60 }, (_, at) => `w${at}`).join(" ")} needle`,
    },
  },
  { key: "markup", properties: { body: `<b>numbat</b> & "q" 'p'` } },
];

/** `remark` is left undeclared on purpose: a property the type does not declare is not indexed. */
export const MATCHING_FIELDS = {
  title: { type: "string" },
  body: { type: "string" },
  description: { type: "string" },
  name: { type: "string" },
  summary: { type: "string" },
  secret: { type: "string", searchable: false },
  zeta: { type: "string" },
  alpha: { type: "string" },
} as const;

export interface MatchingCase {
  name: string;
  query: string;
  /**
   * Row keys in rank order, best first; the rows of one group tie and come
   * in identifier order. An unranked case lists one group and is compared as
   * a set.
   */
  hits: string[][];
  ranked?: boolean;
}

const set = (...keys: string[]): string[][] => [keys];

export const MATCHING_CASES: MatchingCase[] = [
  {
    name: "a word that is not the last matches its stem and not its prefix",
    query: "run track",
    hits: set("running", "runs"),
  },
  {
    name: "the last word matches as a prefix",
    query: "run",
    hits: set("running", "runner", "runs"),
  },
  {
    name: "a prefix of the last word finds the longer word",
    query: "marshl",
    hits: set("marsh"),
  },
  {
    name: "an earlier word is not a prefix",
    query: "marsh landscape",
    hits: [],
  },
  {
    name: "an earlier word matches whole, and the last as a prefix",
    query: "landscape marsh",
    hits: set("marsh"),
  },
  {
    name: "a word matches from its start and not from its middle",
    query: "arshland",
    hits: [],
  },
  {
    name: "words match in any order and any column",
    query: "landscape marshland",
    hits: set("marsh"),
  },
  {
    name: "a quoted query is a phrase in order",
    query: '"quiet landscape"',
    hits: set("marsh"),
  },
  {
    name: "a phrase in the other order matches nothing",
    query: '"landscape quiet"',
    hits: [],
  },
  {
    name: "surrounding whitespace preserves a phrase's order",
    query: ' \t"landscape quiet"\n ',
    hits: [],
  },
  {
    name: "surrounding whitespace does not add a prefix to a phrase",
    query: ' \t"quiet land"\n ',
    hits: [],
  },
  {
    name: "pasted byte-order marks around a phrase are trimmed",
    query: '\uFEFF"quiet landscape"\uFEFF',
    hits: set("marsh"),
  },
  {
    name: "a phrase matches stems",
    query: '"quiet landscapes"',
    hits: set("marsh"),
  },
  {
    name: "the last word of a phrase is not a prefix",
    query: '"quiet land"',
    hits: [],
  },
  {
    name: "the same words unquoted are a prefix on the last",
    query: "quiet land",
    hits: set("marsh"),
  },
  {
    name: "the description is indexed",
    query: "zeppelin",
    hits: set("hangar"),
  },
  { name: "the name is indexed", query: "gondola", hits: set("hangar") },
  {
    name: "a declared string field beyond the four is indexed",
    query: "dirigible",
    hits: set("hangar"),
  },
  { name: "a tag is indexed", query: "balloon", hits: set("hangar") },
  {
    name: "a field marked searchable false is not, though the word is findable elsewhere",
    query: "blimp",
    hits: set("blimp"),
  },
  {
    name: "a property the type does not declare is not, though the word is findable elsewhere",
    query: "airship",
    hits: set("blimp"),
  },
  {
    name: "fields are joined in name order for a phrase across them",
    query: '"alphaword zetaword"',
    hits: set("ordered"),
  },
  {
    name: "fields are not joined in the order they were declared or written",
    query: '"zetaword alphaword"',
    hits: [],
  },
  {
    name: "tags are joined in byte order for a phrase across them",
    query: '"alphatag zulutag"',
    hits: set("ordered"),
  },
  {
    name: "tags are not joined in the order they were written",
    query: '"zulutag alphatag"',
    hits: [],
  },
  {
    name: "more matches of a word rank higher, and equal rows tie by identifier",
    query: "kiwi",
    hits: [["k1"], ["k2"], ["k3", "k4"]],
    ranked: true,
  },
  {
    name: "a title and a body weigh the same",
    query: "mango",
    hits: [["mango-body", "mango-title"]],
    ranked: true,
  },
  {
    name: "search syntax in a query is text: an operator word",
    query: "AND OR NOT",
    hits: [],
  },
  {
    name: "search syntax in a query is text: a trailing star",
    query: "kiwi*",
    hits: set("k1", "k2", "k3", "k4"),
  },
  {
    name: "search syntax in a query is text: a leading minus",
    query: "-kiwi",
    hits: set("k1", "k2", "k3", "k4"),
  },
  {
    name: "search syntax in a query is text: a column filter",
    query: "title:kiwi",
    hits: [],
  },
  {
    name: "search syntax in a query is text: a near group",
    query: "NEAR(kiwi pear)",
    hits: [],
  },
  {
    name: "a quote inside a word is text",
    query: 'ma"ngo',
    hits: [],
  },
  {
    name: "a query of only spaces matches nothing",
    query: "   ",
    hits: [],
  },
];

/** The words a hit's snippet is held to: a match deep in a long text. */
export const SNIPPET_QUERY = "needle";

/** A word in a row whose text holds the characters HTML gives meaning to. */
export const MARKUP_QUERY = "numbat";

/** The excerpt `MARKUP_QUERY` answers: the row's text escaped, the match marked. */
export const MARKUP_SNIPPET =
  "&lt;b&gt;<mark>numbat</mark>&lt;/b&gt; &amp; &quot;q&quot; &#39;p&#39;";
