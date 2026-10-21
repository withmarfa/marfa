/**
 * The connected apps pages of the owner console, read from storage and drawn
 * by `app-pages.tsx`. Every page is the owner's: a browser without the owner's
 * session is sent to sign in by the console's gate, and a caller that is not
 * the owner is refused here. Disconnecting is done by the browser through the
 * public sign-in door.
 */
import { parseScope, grantCoversScope } from "@withmarfa/shared";
import { getPermissionBundles } from "../config.js";
import { grantExpiresAt } from "../auth/grant-expiry.js";
import { resolveChoosableTypes } from "./access-types.js";
import { Hono, type Context } from "hono";
import {
  findConnectedApp,
  listConnectedApps,
  type AppKind,
  type ConnectedApp,
} from "../auth/connected-apps.js";
import {
  keysMintedByApp,
  listActiveAppGrants,
} from "../auth/grant-lifecycle.js";
import { ownersLiveApp } from "../auth/sign-ins.js";
import * as clock from "../clock.js";
import { readInstanceName } from "../instance-name.js";
import { refuseUndeclaredKeysOf } from "../middleware/undeclared-query-keys.js";
import { requireDirectAuthority, type AppEnv } from "../middleware/auth.js";
import { dateWords, lastUsedValue, usedWords } from "../pages/key-time.js";
import {
  matchesQuery,
  paginate,
  parsePageNumber,
  parsePageSize,
} from "../pages/navigation.js";
import type { RegistryItem } from "../pages/registry.js";
import type { Storage } from "../storage/interface.js";
import { buildAccess, describeHeld } from "./access-model.js";
import { readAccessWords } from "./access-view.js";
import {
  APPS_HREF,
  KIND_WORDS,
  appHref,
  renderAppListPage,
  renderAppPage,
  renderMissingAppPage,
  type AppDetail,
  type KindFilter,
} from "./app-pages.js";
import { CONSOLE_PAGES } from "./console.js";
import { consoleContentSecurityPolicy } from "./content-security-policy.js";
import { homeSearchQuery } from "./home-page.js";
import { keyListRows, timeOf, withReads } from "./key-rows.js";

/** The most apps the picker beside an app's page lists. */
const MAX_SIBLINGS = 100;

const count = (n: number): string => `${String(n)} ${n === 1 ? "app" : "apps"}`;

CONSOLE_PAGES.register("apps", {
  href: APPS_HREF,
  hasItems: true,
  value: async ({ storage }) => {
    const owner = await storage.owner?.find();
    const apps = (await listActiveAppGrants(storage)).filter(
      (item) => ownersLiveApp(item, owner?.id ?? null) !== null,
    );
    return { text: apps.length === 0 ? "None" : count(apps.length) };
  },
});

const KINDS: readonly AppKind[] = ["app", "web", "cli"];

function kindOfQuery(raw: string | undefined): KindFilter {
  return KINDS.find((kind) => kind === raw) ?? "all";
}

const hostOf = (origin: string): string => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

/** What kind of app it is, for a row's line: "Web page at reader.example". */
function kindWords(app: ConnectedApp): string {
  if (app.kind !== "web") return KIND_WORDS[app.kind];
  const [first, ...more] = app.origins.map(hostOf);
  if (first === undefined) return KIND_WORDS.web;
  return more.length === 0
    ? `${KIND_WORDS.web} at ${first}`
    : `${KIND_WORDS.web} at ${first} and ${String(more.length)} more`;
}

