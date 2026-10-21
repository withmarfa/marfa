/**
 * The connectors pages of the owner console, read from storage and drawn by
 * `connector-pages.tsx`. Every page is the owner's: a browser without the
 * owner's session is sent to sign in by the console's gate, and a caller that
 * is not the owner is refused here.
 */
import { Hono } from "hono";
import { keysInReach } from "../auth/key-reach.js";
import * as clock from "../clock.js";
import { readInstanceName } from "../instance-name.js";
import { refuseUndeclaredKeysOf } from "../middleware/undeclared-query-keys.js";
import { requireDirectAuthority, type AppEnv } from "../middleware/auth.js";
import { agoWords, dateWords } from "../pages/key-time.js";
import {
  paginate,
  parsePageNumber,
  parsePageSize,
} from "../pages/navigation.js";
import type { RegistryItem } from "../pages/registry.js";
import type { Connector, Storage } from "../storage/interface.js";
import { CONSOLE_PAGES } from "./console.js";
import { consoleContentSecurityPolicy } from "./content-security-policy.js";
import {
  CONNECTORS_HREF,
  connectorHref,
  renderConnectorListPage,
  renderConnectorPage,
  renderMissingConnectorPage,
  type ConnectorDetail,
  type ConnectorNotice,
} from "./connector-pages.js";
import { connectorStatus, lastHeardAt } from "./connector-status.js";
import { keyHref } from "./key-pages.js";

/** The most connectors the picker beside a connector's page lists. */
const MAX_SIBLINGS = 100;

/** How many of a connector's runs its page lists. */
const RUNS_SHOWN = 10;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** "3 days" or "26 hours": how long a connector has said nothing. */
function silenceWords(connector: Connector, now: number): string {
  const silent = now - lastHeardAt(connector);
  const days = Math.floor(silent / DAY_MS);
  if (days >= 2) return `${String(days)} days`;
  const hours = Math.max(1, Math.floor(silent / HOUR_MS));
  return `${String(hours)} ${hours === 1 ? "hour" : "hours"}`;
}

/** "3 hours ago" at the start of a sentence or a value. */
const agoStart = (at: number, now: number): string =>
  agoWords(at, now).replace(/^./, (ch) => ch.toUpperCase());

const failedAt = (connector: Connector): string =>
  connector.last_run?.finished_at ?? connector.registered_at;

function problemCount(connector: Connector): string {
  const n = Object.keys(connector.problems).length;
  return `${String(n)} ${n === 1 ? "problem" : "problems"}`;
}

/** The line under a connector's name in the list: what it does and how it last fared. */
function listDescription(connector: Connector, now: number): string {
  const { state } = connectorStatus(connector, now);
  const run = connector.last_run;
  let how: string;
  if (state === "failing")
    how = `Last run failed ${agoWords(Date.parse(failedAt(connector)), now)}`;
  else if (state === "problems") how = `Reported ${problemCount(connector)}`;
  else if (state === "silent")
    how = `Last heard from ${agoWords(lastHeardAt(connector), now)}`;
  else if (run) how = `Last run ${agoWords(Date.parse(run.finished_at), now)}`;
  else how = "No runs yet";
  const what = connector.description?.trim().replace(/\.+$/, "");
  return what ? `${what}. ${how}.` : `${how}.`;
}

/** What a connector's page says first, when something needs a look. */
function noticeFor(
  connector: Connector,
  now: number,
): ConnectorNotice | undefined {
  const { state } = connectorStatus(connector, now);
  if (state === "failing")
    return {
      tone: "error",
      title: "The last run failed",
      description: connector.last_run?.error ?? undefined,
    };
  if (state === "problems")
    return { tone: "info", title: "The connector reported problems" };
  if (state === "silent")
    return {
      tone: "info",
      title: `Nothing heard for ${silenceWords(connector, now)}`,
      description: "Check that the program is still running on its machine.",
    };
  return undefined;
}

