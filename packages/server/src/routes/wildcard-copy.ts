import {
  classifyNamespace,
  isReservedRoot,
  subtreeWildcardRoot,
} from "@withmarfa/shared";

const EDGE_PREFIX = "edge.";

/**
 * The consent sentence a namespace wildcard gets, derived from its root.
 *
 * **A rule rather than a table, because the set of wildcards is open.**
 * `buildAllowedScopes` publishes `<root>.*` and `edge.<root>.*` for every
 * publisher root the registry holds AND for every root boot installs from
 * the `types` table, so a root can arrive on a running instance that
 * no list written here could name. A hand-written entry per wildcard closes
 * today's set and reopens on the next connector; this closes it for roots
 * nobody has registered yet.
 *
 * That is not the same argument the curated map makes for the seven entries
 * it keeps. `*`, `core.*`, `user.*`, `app.*` and the three `edge.` forms
 * beside them are a closed, structural set, and each says something a
 * derivation cannot: "All standard content types" carries a judgment about
 * what "standard" means. Curated copy wins wherever it exists — {@link
 * describeScope} reads the map first — so this answers only what the map
 * deliberately does not.
 *
 * **Neither sentence states that the grant reaches types nobody has
 * registered yet**, under the same prohibition the curated map is held to
 * and for the same reason: both screens compose that line from
 * `isOpenEnded`, so a clause written here would be stated twice on the
 * authorize screen, where a description resolved through `labelFor` becomes
 * the toggle label directly above it.
 */
export function deriveWildcardDescription(
  typePattern: string,
): string | undefined {
  const isEdge = typePattern.startsWith(EDGE_PREFIX);
  const root = subtreeWildcardRoot(
    isEdge ? typePattern.slice(EDGE_PREFIX.length) : typePattern,
  );
  // The global wildcard and every exact identifier land here. `edge.*` does
  // too — its inner pattern is a bare `*` — and it is curated, because "how
  // everything connects" is not a statement about any root.
  if (root === null) return undefined;
  // A root, not a subtree of one. `core.media.*` would otherwise read as a
  // service called "Core.media"; it is not requestable today, and a sentence
  // that is nonsense the moment it becomes so is worse than none.
  if (root.includes(".")) return undefined;
  // Publisher roots only, asked of the classifier rather than of a list of
  // the roots this build happens to ship — which is the whole point, since
  // the root may have arrived from the database. `core`, `system`, `marfa`,
  // `user` and `app` are the structural tiers and their wildcards are
  // curated.
  //
  // `isReservedRoot` is the belt, and it is load-bearing rather than
  // decorative: `classifyNamespace` documents that a reserved root with no
  // tier of its own — `content`, `audit` — falls through to
  // `publisher`. Neither reaches this function today, because both are
  // claimed by earlier arms of `parseScope`, but a classifier answering
  // "publisher" for a reserved word is not a premise to leave a sentence
  // resting on.
  if (isReservedRoot(root)) return undefined;
  if (classifyNamespace(root) !== "publisher") return undefined;
  const name = displayNameForRoot(root);
  if (!name) return undefined;
  return isEdge
    ? `How ${name} connects your items.`
    : `Everything ${name} saves on your server.`;
}

/**
 * A root as a person should read it: `acme` becomes "Acme",
 * `acme-corp` becomes "Acme Corp".
 *
 * The rendering is friendly rather than verbatim for the reader's sake. No
 * root is reserved for a brand, so the transform cannot be used to reach a
 * name a list would otherwise have refused. A shipped publisher root stays
 * open to registration under other identifiers; what answers a collision is
 * the seed refusing to overwrite a registration it did not write.
 *
 * A registered root also renders its member types beside the row —
 * `resolveWildcardExpansions` enumerates what was actually registered under
 * it — so the sentence is not the only thing a person is given.
 */
function displayNameForRoot(root: string): string {
  return root
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
