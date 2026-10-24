/**
 * The saved settings that name a type: a folder's or a view's query, a
 * folder's defaults and first placements, and a webhook's type filter. A type
 * delete is refused while one names the type, and a type move rewrites them
 * once every item has moved.
 */
import {
  directChildrenOf,
  hasPermission,
  resolveTypePermission,
  rewriteTypeTerms,
} from "@withmarfa/shared";
import type { ApiKey, Item } from "@withmarfa/shared";
import type { LiveCredential } from "../auth/live-credential.js";
import type { Context } from "hono";
import type { AppEnv } from "../middleware/auth.js";
import { holdsPermission, oauthGrantOf } from "../middleware/auth.js";
import { keysInReach } from "../auth/key-reach.js";
import type {
  Storage,
  StoredWebhook,
  WebhookOwner,
} from "../storage/interface.js";
import { listActiveAppGrants } from "../auth/grant-lifecycle.js";
import { writeItem } from "../storage/item-write.js";
import {
  DELIVERY_CANCELED,
  subscriptionSelects,
} from "../webhooks/delivery.js";

const FOLDER_TYPE = "system.folder";
const VIEW_TYPE = "system.view";
const PAGE = 200;

export type SettingKind = "folder" | "view" | "webhook";

/** Why a move can't rewrite a setting. */
export type BlockedReason =
  "not_permitted" | "filter_term" | "placement_conflict" | "subtypes";

export interface TypeSetting {
  kind: SettingKind;
  id: string;
  /** The setting's field, such as `query.types`. */
  field: string;
  reason?: BlockedReason;
  message?: string;
}

type Rewrite =
  | {
      kind: "folder" | "view";
      id: string;
      properties: Record<string, unknown>;
    }
  | { kind: "webhook"; id: string; type_filter: string };

export interface SettingsPlan {
  /** Every setting that names the type, each with a reason where it can't be rewritten. */
  settings: TypeSetting[];
  rewrites: Rewrite[];
}

export interface TypeGrant {
  kind: "key" | "app";
  id: string;
  label?: string;
}

/** Who asks: a credential, or the owner's own authority, which changes every setting. */
export type SettingsActor = LiveCredential | null;

function mayWriteType(key: ApiKey, type: string): boolean {
  return resolveTypePermission(type, key.type_permissions) === "write";
}

function isMaker(key: ApiKey, owner: WebhookOwner): boolean {
  const grant = oauthGrantOf(key);
  if (grant === null) return owner.kind === "key" && owner.keyId === key.id;
  return (
    owner.kind === "grant" &&
    owner.clientId === grant.clientId &&
    owner.authUserId === grant.authUserId
  );
}