export function appRoutes(storage: Storage) {
  const router = new Hono<AppEnv>();
  const send = (c: Context<AppEnv>): void => {
    c.header(
      "Content-Security-Policy",
      consoleContentSecurityPolicy(c.var.cspNonce),
    );
  };
  const ownerId = async (): Promise<string | null> =>
    (await storage.owner?.find())?.id ?? null;

  router.get("/apps", async (c) => {
    requireDirectAuthority(c);
    refuseUndeclaredKeysOf(c.req.url, ["kind", "q", "page", "size"]);
    const apps = await listConnectedApps(storage, await ownerId());
    const now = clock.nowMs();
    const kind = kindOfQuery(c.req.query("kind"));
    const query = homeSearchQuery(c.req.query("q"));
    const shown = apps
      .filter((app) => kind === "all" || app.kind === kind)
      .filter((app) => query === "" || matchesQuery(query, app.name));
    const pagination = paginate(
      shown.length,
      parsePageNumber(c.req.query("page")),
      parsePageSize(c.req.query("size")),
    );
    const slice = shown.slice(pagination.from, pagination.to);
    const words = await readAccessWords(
      storage,
      slice.flatMap((app) => app.scopes),
    );
    send(c);
    return c.html(
      renderAppListPage({
        nonce: c.var.cspNonce,
        instanceName: await readInstanceName(storage.settings),
        kind,
        query,
        total: apps.length,
        rows: slice.map((app) => {
          const summary =
            app.scopes.length === 0
              ? "No access"
              : describeHeld(app.scopes, words).summary;
          return {
            id: app.id,
            name: app.name,
            description: `${kindWords(app)}. ${summary}. Approved ${dateWords(Date.parse(app.grantedAt), now)}.`,
            value: usedWords(timeOf(app.lastUsedAt), now),
          };
        }),
        pagination,
      }),
    );
  });

  router.get("/apps/:id", async (c) => {
    requireDirectAuthority(c);
    refuseUndeclaredKeysOf(c.req.url, []);
    const id = c.req.param("id");
    const owner = await ownerId();
    const app = await findConnectedApp(storage, owner, id);
    const instanceName = await readInstanceName(storage.settings);
    send(c);
    if (app === null)
      return c.html(
        renderMissingAppPage({ nonce: c.var.cspNonce, instanceName }),
        404,
      );
    const now = clock.nowMs();
    const details: AppDetail[] = [
      {
        title: "Kind",
        value: KIND_WORDS[app.kind],
      },
      ...(app.origins.length > 0
        ? [
            {
              title: app.origins.length === 1 ? "Address" : "Addresses",
              value: app.origins.map(hostOf).join(", "),
            },
          ]
        : []),
      { title: "Approved", value: dateWords(Date.parse(app.grantedAt), now) },
      {
        title: "Ends if unused",
        value: (() => {
          const at = grantExpiresAt(
            app,
            c.var.config.grantInactivityDays ?? 365,
          );
          return at === null ? "Never" : dateWords(Date.parse(at), now);
        })(),
      },
      {
        title: "Last used",
        value: lastUsedValue(timeOf(app.lastUsedAt), now),
      },
    ];
    const made = (
      await keysMintedByApp(storage, { clientId: app.clientId })
    ).sort(
      (a, b) =>
        b.created_at.localeCompare(a.created_at) ||
        a.label.localeCompare(b.label),
    );
    const siblings: RegistryItem[] = (await listConnectedApps(storage, owner))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_SIBLINGS)
      .map((sibling) => ({ title: sibling.name, href: appHref(sibling.id) }));
    return c.html(
      renderAppPage({
        nonce: c.var.cspNonce,
        instanceName,
        id: app.id,
        name: app.name,
        details,
        scopes: app.scopes,
        access: buildAccess({
          scopes: withReads(app.scopes).flatMap((literal) => {
            const parsed = parseScope(literal);
            return parsed ? [parsed] : [];
          }),
          held: undefined,
          ...(await readAccessWords(storage, withReads(app.scopes))),
          chooseTypes: (await resolveChoosableTypes(storage, [])).filter(
            (type) => grantCoversScope(app.scopes, `${type.id}:read`),
          ),
          bundles: getPermissionBundles(),
          start: "held",
        }),
        keys: await keyListRows(storage, made, now, { maker: false }),
        siblings,
      }),
    );
  });

  return router;
}
