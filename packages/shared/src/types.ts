// Marfa wire types — the format shared between server and clients over the API.

import type { ItemState, MergePolicy, MergeStrategy } from "@withmarfa/types";
// Type-only, and so erased at build: `scopes.ts` imports this module for its
// wire types, and a value import back the other way would be a runtime cycle.
import type { Permission } from "./scopes.js";

/** Valid item states as a readonly array, useful for validation. */
export const ITEM_STATES: readonly ItemState[] = [
  "active",
  "archived",
  "trashed",
  "revoked",
] as const;

/**
 * The intent tier on an item — `library` is curated, kept, indexed; `feed`
 * is high-volume, low-intent capture. Items move between them through manual
 * or automated curation. `system.*` items have no tier (the dimension does
 * not apply); the field is optional on the wire to model that.
 */
export type Tier = "library" | "feed";

/** Valid tier values as a readonly array, useful for validation. */
export const TIERS: readonly Tier[] = ["library", "feed"] as const;

/**
 * Whether a value is a tier this build recognizes.
 *
 * Exists because the column is plain text with no constraint, and is keyed
 * off `TIERS` rather than repeating the union literal so adding a tier cannot
 * leave this behind. The item projection compared the column against two
 * hardcoded literals instead, which is the same defect wearing different
 * syntax: a tier added here would have been dropped to `undefined` by a
 * comparison nobody would think to update.
 *
 * Kept free of any logging concern because this ships to npm.
 */
export function isTier(value: unknown): value is Tier {
  return (
    typeof value === "string" && (TIERS as readonly string[]).includes(value)
  );
}

/** Per-type permission levels. */
export type TypePermission = "read" | "write" | "none";

/** Per-namespace extension permission levels. */
export type ExtensionPermission = "read" | "write";

/** A Marfa item — the fundamental data record. */
export interface Item {
  id: string;
  type: string;
  state: ItemState;
  /**
   * The intent tier on this item — `library` is curated/kept, `feed` is
   * high-volume capture. Optional because `system.*` items have no tier.
   */
  tier?: Tier;
  properties: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  /** When the item's content happened, as opposed to when the row was
   *  written. Defaults to `created_at` when the writer names nothing. */
  occurred_at: string;
  source: string;
  source_id?: string;
  version: number;
  schema_version: number;
  capture_latitude?: number;
  capture_longitude?: number;
}

/** Input for creating a new item. */
export interface CreateItemInput {
  /**
   * Optional, and meaningful on one path: where `source_id` resolves a live
   * row this create is an upsert, and a version here makes it conditional
   * exactly as on an update. Ignored elsewhere — a genuine create has no
   * version to have read.
   */
  version?: number;
  type: string;
  properties: Record<string, unknown>;
  id?: string;
  state?: ItemState;
  /** Overrides the credential's default_tier when supplied. */
  tier?: Tier;
  occurred_at?: string;
  /** Ignored on the wire — server always stamps source from the credential. */
  source?: string;
  source_id?: string;
  capture_latitude?: number;
  capture_longitude?: number;
  tags?: string[];
}

