/**
 * The API keys pages of the owner console, read from storage and drawn by
 * `key-pages.tsx`. Every page is the owner's: a browser without the owner's
 * session is sent to sign in by the console's gate, and a caller that is not
 * the owner is refused here. The changes themselves are made by the browser
 * through the public key doors.
 */
import { Hono, type Context } from "hono";
import {
  parseScope,
  PERMISSIONS,
  resolveTypePermission,
  type ParsedScope,
} from "@withmarfa/shared";
import { keysInReach } from "../auth/key-reach.js";
import { listActiveAppGrants } from "../auth/grant-lifecycle.js";
import * as clock from "../clock.js";
import { getPermissionBundles } from "../config.js";
import { readInstanceName } from "../instance-name.js";
import { refuseUndeclaredKeysOf } from "../middleware/undeclared-query-keys.js";
import { requireDirectAuthority, type AppEnv } from "../middleware/auth.js";
import {
  matchesQuery,
  paginate,
  parsePageNumber,
  parsePageSize,
} from "../pages/navigation.js";
import {
  endChoicesFor,
  KEY_MAPS,
  keyFingerprint,
  type Denials,
  type KeyMap,
} from "../pages/key-body.js";
import {
  createdWords,
  endingTitle,
  endsSoon,
  endsWords,
  lastUsedValue,
  usedWords,
  dateWords,
} from "../pages/key-time.js";
import type { RegistryItem } from "../pages/registry.js";
import type { Storage, StoredApiKey } from "../storage/interface.js";
import { buildAccess, describeHeld } from "./access-model.js";
import type { AccessModel } from "./access-model.js";
import { resolveChoosableTypes } from "./access-types.js";
import { readAccessWords, scopesOfKey } from "./access-view.js";
import { CONSOLE_PAGES } from "./console.js";
import type { AttentionItem } from "./console.js";
import { consoleContentSecurityPolicy } from "./content-security-policy.js";
import { homeSearchQuery } from "./home-page.js";
import {
  KEYS_HREF,
  NEW_KEY_HREF,
  keyHref,
  renderCreateKeyPage,
  renderGoneKeyPage,
  renderKeyListPage,
  renderKeyPage,
  renderMissingKeyPage,
  type KeyDetail,
  type KeyListRow,
  type KeyTab,
} from "./key-pages.js";

/** The most keys the picker beside a key's page lists. */
const MAX_SIBLINGS = 100;

/** The literals the Create key page offers, each at both levels where it has them. */
const CREATE_LITERALS: readonly string[] = [
  "*:read",
  "*:write",
  "edge.*:read",
  "edge.*:write",
  "metadata:read",
  "metadata:write",
  "profile:read",
  "profile:write",
  ...PERMISSIONS,
];

/** The keys Home counts and warns about. Home is the owner's, who manages every key. */
async function liveKeys(storage: Storage): Promise<StoredApiKey[]> {
  return storage.keys.list();
}

const count = (n: number): string => `${String(n)} ${n === 1 ? "key" : "keys"}`;

CONSOLE_PAGES.register("keys", {
  href: KEYS_HREF,
  hasItems: true,
  settings: [
    {
      id: "create",
      title: "Create key",
      description: "A key for a script or tool",
      group: "API keys",
      href: NEW_KEY_HREF,
    },
  ],
  value: async ({ storage }) => {
    const keys = await liveKeys(storage);
    return { text: keys.length === 0 ? "None" : count(keys.length) };
  },
  attention: async ({ storage }) => {
    const now = clock.nowMs();
    const items: AttentionItem[] = [];
    for (const key of await liveKeys(storage)) {
      const ends = key.expires_at ? Date.parse(key.expires_at) : null;
      if (ends === null || !endsSoon(ends, now)) continue;
      items.push({
        title: endingTitle(key.label, ends, now),
        description: "Scripts using it will stop working",
        href: keyHref(key.id),
        tone: "warn",
      });
    }
    return items;
  },
});

const timeOf = (text: string | null | undefined): number | null => {
  if (!text) return null;
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : at;
};

/** The names of the apps that made keys, by registered client. */
async function appNames(
  storage: Storage,
  keys: readonly StoredApiKey[],
): Promise<Map<string, string | null>> {
  const ids = [
    ...new Set(
      keys.flatMap((key) =>
        key.oauth_client_id === undefined ? [] : [key.oauth_client_id],
      ),
    ),
  ];
  const names = new Map<string, string | null>();
  await Promise.all(
    ids.map(async (id) => {
      const client = await storage.oauthProvider?.getClient(id);
      names.set(id, client?.name ?? null);
    }),
  );
  return names;
}

