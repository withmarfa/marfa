/**
 * Derivation of the default consent-screen permission bundles from the type
 * registry, replacing the hand-written scope lists that used to live in
 * `config.ts`. Hand lists drift — the coverage test existed because they
 * drift — and they privileged the shipped set structurally: a custom type
 * outside `user.*` could never be offered by any default bundle because no
 * literal written in advance can name it.
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
 * The runtime source is read once at boot, matching the scope allowlist's
 * documented restart-re-enumeration model: a namespace first used after
 * boot becomes offerable on the next restart. Making registry reads live
 * is a separate piece of platform work; this module must not get ahead of
 * it by going per-request.
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
 */
export async function resolveRuntimeCustomNamespaces(
  storage: Storage,
): Promise<string[]> {
  const custom = await storage.types.listCustom();
  const roots = new Set<string>();
  for (const schema of custom) {
    if (classifyNamespace(schema.id) !== "publisher") continue;
    const root = schema.id.split(".")[0];
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
 *   "Connected accounts" toggle), so an app reading "your content" cannot
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
  extraCustomNamespaces: readonly string[] = [],
): PermissionBundle[] {
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
      scopes: connectedTypes.map((id) => `${id}:read`),
      default_on: true,
    },
    {
      id: "custom",
      label: "Things with your own custom types",
      description:
        "Types you define yourself, including ones you define later and ones under your own publisher handle.",
      scopes: customWildcardRoots.flatMap((ns) => [
        `${ns}.*:read`,
        `${ns}.*:write`,
      ]),
      default_on: true,
    },
    {
      id: "profile",
      label: "Your profile",
      description: "Your name and email.",
      scopes: ["openid", "profile", "email"],
      default_on: true,
    },
  ];
}