async function liveRows(storage: Storage, type: string): Promise<Item[]> {
  const rows: Item[] = [];
  let cursor: string | undefined;
  do {
    const page = await storage.items.list({
      type,
      state: "active",
      limit: PAGE,
      cursor,
    });
    rows.push(...page.data);
    cursor = page.next_cursor ?? undefined;
  } while (cursor !== undefined);
  return rows;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * What one folder or view needs: each field naming `from`, and with `to`, the
 * properties that rewrite them. Without `to`, only what names the type.
 */
function planItem(
  kind: "folder" | "view",
  row: Item,
  from: string,
  to: string | null,
  hasSubtypes: boolean,
): { settings: TypeSetting[]; properties: Record<string, unknown> } {
  const settings: TypeSetting[] = [];
  const properties: Record<string, unknown> = {};
  const name = (
    field: string,
    blocked?: Omit<TypeSetting, "kind" | "id" | "field">,
  ) => settings.push({ kind, id: row.id, field, ...blocked });

  const query = record(row.properties.query);
  const queryTypes: unknown[] = Array.isArray(query?.types) ? query.types : [];
  let nextQuery: Record<string, unknown> | undefined;
  if (query !== undefined && queryTypes.includes(from)) {
    name("query.types");
    if (to !== null) {
      const types = hasSubtypes
        ? [...queryTypes, to]
        : queryTypes.map((type: unknown) => (type === from ? to : type));
      nextQuery = { ...query, types: [...new Set(types)] };
    }
  }
  if (query !== undefined && typeof query.filter === "string") {
    const named = rewriteTypeTerms(query.filter, from, from).rewritten;
    if (to === null) {
      if (named) name("query.filter");
    } else {
      const rewrite = rewriteTypeTerms(query.filter, from, to);
      if (rewrite.unsafe.length > 0) {
        name("query.filter", {
          reason: "filter_term",
          message: `The filter term ${rewrite.unsafe.join(", ")} answers differently once the items are ${to}. Change the filter first.`,
        });
      } else if (rewrite.rewritten) {
        name("query.filter");
        nextQuery = { ...(nextQuery ?? query), filter: rewrite.filter };
      }
    }
  }
  if (nextQuery !== undefined) properties.query = nextQuery;

  if (kind === "folder") {
    const defaults = record(row.properties.defaults);
    if (defaults?.type === from) {
      name("defaults.type");
      if (to !== null) properties.defaults = { ...defaults, type: to };
    }
    const placement = record(row.properties.first_placement);
    const dir = placement?.[from];
    if (placement !== undefined && typeof dir === "string") {
      const existing = to === null ? undefined : placement[to];
      if (to === null) {
        name("first_placement");
      } else if (typeof existing === "string" && existing !== dir) {
        name("first_placement", {
          reason: "placement_conflict",
          message: `It places ${from} in "${dir}" and ${to} in "${existing}". Remove one first.`,
        });
      } else {
        name("first_placement");
        properties.first_placement = Object.fromEntries(
          Object.entries({ ...placement, [to]: dir }).filter(
            ([type]) => hasSubtypes || type !== from,
          ),
        );
      }
    }
  }
  return { settings, properties };
}

function planWebhook(
  webhook: StoredWebhook,
  from: string,
  to: string | null,
  hasSubtypes: boolean,
): { setting: TypeSetting; rewrite?: Rewrite } | null {
  if (webhook.type_filter !== from) return null;
  const setting: TypeSetting = {
    kind: "webhook",
    id: webhook.id,
    field: "type_filter",
  };
  if (to === null) return { setting };
  if (hasSubtypes) {
    return {
      setting: {
        ...setting,
        reason: "subtypes",
        message: `${from} has subtypes, and one type filter can't name both ${from} and ${to}. Change the webhook first.`,
      },
    };
  }
  return {
    setting,
    rewrite: { kind: "webhook", id: webhook.id, type_filter: to },
  };
}

function notPermitted(setting: TypeSetting, message: string): TypeSetting {
  return { ...setting, reason: "not_permitted", message };
}

/**
 * Every setting naming `from` and, with `to`, how a move rewrites each. A
 * setting the actor may not change is named with `not_permitted`, as its own
 * door would refuse it. A revoked folder or view never changes, so it is left
 * out.
 */
export async function planSettings(
  storage: Storage,
  from: string,
  to: string | null,
  actor: SettingsActor,
): Promise<SettingsPlan> {
  const hasSubtypes = directChildrenOf(from).length > 0;
  const settings: TypeSetting[] = [];
  const rewrites: Rewrite[] = [];
  const key = actor?.key;

  for (const [kind, type] of [
    ["folder", FOLDER_TYPE],
    ["view", VIEW_TYPE],
  ] as const) {
    const allowed = key === undefined || mayWriteType(key, type);
    for (const row of await liveRows(storage, type)) {
      const planned = planItem(kind, row, from, to, hasSubtypes);
      if (planned.settings.length === 0) continue;
      settings.push(
        ...planned.settings.map((setting) =>
          allowed || to === null || setting.reason !== undefined
            ? setting
            : notPermitted(
                setting,
                `Changing a ${kind} takes write on ${type}, which your key doesn't have.`,
              ),
        ),
      );
      if (Object.keys(planned.properties).length > 0)
        rewrites.push({ kind, id: row.id, properties: planned.properties });
    }
  }

  const manages =
    actor === null || hasPermission(actor.permissions, "webhooks.manage");
  for (const webhook of await storage.outboundWebhooks.list()) {
    const planned = planWebhook(webhook, from, to, hasSubtypes);
    if (planned === null) continue;
    const allowed =
      key === undefined || (manages && isMaker(key, webhook.owner));
    settings.push(
      allowed || to === null || planned.setting.reason !== undefined
        ? planned.setting
        : notPermitted(
            planned.setting,
            "Only the key or app that made a webhook changes it, with webhooks.manage.",
          ),
    );
    if (planned.rewrite) rewrites.push(planned.rewrite);
  }
  return { settings, rewrites };
}

export function blockedSettings(plan: SettingsPlan): TypeSetting[] {
  return plan.settings.filter((setting) => setting.reason !== undefined);
}

/**
 * Writes every rewrite in a plan with no blocked setting, inside the caller's
 * transaction: the folders and views through the item write, so each gets a
 * version and an event, and the webhooks as their own door changes them.
 */
export async function applySettings(
  storage: Storage,
  plan: SettingsPlan,
  actor: SettingsActor,
): Promise<void> {
  if (blockedSettings(plan).length > 0)
    throw new Error("A plan with a blocked setting is never applied");
  const by =
    actor === null ? null : { kind: "credential" as const, key: actor.key };
  for (const rewrite of plan.rewrites) {
    if (rewrite.kind === "webhook") {
      const next = await storage.outboundWebhooks.update(rewrite.id, {
        type_filter: rewrite.type_filter,
      });
      await storage.outboundWebhookDeliveries.cancelUnselected(
        rewrite.id,
        (eventType, frame) => subscriptionSelects(next, eventType, frame),
        DELIVERY_CANCELED.unselected,
      );
      continue;
    }
    const written = await writeItem(
      storage,
      { kind: "platform", by },
      {
        op: "update",
        id: rewrite.id,
        properties: rewrite.properties,
        ...(rewrite.kind === "folder" && { prune_undeclared_properties: true }),
      },
    );
    if (written.outcome !== "updated")
      throw new Error(`A ${rewrite.kind} rewrite answered ${written.outcome}`);
  }
}

/**
 * The keys and apps whose grants name the type outright, which a move or a
 * delete leaves as they are. Keys are listed to a caller that may manage them,
 * and apps to one that may manage grants.
 */
export async function typeGrants(
  storage: Storage,
  c: Context<AppEnv>,
  type: string,
): Promise<TypeGrant[]> {
  const grants: TypeGrant[] = [];
  if (holdsPermission(c, "keys.manage")) {
    for (const key of await keysInReach(storage, c).list()) {
      if (Object.hasOwn(key.type_permissions, type))
        grants.push({ kind: "key", id: key.id, label: key.label });
    }
  }
  if (holdsPermission(c, "grants.manage")) {
    for (const app of await listActiveAppGrants(storage)) {
      const scopes = app.properties.scopes;
      const clientId = app.properties.client_id;
      if (
        typeof clientId === "string" &&
        Array.isArray(scopes) &&
        scopes.some(
          (scope) =>
            typeof scope === "string" &&
            scope.slice(0, scope.lastIndexOf(":")) === type,
        )
      )
        grants.push({ kind: "app", id: clientId });
    }
  }
  return grants;
}