/** The registered clients that still hold a live grant. */
async function connectedClients(storage: Storage): Promise<Set<string>> {
  const grants = await listActiveAppGrants(storage);
  return new Set(
    grants.flatMap((grant) =>
      typeof grant.properties.client_id === "string"
        ? [grant.properties.client_id]
        : [],
    ),
  );
}

/** The scopes a key holds with the read each write brings, so Read only is offered under Read and edit. */
function withReads(scopes: readonly string[]): string[] {
  const all = new Set(scopes);
  for (const literal of scopes)
    if (literal.endsWith(":write")) all.add(`${literal.slice(0, -6)}:read`);
  return [...all];
}

const parsed = (literals: readonly string[]): ParsedScope[] =>
  literals.flatMap((literal) => {
    const scope = parseScope(literal);
    return scope === null ? [] : [scope];
  });

/** Who made a key an app made, for its Details: the app's name, with a note once the app is no longer connected. */
function madeByWords(app: { name: string | null; connected: boolean }): string {
  if (app.connected && app.name !== null) return app.name;
  return app.name === null
    ? "An app that is no longer connected"
    : `${app.name}, no longer connected`;
}

/** "Made by X. ", or nothing for a key the owner made. */
function makerLine(
  key: StoredApiKey,
  names: ReadonlyMap<string, string | null>,
): string {
  if (key.oauth_client_id === undefined) return "";
  const name = names.get(key.oauth_client_id);
  return `Made by ${name ?? "an app"}. `;
}

function listRow(
  key: StoredApiKey,
  names: ReadonlyMap<string, string | null>,
  summary: string,
  now: number,
): KeyListRow {
  const ends = timeOf(key.expires_at);
  return {
    id: key.id,
    label: key.label,
    description: `${makerLine(key, names)}${summary}. ${endsWords(ends, now)}.`,
    endsSoon: endsSoon(ends, now),
    value: usedWords(timeOf(key.last_used_at), now),
  };
}

/** The denials a key holds, by map: the entries at `none`, which a scope cannot say. */
function denialsOf(key: StoredApiKey): Denials {
  const denials: Partial<Record<KeyMap, string[]>> = {};
  for (const map of KEY_MAPS) {
    const names = Object.entries(key[map])
      .filter(([, level]) => level === "none")
      .map(([name]) => name);
    if (names.length > 0) denials[map] = names;
  }
  return denials;
}

/** Whether the key's own write rules replace every lever the instance sets. */
function skipsWriteRules(key: StoredApiKey): boolean {
  const rules = key.enforcement_override;
  if (!rules) return false;
  return (
    rules.strict_mode?.types.length === 0 &&
    rules.source_allowlist?.types.length === 0 &&
    rules.source_allowlist.sources.length === 0 &&
    rules.source_filter?.types.length === 0 &&
    rules.source_filter.sources.length === 0
  );
}

