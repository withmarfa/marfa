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
 *   lands in the read and write bundles, every publisher-tier registry type
 *   (the integration set) lands in the read-only connected bundle, and
 *   `system.*` stays out except the `system.connection:read` toggle.
 * - The registry's own publisher roots, for the namespace wildcards the
 *   scope allowlist admits (`google.*`, `readwise.*`, …) — previously a
 *   second hand list.
 * - The runtime `custom_types` table, for the namespaces of types spaces
 *   have registered themselves. Their roots extend the custom bundle with
 *   `<root>.*` wildcards so a custom type under any handle is offerable,
 *   not just `user.*`.
 *
 * The runtime source is read on two schedules, because registrations are
 * space-scoped and consent is per-space. At boot, the space-less bucket is
 * folded into the instance-wide bundle set. That bucket holds the
 * platform-shipped registrations and a manifest's declared types, which are
 * meant to be offerable from every space; a self-host's own registrations
 * are not in it and have not been since keys mode got a space, so the fold
 * is about the platform set rather than about a deployment shape. In hosted
 * mode a registration belongs to one space, and folding it in instance-wide
 * would present one space's namespaces on every other space's consent
 * screen; the consent route instead derives
 * that space's own roots at render time ({@link resolveRuntimeCustomNamespaces}
 * with a space id). The scope allowlist, which is an acceptance set rather
 * than anything a person sees, keeps the boot-time restart-re-enumeration
 * model over every space's roots ({@link resolveAllRuntimeCustomNamespaces}).
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
 * tiers, plus every publisher root the shipped registry occupies. Derived,
 * not enumerated — a new integration namespace joins by existing.
 */
