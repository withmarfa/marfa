import { createHmac, timingSafeEqual } from "node:crypto";
import {
  ErrorCode,
  MarfaError,
  edgePermissionCovers,
  metadataPermissionCovers,
  resolveEnforcement,
  resolveExtensionPermission,
  resolveTypePermission,
} from "@withmarfa/shared";
import type { ApiKey, EnforcementSettings } from "@withmarfa/shared";
import { extensionLabelOf } from "../auth/extension-label.js";
import {
  resolveBoundCredential,
  type BoundCredential,
} from "../auth/live-credential.js";
import type { Storage } from "./interface.js";
import { readInstanceConfig } from "./instance-config.js";
import {
  canonicalSourceFilter,
  sourceFilterIncludesItem,
} from "./filter-sql.js";

export const READ_VIEW_HEADER = "X-Marfa-Read-View";
export const READ_VIEW_PATTERN = /^[0-9a-f]{64}$/;
export interface ReadViewAuthority {
  readonly key: ApiKey;
  readonly permissions: readonly string[];
  readonly bound: BoundCredential;
  readonly enforcement: EnforcementSettings;
  readonly instanceId: string;
  readonly readView: string;
}

/** Reduce read/write to read reach and erase entries equal to their fallback. */
function canonicalPatterns(
  map: Record<string, string> | undefined,
  read: (name: string, map: Record<string, string>) => boolean,
): [string, boolean][] {
  const normalized = Object.fromEntries(
    Object.entries(map ?? {}).map(([name, level]) => [
      name,
      level === "read" || level === "write" ? "read" : "none",
    ]),
  );
  const names = Object.entries(normalized);
  const wildcards = names
    .filter(([name]) => name === "*" || name.endsWith(".*"))
    .sort(([a], [b]) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  const exact = names
    .filter(([name]) => name !== "*" && !name.endsWith(".*"))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const reduced: Record<string, string> = {};
  for (const [name, level] of [...wildcards, ...exact]) {
    const probe =
      name === "*"
        ? "readview_probe"
        : name.endsWith(".*")
          ? name.slice(0, -2)
          : name;
    if (read(probe, reduced) !== (level === "read")) reduced[name] = level;
  }
  return Object.entries(reduced)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, level]) => [name, level === "read"]);
}

export function canonicalReadProjection(
  key: ApiKey,
  bound: BoundCredential,
  enforcement: EnforcementSettings,
): unknown {
  const label = extensionLabelOf(key);
  const extensionMap = key.extension_permissions ?? {};
  const extensionNames = [
    ...new Set([
      ...Object.keys(extensionMap).filter((name) => name !== "*"),
      ...(label ? [label] : []),
    ]),
  ].sort();
  const extensionDefault =
    extensionMap["*"] === "read" || extensionMap["*"] === "write";
  const extensions = extensionNames
    .map((name): [string, boolean] => [
      name,
      resolveExtensionPermission(name, extensionMap, label) !== "none",
    ])
    .filter(([, readable]) => readable !== extensionDefault);
  const metadataDefault = metadataPermissionCovers(
    key.metadata_permissions,
    "",
    "read",
  );
  const metadata = Object.keys(key.metadata_permissions ?? {})
    .filter((name) => name !== "*")
    .sort()
    .map((name): [string, boolean] => [
      name,
      metadataPermissionCovers(key.metadata_permissions, name, "read"),
    ])
    .filter(([, readable]) => readable !== metadataDefault);
  return {
    authority:
      bound.kind === "api_key"
        ? ["api_key", bound.id]
        : ["oauth", bound.clientId, bound.authUserId],
    items: canonicalPatterns(
      key.type_permissions,
      (name, map) =>
        resolveTypePermission(name, map as ApiKey["type_permissions"]) !==
        "none",
    ),
    edges: canonicalPatterns(key.edge_permissions, (name, map) =>
      edgePermissionCovers(map as ApiKey["edge_permissions"], name, "read"),
    ),
    metadata: [metadataDefault, metadata],
    extensions: [extensionDefault, extensions],
    source_filter: canonicalSourceFilter(enforcement.source_filter),
  };
}

export function readViewChanged(): MarfaError {
  return new MarfaError(
    ErrorCode.READ_VIEW_CHANGED,
    "The read view changed. Rebuild the working copy.",
  );
}
export function sameReadView(a: string, b: string): boolean {
  return (
    READ_VIEW_PATTERN.test(a) &&
    READ_VIEW_PATTERN.test(b) &&
    timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"))
  );
}

/** Called only inside Storage.runInReadSnapshot. */
export async function readViewAuthority(
  storage: Storage,
  bound: BoundCredential,
  pin: Readonly<{ instanceId: string; structuralGeneration: string }>,
  instanceId: string,
  signingKey: Buffer,
  expected?: string,
): Promise<ReadViewAuthority> {
  const live = await resolveBoundCredential(storage, bound);
  if (!live)
    throw new MarfaError(ErrorCode.UNAUTHORIZED, "Authentication required");
  if (pin.instanceId !== instanceId) throw readViewChanged();
  const enforcement = resolveEnforcement(
    await readInstanceConfig(storage.settings),
    live.key,
  );
  const input = JSON.stringify([
    1,
    pin.instanceId,
    pin.structuralGeneration,
    canonicalReadProjection(live.key, bound, enforcement),
  ]);
  const readView = createHmac("sha256", signingKey).update(input).digest("hex");
  if (expected !== undefined && !sameReadView(expected, readView))
    throw readViewChanged();
  return Object.freeze({
    key: live.key,
    permissions: live.permissions,
    bound,
    enforcement,
    instanceId: pin.instanceId,
    readView,
  });
}
export function itemListed(
  authority: ReadViewAuthority,
  item: { type: string; source: string },
): boolean {
  return sourceFilterIncludesItem(authority.enforcement.source_filter, item);
}