export function keyRoutes(storage: Storage) {
  const router = new Hono<AppEnv>();
  const send = (c: Context<AppEnv>): void => {
    c.header(
      "Content-Security-Policy",
      consoleContentSecurityPolicy(c.var.cspNonce),
    );
  };

  router.get("/keys", async (c) => {
    requireDirectAuthority(c);
    refuseUndeclaredKeysOf(c.req.url, ["tab", "q", "page", "size"]);
    const keys = await keysInReach(storage, c).list();
    const now = clock.nowMs();
    const tab: KeyTab = c.req.query("tab") === "apps" ? "apps" : "yours";
    const query = homeSearchQuery(c.req.query("q"));
    const byTab = (key: StoredApiKey): boolean =>
      (key.oauth_client_id !== undefined) === (tab === "apps");
    const counts = {
      yours: keys.filter((key) => key.oauth_client_id === undefined).length,
      apps: keys.filter((key) => key.oauth_client_id !== undefined).length,
    };
    const shown = keys
      .filter(byTab)
      .filter((key) => query === "" || matchesQuery(query, key.label))
      .sort(
        (a, b) =>
          b.created_at.localeCompare(a.created_at) ||
          a.label.localeCompare(b.label),
      );
    const pagination = paginate(
      shown.length,
      parsePageNumber(c.req.query("page")),
      parsePageSize(c.req.query("size")),
    );
    const slice = shown.slice(pagination.from, pagination.to);
    const names = await appNames(storage, slice);
    const heldBy = new Map(slice.map((key) => [key.id, scopesOfKey(key)]));
    const words = await readAccessWords(
      storage,
      withReads([...heldBy.values()].flatMap((held) => held.scopes)),
    );
    send(c);
    return c.html(
      renderKeyListPage({
        nonce: c.var.cspNonce,
        instanceName: await readInstanceName(storage.settings),
        tab,
        query,
        counts,
        rows: slice.map((key) => {
          const held = heldBy.get(key.id) ?? scopesOfKey(key);
          const summary =
            held.scopes.length === 0
              ? "No access"
              : describeHeld(held.scopes, words, held).summary;
          return listRow(key, names, summary, now);
        }),
        pagination,
      }),
    );
  });

  router.get("/keys/new", async (c) => {
    requireDirectAuthority(c);
    refuseUndeclaredKeysOf(c.req.url, []);
    const words = await readAccessWords(storage, CREATE_LITERALS);
    const access: AccessModel = buildAccess({
      scopes: parsed(CREATE_LITERALS),
      held: undefined,
      ...words,
      chooseTypes: await resolveChoosableTypes(storage, []),
      bundles: getPermissionBundles(),
      start: "off",
    });
    send(c);
    return c.html(
      renderCreateKeyPage({
        nonce: c.var.cspNonce,
        instanceName: await readInstanceName(storage.settings),
        access,
      }),
    );
  });

  router.get("/keys/:id/copy", async (c) => {
    requireDirectAuthority(c);
    refuseUndeclaredKeysOf(c.req.url, []);
    const id = c.req.param("id");
    const found = (await keysInReach(storage, c).list()).find(
      (key) => key.id === id,
    );
    send(c);
    return c.html(
      renderGoneKeyPage({
        nonce: c.var.cspNonce,
        instanceName: await readInstanceName(storage.settings),
        keyId: found?.id,
      }),
    );
  });

  router.get("/keys/:id", async (c) => {
    requireDirectAuthority(c);
    refuseUndeclaredKeysOf(c.req.url, []);
    const id = c.req.param("id");
    const keys = await keysInReach(storage, c).list();
    const key = keys.find((candidate) => candidate.id === id);
    const instanceName = await readInstanceName(storage.settings);
    send(c);
    if (key === undefined)
      return c.html(
        renderMissingKeyPage({ nonce: c.var.cspNonce, instanceName }),
        404,
      );
    const now = clock.nowMs();
    const held = scopesOfKey(key);
    const scopes = withReads(held.scopes);
    const words = await readAccessWords(storage, scopes);
    const access =
      scopes.length === 0
        ? undefined
        : buildAccess({
            scopes: parsed(scopes),
            held: undefined,
            ...words,
            chooseTypes: (await resolveChoosableTypes(storage, [])).filter(
              (type) =>
                resolveTypePermission(type.id, key.type_permissions) !== "none",
            ),
            bundles: getPermissionBundles(),
            start: "held",
          });
    const deniedRows = describeHeld([], words, {
      denied: held.denied?.filter((literal) => !literal.startsWith("system.")),
    }).rows.map((row) => row.title);
    const names = await appNames(storage, [key]);
    const connected =
      key.oauth_client_id === undefined
        ? new Set<string>()
        : await connectedClients(storage);
    const madeBy =
      key.oauth_client_id === undefined
        ? undefined
        : {
            name: names.get(key.oauth_client_id) ?? null,
            connected: connected.has(key.oauth_client_id),
          };
    const ends = timeOf(key.expires_at);
    const extensions = Object.keys(key.extension_permissions);
    const details: KeyDetail[] = [
      { title: "Source", value: key.source },
      ...(key.sources.length > 0
        ? [{ title: "Also writes as", value: key.sources.join(", ") }]
        : []),
      ...(key.default_tier === "feed"
        ? [{ title: "Where its items land", value: "Feed" }]
        : []),
      ...(key.enforcement_override
        ? [
            {
              title: "Marfa's write rules",
              value: skipsWriteRules(key) ? "Skips them" : "Its own",
            },
          ]
        : []),
      ...(extensions.length > 0
        ? [
            {
              title: "Its own notes on your items",
              value: extensions.join(", "),
            },
          ]
        : []),
      {
        title: "Created",
        value: createdWords(Date.parse(key.created_at), now),
      },
      {
        title: "Last used",
        value: lastUsedValue(timeOf(key.last_used_at), now),
      },
      ...(madeBy === undefined
        ? []
        : [
            {
              title: "Made by",
              value: madeByWords(madeBy),
            },
          ]),
    ];
    const siblings: RegistryItem[] = keys
      .slice()
      .sort((a, b) => a.label.localeCompare(b.label))
      .slice(0, MAX_SIBLINGS)
      .map((sibling) => ({ title: sibling.label, href: keyHref(sibling.id) }));
    return c.html(
      renderKeyPage({
        nonce: c.var.cspNonce,
        instanceName,
        id: key.id,
        label: key.label,
        madeBy,
        details,
        ends: {
          current: ends === null ? null : dateWords(ends, now),
          iso: ends === null ? null : new Date(ends).toISOString(),
          choices: endChoicesFor(ends, now),
        },
        loaded: keyFingerprint(key),
        access,
        denied: {
          words: deniedRows,
          keep: JSON.stringify(denialsOf(key)),
        },
        siblings,
      }),
    );
  });

  return router;
}