/** Input for updating an existing item. */
export interface UpdateItemInput {
  properties?: Record<string, unknown>;
  /**
   * Faithful-mirror semantics for an owning connector's re-sync: an
   * explicit null deletes the key instead of reading as "leave unset".
   * The upstream cleared the field, so the mirror must clear it too —
   * otherwise a stale value survives every re-sync. Set by the server
   * for owner writes to connector-owned rows; never caller-supplied.
   */
  null_clears?: boolean;
  /**
   * Whether `properties` lays over the row's or becomes them.
   *
   * Defaults to `merge`, which is what every existing caller means. A
   * `replace` says the incoming set IS the item's properties, so a field the
   * row holds and the write does not name is gone.
   *
   * It exists because the clearing behavior was otherwise reachable only by
   * naming every field to be removed, which puts the type's shape in every
   * call site. The result is validated either way, so a replace that drops a
   * required field is refused rather than written.
   */
  properties_mode?: "merge" | "replace";
  /**
   * Move the item to this type.
   *
   * Absent on every ordinary write, and the doors above this refuse a
   * type that disagrees with the row rather than passing one down. It is
   * set only where a caller has explicitly asked to re-type, which exists
   * for one job: bringing a corpus written under one shape onto the shape
   * a person's mapping now names. Without it, a mapping applies to what
   * arrives next and the items already there are stranded under the old
   * type forever.
   *
   * The resulting properties are validated against this type, not the
   * one being left, so a move that would produce a row the target type
   * calls invalid is refused rather than written.
   */
  type?: string;
  /**
   * The version the caller read. Required: an update carries the version it
   * is based on, or it is not an update but a blind overwrite of whatever
   * arrived since.
   */
  version: number;
  /** Toggle the tier (`library` ↔ `feed`). Independent of the version-merge
   *  path for `properties`; flipping `tier` doesn't conflict (it's a single
   *  metadata-axis flag, last-writer-wins by design). */
  tier?: Tier;
  /** Override the item's own time. Settable on create; this field lets
   *  importers fix dates retroactively without rewriting properties.
   *  Independent of the version-merge path. */
  occurred_at?: string;
  /**
   * Repoint the item at a new natural-key identifier under the caller's
   * stamped `source`. The `(source, source_id)` tuple is unique
   * — the same constraint enforced at create time — so the server rejects
   * the update with HTTP 409 `source_id_conflict` if the target value is
   * already taken by a different item. PATCHing the same value the item
   * already carries is a no-op success. Used by the sync agent to preserve
   * item identity through file renames without losing the path-derived
   * natural key.
   */
  source_id?: string;
}

/** An item paired with its metadata sidecar. */
export interface ItemWithMetadata {
  item: Item;
  metadata: Metadata;
}

/** Metadata sidecar — tags and namespaced extensions. About / entity
 *  references are carried as first-class `about` edges; read via
 *  `item.edges.about` or `/items/:id/edges?edge_type=about`. */
export interface Metadata {
  item_id: string;
  tags: string[];
  extensions: Record<string, Record<string, unknown>>;
}

/** A frozen snapshot of an item's previous state. */
export interface Version {
  id: string;
  item_id: string;
  version: number;
  properties: Record<string, unknown>;
  created_at: string;
}

/**
 * A typed edge between two items. Direction: source is "from", target is "to".
 * See `packages/types/core/edges/*.json` for semantics per edge type.
 */
export interface Edge {
  id: string;
  source_id: string;
  target_id: string;
  edge_type: string;
  properties: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  /**
   * Optimistic-concurrency counter. Starts at 1 and moves on with every
   * update the server applies, whether or not the new properties differ
   * from the old — the write is what advances it, not a comparison of
   * content. So two reads showing the same version mean nothing was
   * written in between; two showing different versions mean a write
   * landed, not that anything about the edge is now different.
   *
   * Pass it back as the `version` precondition on `PATCH /edges/{id}`, which
   * requires it: an edit computed from a state the server has since left is
   * refused, and one that names no version at all is refused before that.
   *
   * Unlike an item's, an edge's version has no snapshot behind it — there
   * is no per-version history table for edges and no merge policy — so a
   * refusal hands back the whole current edge and the client re-applies.
   */
  version: number;
}

/** Input for creating a new edge. */
export interface CreateEdgeInput {
  source_id: string;
  target_id: string;
  edge_type: string;
  properties?: Record<string, unknown>;
  /** Explicit id override (otherwise server-generated UUIDv7). */
  id?: string;
}

/** Per-edge-type permission levels. */
export type EdgePermission = "read" | "write";

/**
 * Per-metadata-sub-resource permission levels. Today there are two,
 * `types` (gating type registration via `POST /types`) and `edge_types`
 * (gating `POST /edge-types`); future entries follow the same shape. Default `{}` — no access —
 * means the credential cannot mutate the metadata surface, whatever else it
 * holds.
 */