export function deriveCustomTypeNamespaces(): string[] {
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
 * Namespace roots of the types spaces registered at runtime, for extending
 * the custom bundle beyond `user.*`. Publisher-tier roots only: `user.*`
 * and `app.*` are covered structurally, and reserved roots cannot hold a
 * custom type in the first place (belt: filtered anyway, since this reads
 * a table rather than the validator's output).
 *
 * With a `spaceId`, the answer is that space's own registrations and
 * nothing else — the consent screen's question, asked at render time so a
 * space's registrations are offerable without a restart. Without one, the
 * answer is the space-less bucket, which holds the platform-scoped
 * registrations and nothing a space owns. Never both at once — a space's
 * consent screen deliberately does not inherit the platform bucket, whose
 * types resolve only for space-less callers.
 */
export interface RuntimeNamespaceRoots {
  /** Roots holding types the person registered themselves. */
  own: string[];
  /** Roots holding types an installed integration published. */
  connected: string[];
  /**
   * Roots holding types whose provenance nobody recorded, restored from an
   * archive taken before archives carried it.
   *
   * Offered as the person's own, because a root that lands in no bundle is
   * a root no application can be granted, and a legitimate backup of your
   * own types restoring into something ungrantable is a worse outcome than
   * the one this guards against. Offered READ-ONLY, because the row may be
   * a connected service's mirror and a third-party write would fork it from
   * upstream. Read is the half both cases can live with.
   */
  ownReadOnly: string[];
}

export async function resolveRuntimeCustomNamespaces(
  storage: Storage,
  spaceId?: string,
): Promise<RuntimeNamespaceRoots> {
  const rows = await storage.types.listCustomWithProvenance(spaceId);
  // Split by the stored fact, because the identifier cannot do it:
  // `readwise.book` and `jonah.reading_item` are the same shape to a
  // first-segment test, and one arrived with a connected service while
  // the other is the person's own invention.
  //
  // Both are offered; what differs is how. A person's own root gets the
  // read-and-write wildcard, because types they have not invented yet
  // cannot be enumerated. A service's root is offered read-only, matching
  // every other connected type: an integration's row is a faithful mirror
  // of an upstream record, and a third-party write forks it.
  //
  // Neither is dropped. Removing a service's types from the person's
  // bundle without putting them anywhere is not a narrowing, it is an
  // omission — they would then sit in no default bundle at all, including
  // the one named for them.
  return {
    own: namespaceRootsOf(
      rows.filter((row) => row.origin === "user").map((row) => row.schema.id),
    ),
    connected: namespaceRootsOf(
      rows
        .filter((row) => row.origin === "integration")
        .map((row) => row.schema.id),
    ),
    // A row whose provenance nobody recorded. Deliberately its own bucket
    // rather than folded into either neighbor: folding into `own` is the
    // silent upgrade to write that this split exists to prevent, and
    // folding into `connected` claims a publisher no row names.
    ownReadOnly: namespaceRootsOf(
      rows
        .filter((row) => row.origin === "unknown")
        .map((row) => row.schema.id),
    ),
  };
}

/**
 * Every space's runtime custom-namespace roots at once, for the OAuth
 * scope allowlist and nothing user-facing. The allowlist is an acceptance
 * set — a scope literal outside it is narrowed away before consent — so a
 * space's roots have to be in it for that space's grants to be issuable
 * at all, and admitting every space's roots instance-wide reveals nothing:
 * what a person is shown stays per-space (the consent route), and what the
 * discovery documents advertise stays pinned to the bundle baseline.
 */
export async function resolveAllRuntimeCustomNamespaces(
  storage: Storage,
): Promise<string[]> {
  const loaded = await storage.types.loadCustomTypes();
  // Platform rows share this table since the shipped vocabulary became
  // seeded data, and their publisher roots are already in the allowlist's
  // static half. Folding them in again would report the build's own set as
  // though a space had registered it.
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
 * The shape and rationale carried over from the hand-written era, now held
 * by construction rather than by curation:
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
 *   read security internals (credentials, devices, webhooks).
 * - Publisher-tier registry types (the integration set) are the person's
 *   own synced content, so `connected` covers them for READ. Writes stay
 *   request-only: an integration row is a vendor-faithful mirror, and a
 *   third-party write would fork it from upstream.
 * - `custom` is the one wildcard bundle, deliberately: types a person
 *   invents do not exist at request time, so no concrete list can name
 *   them. `user.*` always; `extraCustomNamespaces` (the runtime roots from
 *   {@link resolveRuntimeCustomNamespaces}) extend it so custom types under
 *   a claimed handle are offerable through the same toggle. Registry
 *   publisher roots are excluded here — `connected` already covers their
 *   types concretely, and their namespace wildcards stay requestable
 *   without being part of the default grant.
 */
export function buildDefaultPermissionBundles(
  runtimeRoots: Partial<RuntimeNamespaceRoots> = {},
): PermissionBundle[] {
  const extraCustomNamespaces = runtimeRoots.own ?? [];
  const connectedNamespaces = runtimeRoots.connected ?? [];
  const readOnlyCustomNamespaces = runtimeRoots.ownReadOnly ?? [];
  const coreTypes: string[] = [];
  const connectedTypes: string[] = [];
  for (const id of [...TYPE_REGISTRY.keys()].sort()) {
    const tier = classifyNamespace(id);
    if (tier === "core") coreTypes.push(id);
    else if (tier !== "system") connectedTypes.push(id);
  }

  const registryRoots = new Set(deriveCustomTypeNamespaces());
  const customWildcardRoots = [
    "user",
    ...[...new Set(extraCustomNamespaces)]
      .filter((ns) => !registryRoots.has(ns) && !isReservedRoot(ns))
      .sort(),
  ];
  // Roots reachable only through a type whose provenance nobody recorded.
  //
  // Subtracted from the read-and-write set rather than added beside it: a
  // space holding both a type it registered itself and a restored one under
  // the same root has earned write on that root through the first, and
  // offering the same root twice at two levels would put a contradiction on
  // one screen. The stronger grant wins, which is the existing rule for a
  // root that appears more than once.
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
      description: "Add, edit, and organize what's in your space.",
      scopes: coreTypes.map((id) => `${id}:write`),
      default_on: true,
    },
    {
      id: "connected",
      label: "Content from your connected services",
      description:
        "What your integrations have synced, like Google and Readwise.",
      // Shipped publisher types are enumerated; a space's own installed
      // integrations publish types this build has never heard of, so
      // their roots ride as wildcards. Read-only either way, which is the
      // rule for a mirror rather than a property of how it is named.
      scopes: [
        ...connectedTypes.map((id) => `${id}:read`),
        ...[...new Set(connectedNamespaces)]
          .filter((ns) => !registryRoots.has(ns) && !isReservedRoot(ns))
          .sort()
          .map((ns) => `${ns}.*:read`),
      ],
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
