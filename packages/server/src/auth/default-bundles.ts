/**
 * Derivation of the default consent-screen permission bundles from the type
 * registry rather than from hand-written scope lists. Hand lists drift — the
 * coverage test exists because they drift — and they privilege the shipped
 * set structurally: a custom type outside `user.*` can never be offered by
 * any default bundle because no literal written in advance can name it.
 *
 * Three sources feed the derivation:
 *
 * - The static type registry, for the shipped families: every `core.*` type
 *   lands in the read and write bundles, and `system.*` stays out except the
 *   `system.connection:read` toggle.
 * - The registry's own publisher roots, for the namespace wildcards the
 *   scope allowlist admits.
 * - The runtime `types` table, for the namespaces of types registered at
 *   runtime. Their roots extend the custom bundle with
 *   `<root>.*` wildcards so a custom type under any handle is offerable,
 *   not just `user.*`.
 *
 * The runtime source is read by two callers that need different shapes of
 * the same rows. The OAuth scope allowlist takes the roots flat
 * ({@link resolveAllRegisteredNamespaceRoots}): it is an acceptance set, so
 * a literal outside it is narrowed away before consent can see one, and
 * being in it is not disclosure. The default bundles take the roots split
 * by provenance ({@link resolveRegisteredNamespaceRoots}), because what a
 * person is offered turns on whether a root is their own or one nobody
 * recorded, which is a distinction the allowlist has no use for.
 */
import {
  TYPE_REGISTRY,
  classifyNamespace,
  isReservedRoot,
  type PermissionBundle,
} from "@withmarfa/shared";
import type { Storage } from "../storage/interface.js";

/**
 * The namespace roots whose wildcard scopes (`<root>.*:read|write`, plus the
 * `edge.<root>.*` pair) are requestable: `user` and `app` for the runtime
 * tiers, plus every publisher root the registry occupies. Derived, not
 * enumerated: a publisher root joins by existing.
 *
 * **Not a reader of the `types` table**, which is why it is not named for a
 * registration: it answers from `TYPE_REGISTRY`, the build's own set, and
 * the roots a caller registered reach the allowlist by the other path,
 * {@link resolveAllRegisteredNamespaceRoots}.
 */
export function deriveRequestableNamespaceRoots(): string[] {
  const roots = new Set<string>(["user", "app"]);
  for (const id of TYPE_REGISTRY.keys()) {
    if (classifyNamespace(id) === "publisher") {
      const root = id.split(".")[0];
      if (root) roots.add(root);
    }
  }
  return [...roots].sort();
}

/**
 * Namespace roots of the types registered at runtime, for extending
 * the custom bundle beyond `user.*`. Publisher-tier roots only: `user.*`
 * and `app.*` are covered structurally, and reserved roots cannot hold a
 * custom type in the first place (belt: filtered anyway, since this reads
 * a table rather than the validator's output).
 *
 * Asked at render time rather than cached, so a registration becomes
 * offerable without a restart.
 */
export interface RuntimeNamespaceRoots {
  /** Roots holding types the person registered themselves. */
  own: string[];
  /**
   * Roots holding types whose provenance nobody recorded: an archive line
   * that carried none, or one claiming an origin this build does not know.
   *
   * Offered as the person's own, because a root that lands in no bundle is
   * a root no application can be granted, and a legitimate backup of your
   * own types restoring into something ungrantable is a worse outcome than
   * the one this guards against. Offered READ-ONLY, because nothing says
   * the person wrote it, and a write wildcard is the one thing an archive
   * line should not be able to hand itself. Read is the half both cases can
   * live with.
   */
  ownReadOnly: string[];
}

export async function resolveRegisteredNamespaceRoots(
  storage: Storage,
): Promise<RuntimeNamespaceRoots> {
  const rows = await storage.types.listRegisteredWithProvenance();
  // Split by the stored fact, because the identifier cannot do it:
  // `salvage.record` and `jonah.reading_item` are the same shape to a
  // first-segment test, and one may have arrived on an archive line that
  // said nothing about where it came from.
  return {
    own: namespaceRootsOf(
      rows.filter((row) => row.origin === "user").map((row) => row.schema.id),
    ),
    // Its own bucket rather than folded into `own`, which would be the
    // silent upgrade to write that this split exists to prevent.
    ownReadOnly: namespaceRootsOf(
      rows
        .filter((row) => row.origin === "unknown")
        .map((row) => row.schema.id),
    ),
  };
}

/**
 * Every registered namespace root at once, for the OAuth scope allowlist and
 * nothing user-facing. The allowlist is an acceptance set — a scope literal
 * outside it is narrowed away before consent — so a root has to be in it for
 * a grant naming it to be issuable at all. What a person is shown is decided
 * separately by the consent route, and what the discovery documents advertise
 * stays pinned to the bundle baseline.
 */
export async function resolveAllRegisteredNamespaceRoots(
  storage: Storage,
): Promise<string[]> {
  const loaded = await storage.types.loadAll();
  // Platform rows share this table since the shipped vocabulary became
  // seeded data, and their publisher roots are already in the allowlist's
  // static half. Folding them in again would report the build's own set as
  // though it had been registered here.
  return namespaceRootsOf(
    loaded
      .filter((row) => row.origin !== "platform")
      .map((row) => row.schema.id),
  );
}