export type MetadataPermission = "read" | "write";

/**
 * A level on Category 2, Your profile. Leveled in the same sense as
 * metadata: read is a level rather than a free baseline, because the
 * category holds a person's name, email address and avatar.
 */
export type ProfilePermission = "read" | "write";

/** An API key record (without the key value itself). */
export interface ApiKey {
  id: string;
  label: string;
  /** Human-readable display name stamped onto items this credential writes. */
  source: string;
  /**
   * Operator-key gate. When `true`, the credential passes the fence in front
   * of the reserved-namespace types (`system.*` and `marfa.*`; `core.*` is
   * user-facing and carries no fence) — and meets its own empty type map
   * immediately after, which is what actually closes those writes to
   * everything. It does not admit reserved-namespace registration:
   * `POST /types` refuses a reserved-root type for every credential, the
   * operator key included — those types arrive with the build. The first
   * credential created at server install is the seed operator key; only an
   * existing operator key may mint another. Defaults to `false` for every
   * ordinary working credential.
   *
   * This is the whole instance tier: the routes that run the instance take
   * an operator key and nothing else, and no consent screen can offer one.
   */
  is_operator: boolean;
  /**
   * Per-credential schema-enforcement override. Same shape as
   * `InstanceConfig.enforcement`; a lever set here wins over the instance
   * config for this credential's writes and reads, lever by lever
   * (`resolveEnforcement`). Optional — most credentials inherit the instance
   * config without override.
   */
  enforcement_override?: EnforcementSettings;
  /** Tier stamped onto items when the client doesn't supply one. */
  default_tier: Tier;
  /**
   * The permissions this credential holds, as the literals themselves.
   *
   * A list rather than a map because a permission has no read/write
   * axis: it is held or it is not. Stored as the same shape a grant carries,
   * so one `hasPermission` answers for a key and for a sign-in and
   * neither door has to know which it is looking at.
   *
   * Absent or empty means the credential holds none, which is the correct
   * reading for an operator key as well: the instance tier is fenced off the
   * model rather than expressed inside it.
   */
  permissions?: Permission[];
  type_permissions: Record<string, TypePermission>;
  extension_permissions?: Record<string, ExtensionPermission>;
  /**
   * Per-edge-type permissions map. Keyed by edge type id (`parent-of`,
   * `about`, `karakeep.list-member`, …) or `*` for wildcard. Empty object
   * means no edge permissions granted, and a credential with no entries
   * cannot create, update or delete edges. The operator flag buys nothing
   * here — the edge gate never reads it — so a credential carrying it is
   * refused like any other holding no entries. Reads fall back to the source
   * item's `type_permissions`.
   */
  edge_permissions?: Record<string, EdgePermission>;
  /**
   * Per-metadata-sub-resource permissions map. Today `types` and
   * `edge_types` are surfaced, gating `POST /types` and `POST /edge-types`
   * for every credential. An empty
   * object means no metadata permissions granted, and nothing bypasses the
   * map. OAuth tokens carry the same map projected from the grant's
   * `metadata.<subresource>:<verb>` scopes.
   */
  metadata_permissions?: Record<string, MetadataPermission>;
  /**
   * Category 2, Your profile. Keyed on the row (`name`, `email`, `avatar`)
   * with the leveled parent keyed on `*`.
   *
   * Absent means the caller holds nothing on this category, which on a
   * leveled category means it may not read it either. Every credential is
   * held to this map: there is no rank that reads past it.
   */
  profile_permissions?: Record<string, ProfilePermission>;
  /**
   * The registered client that minted this key, when a signed-in app did.
   *
   * A key minted through a grant belongs to the app that asked for it, so
   * the keys page groups it under that app and revoking the app offers to
   * revoke it. Absent on a key a person or another key created directly.
   */
  oauth_client_id?: string;
  created_at: string;
  /**
   * Hard lifetime bound (ISO timestamp). A key past its `expires_at` is
   * refused at the bearer gate exactly like a revoked key. `null` (or
   * absent) means the key never expires, which is the shape of every key
   * a door mints.
   */
  expires_at?: string | null;
  last_used_at: string | null;
}