CONSOLE_PAGES.register("connectors", {
  href: CONNECTORS_HREF,
  hasItems: true,
  value: async ({ storage }) => {
    const connectors = await storage.connectors.list();
    if (connectors.length === 0) return { text: "None" };
    const now = clock.nowMs();
    const states = connectors.map((c) => connectorStatus(c, now).state);
    const failing = states.filter((state) => state === "failing").length;
    const looks = states.filter((state) => state !== "running").length;
    if (looks > 0)
      return {
        text: `${String(looks)} need${looks === 1 ? "s" : ""} a look`,
        tone: failing > 0 ? "danger" : "warn",
      };
    return { text: `${String(connectors.length)} running` };
  },
});

export function connectorRoutes(storage: Storage) {
  const router = new Hono<AppEnv>();

  router.get("/connectors", async (c) => {
    requireDirectAuthority(c);
    refuseUndeclaredKeysOf(c.req.url, ["page", "size"]);
    const connectors = await storage.connectors.list();
    const now = clock.nowMs();
    const pagination = paginate(
      connectors.length,
      parsePageNumber(c.req.query("page")),
      parsePageSize(c.req.query("size")),
    );
    c.header(
      "Content-Security-Policy",
      consoleContentSecurityPolicy(c.var.cspNonce),
    );
    return c.html(
      renderConnectorListPage({
        nonce: c.var.cspNonce,
        instanceName: await readInstanceName(storage.settings),
        rows: connectors.slice(pagination.from, pagination.to).map((one) => {
          const status = connectorStatus(one, now);
          return {
            id: one.id,
            name: one.name,
            description: listDescription(one, now),
            value: status.label,
            tone: status.tone,
          };
        }),
        pagination,
      }),
    );
  });

  router.get("/connectors/:id", async (c) => {
    requireDirectAuthority(c);
    refuseUndeclaredKeysOf(c.req.url, []);
    const id = c.req.param("id");
    const connector = await storage.connectors.get(id);
    const instanceName = await readInstanceName(storage.settings);
    c.header(
      "Content-Security-Policy",
      consoleContentSecurityPolicy(c.var.cspNonce),
    );
    if (connector === null)
      return c.html(
        renderMissingConnectorPage({ nonce: c.var.cspNonce, instanceName }),
        404,
      );
    const now = clock.nowMs();
    const key = (await keysInReach(storage, c).list()).find(
      (one) => one.id === connector.key_id,
    );
    const details: ConnectorDetail[] = [
      { title: "Source", value: connector.source },
      {
        title: "Registered",
        value: dateWords(Date.parse(connector.registered_at), now),
      },
      {
        title: "Last heartbeat",
        value:
          connector.last_heartbeat_at === null
            ? "Never"
            : agoStart(Date.parse(connector.last_heartbeat_at), now),
      },
      key
        ? { title: "Key it uses", value: key.label, href: keyHref(key.id) }
        : { title: "Key it uses", value: "A key that is gone" },
    ];
    const runs = await storage.connectors.listRuns(connector.id, {
      limit: RUNS_SHOWN,
    });
    const siblings: RegistryItem[] = (await storage.connectors.list())
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_SIBLINGS)
      .map((one) => ({ title: one.name, href: connectorHref(one.id) }));
    return c.html(
      renderConnectorPage({
        nonce: c.var.cspNonce,
        instanceName,
        id: connector.id,
        name: connector.name,
        description: connector.description,
        notice: noticeFor(connector, now),
        details,
        problems: Object.entries(connector.problems).map(
          ([title, description]) => ({ title, description }),
        ),
        runs: runs.data.map((run) => ({
          title: agoStart(Date.parse(run.finished_at), now),
          value: run.outcome === "failed" ? "Failed" : "Succeeded",
          failed: run.outcome === "failed",
          description:
            (run.outcome === "failed" ? run.error : run.summary) ?? undefined,
        })),
        siblings,
      }),
    );
  });

  return router;
}