/** Publisher-tier, non-reserved namespace roots of the given type ids. */
function namespaceRootsOf(ids: readonly string[]): string[] {
  const roots = new Set<string>();
  for (const id of ids) {
    if (classifyNamespace(id) !== "publisher") continue;
    const root = id.split(".")[0];
    if (root && !isReservedRoot(root)) roots.add(root);
  }
  return [...roots].sort();
}

/**
 * Build the default permission bundles from the registry.
 *
 * The rules, held by construction rather than by curation:
 *
 * - `read` / `write` carry CONCRETE per-type scopes rather than a `core.*`
 *   wildcard. The OAuth provider only lets a consent grant narrow to scopes
 *   that were literally requested, so for "untick Calendar" to genuinely
 *   narrow the token the request has to name each type up front. The flip
 *   side is the honest one: a content type added in a later release is NOT
 *   granted to an already-connected app automatically; the user approves it
 *   on the next connect.
 * - Everything in `system.*` stays out except `system.connection:read` (the
 *   "Connections" toggle), so an app reading "your content" cannot
 *   read the instance's own records (devices, apps, webhooks).
 * - `custom` is the one wildcard bundle, deliberately: types a person
 *   invents do not exist at request time, so no concrete list can name
 *   them. `user.*` always; `extraCustomNamespaces` (the runtime roots from
 *   {@link resolveRegisteredNamespaceRoots}) extend it so custom types under
 *   a claimed handle are offerable through the same toggle. A publisher
 *   root the registry itself occupies is excluded: its types are platform
 *   rows rather than the person's, so its wildcard stays requestable
 *   without being part of the default grant.
 */
export function buildDefaultPermissionBundles(
  runtimeRoots: Partial<RuntimeNamespaceRoots> = {},
): PermissionBundle[] {
  const extraCustomNamespaces = runtimeRoots.own ?? [];
  const readOnlyCustomNamespaces = runtimeRoots.ownReadOnly ?? [];
  const coreTypes = [...TYPE_REGISTRY.keys()]
    .filter((id) => classifyNamespace(id) === "core")
    .sort();

  const registryRoots = new Set(deriveRequestableNamespaceRoots());
  const customWildcardRoots = [
    "user",
    ...[...new Set(extraCustomNamespaces)]
      .filter((ns) => !registryRoots.has(ns) && !isReservedRoot(ns))
      .sort(),
  ];
  // Roots reachable only through a type whose provenance nobody recorded.
  //
  // Subtracted from the read-and-write set rather than added beside it: a
  // root holding both a type registered here and a restored one has earned
  // write through the first, and offering the same root twice at two levels
  // would put a contradiction on one screen. The stronger grant wins, which
  // is the rule for a root that appears more than once.
  const writableRoots = new Set(customWildcardRoots);
  const readOnlyCustomRoots = [...new Set(readOnlyCustomNamespaces)]
    .filter(
      (ns) =>
        !writableRoots.has(ns) && !registryRoots.has(ns) && !isReservedRoot(ns),
    )
    .sort();

  return [
    {
      id: "read",
      label: "Read your content",
      description: "Your notes, tasks, bookmarks, files, media, and more.",
      scopes: [
        ...coreTypes.map((id) => `${id}:read`),
        "system.connection:read",
      ],
      default_on: true,
    },
    {
      id: "write",
      label: "Write your content",
      description: "Add, edit, and organize what's on your server.",
      scopes: coreTypes.map((id) => `${id}:write`),
      default_on: true,
    },
    {
      id: "custom",
      label: "Things with your own custom types",
      description:
        "Types you define yourself, including ones you define later and ones under your own publisher handle.",
      scopes: [
        ...customWildcardRoots.flatMap((ns) => [
          `${ns}.*:read`,
          `${ns}.*:write`,
        ]),
        // Read without the write half. The bundle's copy claims no verb, so
        // it stays true of both; which roots are writable is what the
        // levels-and-parent-rows screen exists to show, and it is not built
        // yet. What matters here is that the weaker grant is the one a row
        // of unrecorded provenance gets.
        ...readOnlyCustomRoots.map((ns) => `${ns}.*:read`),
      ],
      default_on: true,
    },
    {
      id: "profile",
      label: "Your profile",
      // Shown when the group renders no rows of its own, and published as is
      // in the discovery document beside the scope list, so it has to name
      // what the four scopes read and nothing less: `profile` returns `name`
      // and `picture`, `email` the address, and `profile:read` the rest of
      // the record that `GET /profile/me` answers with. It fell behind the
      // scopes once before, saying "name and email" beside three of them.
      description:
        "Your name, picture, email address, username, bio and timezone.",
      // **`profile:read` rides with the OIDC literals; `profile:write` stays
      // opt-in by name.** The read half of the profile category is what an
      // app needs to show the person to themselves, which is what every app
      // that asks for `profile` is doing, and the two overlap on the reads
      // `/oauth/userinfo` answers. Adding it here widens a consenting app from
      // the three claims to the whole read surface, bio and timezone and the
      // username that namespaces published types, and does so on the next
      // approval rather than silently: a standing grant that lacks it meets
      // the re-consent screen with the new row under "New", ticked, and the
      // person decides. The write half is administrative authority over the
      // profile and follows the content category's precedent instead:
      // requestable, in no shipped bundle, asked for by name and shown
      // pre-ticked under the fallback bucket when it is.
      scopes: ["openid", "profile", "email", "profile:read"],
      default_on: true,
    },
  ];
}