/** Input for creating a new API key. */
export interface CreateKeyInput {
  label: string;
  source: string;
  permissions?: Permission[];
  default_tier?: Tier;
  type_permissions?: Record<string, TypePermission>;
  extension_permissions?: Record<string, ExtensionPermission>;
  edge_permissions?: Record<string, EdgePermission>;
  metadata_permissions?: Record<string, MetadataPermission>;
  profile_permissions?: Record<string, ProfilePermission>;
  /** Per-credential schema-enforcement override; see `ApiKey`. */
  enforcement_override?: EnforcementSettings;
  /**
   * Optional. Only an existing operator key can set this to `true`; other
   * callers see the value silently coerced to `false`. The key minted at
   * server install is the seed operator key.
   */
  is_operator?: boolean;
}

/**
 * Input for in-place updating an API key (PATCH). All fields optional;
 * `source` is intentionally omitted, because it is baked into the provenance
 * of every item the credential has already written.
 *
 * An edit narrows and never widens: whatever it names is clamped to what the
 * caller itself holds, exactly as a mint is, so nothing can be widened by
 * editing what a first request could not have asked for.
 */
export interface UpdateKeyInput {
  label?: string;
  default_tier?: Tier;
  permissions?: Permission[];
  type_permissions?: Record<string, TypePermission>;
  extension_permissions?: Record<string, ExtensionPermission>;
  edge_permissions?: Record<string, EdgePermission>;
  metadata_permissions?: Record<string, MetadataPermission>;
  profile_permissions?: Record<string, ProfilePermission>;
  /** Per-credential schema-enforcement override; `null` clears it so the
   *  key inherits the instance config again. */
  enforcement_override?: EnforcementSettings | null;
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

/**
 * One page of a list or a search: the rows, and the cursor that continues
 * past them, `null` on the last page. A page can be short, or empty, with a
 * cursor still to follow, so a walk stops on `null` and never on a short
 * page.
 */
export interface PaginatedResult<T> {
  data: T[];
  next_cursor: string | null;
}

/** A search result with relevance scoring. */
export interface SearchResult {
  item: Item;
  metadata: Metadata;
  relevance_score: number;
  /** HTML snippet with `<mark>` tags highlighting matched terms. */
  snippet_html?: string;
}

/** Standard error response body. */
export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// Conflict resolution types (enriched 409 response)
// ---------------------------------------------------------------------------

/**
 * A snapshot of an item at one version, used in conflict responses.
 *
 * The three item fields ride beside the properties because the version
 * check covers them and `conflicting_fields` can name one: a client told
 * that `tier` collided and shown neither side's value has been named a
 * reason it cannot act on.
 */
export interface ConflictSnapshot {
  version: number;
  properties: Record<string, unknown>;
  tier: Tier;
  occurred_at: string;
  source_id: string | null;
}

/** Enriched 409 conflict response, which a client reads to resolve the conflict. */
export interface ConflictResponse {
  /**
   * `message` is prose for a person, and the only part of this envelope that
   * is. Everything else here is for the resolver, and a caller with no
   * resolution to offer — a `manual` strategy surfacing the refusal, a log
   * line, a support transcript — otherwise has to assemble a sentence out of
   * two version numbers and a field list before it can say anything at all.
   * Most do not, and show the raw code.
   *
   * Its content is not a contract: branch on `code`, never on this text.
   */
  error: { code: "version_conflict"; status: 409; message: string };
  current: ConflictSnapshot;
  ancestor: ConflictSnapshot;
  conflicting_fields: string[];
  /**
   * Resolved merge policy for the conflicting item's type, with inheritance
   * applied. Always present: the server is the authoritative resolver, so
   * a client reads policy directly from the response without a side-fetch or a
   * client-side cache. Strategies for fields not listed in `fields` fall back
   * to `default`, which itself defaults to `last_writer_wins` when absent.
   */
  merge_policy: MergePolicy;
}

/**
 * What the server did when it resolved a collision, reported on the 200.
 *
 * Present only on a write that actually resolved one. Without it the write
 * that spawned a sibling is indistinguishable from one that merged cleanly,
 * and no route reports what a write created — so the sibling exists with
 * nothing naming it, and an app cannot tell the person their edit was kept
 * somewhere else. It is also the only way a caller can reach the row it just
 * caused to exist.
 */
export interface ConflictResolutionReport {
  /** The fields that collided, sorted. */
  fields: string[];
  /** The strategy applied to each, keyed by field name. */
  strategy: Record<string, MergeStrategy>;
  /** The sibling carrying the losing values, when any field kept both. */
  conflicted_copy_id?: string;
}

/**
 * The refusal for a write whose base version can no longer be reconstructed.
 *
 * Carries the server's current state, because that is what a client needs to
 * re-read and re-apply its edit against, and carries no ancestor or field list
 * because there is genuinely none to give. A resolution is not offered: see
 * `ErrorCode.ANCESTOR_UNAVAILABLE` for why merging here is worse than
 * refusing.
 */
export interface AncestorUnavailableResponse {
  error: { code: "ancestor_unavailable"; status: 409; message: string };
  /** The server's state now, to re-apply the edit against. */
  current: ConflictSnapshot;
  /** The version the write was based on, whose snapshot is gone. */
  requested_version: number;
}

// ---------------------------------------------------------------------------
// Property sub-types
// ---------------------------------------------------------------------------

/** A binary attachment reference within item properties. */
export interface Attachment {
  blob_ref: string;
  mime_type: string;
  title?: string;
}

// ---------------------------------------------------------------------------
// Webhook types
// ---------------------------------------------------------------------------

/** A registered outbound webhook. */
export interface Webhook {
  id: string;
  url: string;
  secret: string;
  events: string[];
  type_filter?: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

/** Input for registering a webhook. */
export interface CreateWebhookInput {
  url: string;
  events: string[];
  type_filter?: string;
  secret?: string;
}

/** Input for updating a webhook. */
export interface UpdateWebhookInput {
  url?: string;
  events?: string[];
  type_filter?: string | null;
  active?: boolean;
}

/** A single webhook delivery attempt. */
export interface WebhookDelivery {
  id: string;
  webhook_id: string;
  event_type: string;
  status_code: number | null;
  attempt: number;
  succeeded: boolean;
  error: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Instance configuration
// ---------------------------------------------------------------------------

/**
 * Schema-enforcement levers. All three default off; flip on per-type to
 * tighten validation. Applied instance-wide by default; per-credential override
 * available via `ApiKey.enforcement_override`.
 *
 * - `strict_mode.types` — type IDs where unknown properties are rejected on
 *   write (strict object validation).
 * - `source_allowlist` — for the listed types, only items written from one of
 *   `sources` are accepted; everything else is rejected.
 * - `source_filter` — for the listed types, reads return only items whose
 *   source matches `sources`. Filter-only, not enforcement-on-write.
 */
export interface EnforcementSettings {
  strict_mode?: { types: string[] };
  source_allowlist?: { types: string[]; sources: string[] };
  source_filter?: { types: string[]; sources: string[] };
}

/** Instance configuration. Written through `/config` on `config.manage`. */
export interface InstanceConfig {
  enforcement?: EnforcementSettings;
  /**
   * Retention overrides for the cleanup jobs. Each falls back to the
   * instance env default when unset. Values must be non-negative; `0`
   * disables the job. Negative values are rejected at write.
   */
  audit_retention_days?: number;
  event_log_retention_hours?: number;
  trash_retention_days?: number;
  /**
   * Days to keep `system.activity` rows. A connector reports its runs as
   * activity, so on a busy instance this is the fastest-growing item type
   * by a wide margin, and nothing else ages it out.
   */
  activity_retention_days?: number;
}
