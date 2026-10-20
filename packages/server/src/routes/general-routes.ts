/**
 * The General page of the owner console: the instance's name and the
 * retention settings `PATCH /config` changes while the server runs, read from
 * the same configuration the housekeeping jobs read and drawn by
 * `general-pages.tsx`.
 */
import { Hono } from "hono";
import type { InstanceConfig } from "@withmarfa/shared";
import type { AppConfig } from "../config.js";
import { DEFAULT_INSTANCE_NAME } from "../instance-name.js";
import { refuseUndeclaredKeysOf } from "../middleware/undeclared-query-keys.js";
import { requireDirectAuthority, type AppEnv } from "../middleware/auth.js";
import { readInstanceConfig } from "../storage/instance-config.js";
import type { Storage } from "../storage/interface.js";
import { CONSOLE_PAGES } from "./console.js";
import { consoleContentSecurityPolicy } from "./content-security-policy.js";
import {
  GENERAL_HREF,
  renderGeneralPage,
  type KeepingRow,
  type RuleRow,
} from "./general-pages.js";

const count = (n: number, unit: string): string =>
  `${String(n)} ${unit}${n === 1 ? "" : "s"}`;

/** "Forever" for 0, which keeps things with no age limit. */
const daysWords = (days: number): string =>
  days === 0 ? "Forever" : count(days, "day");

/** The length of time in whole days when it is, else in hours. */
const hoursWords = (hours: number): string => {
  if (hours === 0) return "Forever";
  return hours % 24 === 0 ? count(hours / 24, "day") : count(hours, "hour");
};

type Field = keyof Pick<
  InstanceConfig,
  | "trash_retention_days"
  | "audit_retention_days"
  | "event_log_retention_hours"
  | "inbound_handled_retention_days"
  | "inbound_pending_retention_days"
>;

interface Keeping {
  field: Field;
  title: string;
  description: string;
  /** What the server uses when the configuration sets nothing. */
  standing: (config: AppConfig) => number;
  presets: readonly number[];
  words: (n: number) => string;
}

const KEEPING: readonly Keeping[] = [
  {
    field: "trash_retention_days",
    title: "Keep items in the trash",
    description: "After this, they're deleted for good",
    standing: (config) => config.trashRetentionDays,
    presets: [7, 30, 60, 90, 365],
    words: daysWords,
  },
  {
    field: "audit_retention_days",
    title: "Keep activity",
    description: "The record of every change, and what made it",
    standing: (config) => config.auditRetentionDays,
    presets: [30, 90, 365],
    words: daysWords,
  },
  {
    field: "event_log_retention_hours",
    title: "Let apps catch up on changes",
    description: "How far back an app that was offline can catch up",
    standing: (config) => config.eventLogRetentionHours ?? 168,
    presets: [24, 168, 720],
    words: hoursWords,
  },
  {
    field: "inbound_handled_retention_days",
    title: "Keep handled incoming webhooks",
    description: "Deliveries a connector has dealt with",
    standing: (config) => config.inbound?.handledRetentionDays ?? 7,
    presets: [1, 7, 30, 90],
    words: daysWords,
  },
  {
    field: "inbound_pending_retention_days",
    title: "Keep unhandled incoming webhooks",
    description: "Deliveries no connector has dealt with yet",
    standing: (config) => config.inbound?.pendingRetentionDays ?? 30,
    presets: [7, 30, 90, 365],
    words: daysWords,
  },
];

/**
 * The settings the page offers, each at the value the server uses now: what
 * the configuration sets, else the server's own. A value outside the presets
 * is offered too, so a setting made through the API shows as it is.
 */
export function keepingRows(
  config: AppConfig,
  stored: InstanceConfig | null,
): KeepingRow[] {
  return KEEPING.map((setting) => {
    const current = stored?.[setting.field] ?? setting.standing(config);
    // Zero keeps things with no age limit, so it is the longest.
    const longestLast = (n: number): number =>
      n === 0 ? Number.POSITIVE_INFINITY : n;
    const offered = [...new Set([...setting.presets, 0, current])].sort(
      (a, b) => longestLast(a) - longestLast(b),
    );
    return {
      field: setting.field,
      title: setting.title,
      description: setting.description,
      value: String(current),
      options: offered.map((n) => ({
        value: String(n),
        label: setting.words(n),
      })),
    };
  });
}

const LEVERS: readonly [
  "strict_mode" | "source_allowlist" | "source_filter",
  string,
][] = [
  ["strict_mode", "Reject unknown properties"],
  ["source_allowlist", "Limit where new items come from"],
  ["source_filter", "Hide items from other sources"],
];

export function ruleRows(stored: InstanceConfig | null): RuleRow[] {
  return LEVERS.map(([lever, title]) => {
    const types = stored?.enforcement?.[lever]?.types.length ?? 0;
    return {
      title,
      value:
        types === 0 ? "Off for every type" : `On for ${count(types, "type")}`,
    };
  });
}

/** The release if the build has one, else the commit, else a note that this is not a release. */
export function versionWords(
  config: Pick<AppConfig, "releaseVersion" | "versionSha">,
): string {
  if (config.releaseVersion !== undefined) return config.releaseVersion;
  return config.versionSha !== undefined
    ? config.versionSha.slice(0, 7)
    : "Development build";
}

export function generalName(stored: InstanceConfig | null): string {
  return stored?.name ?? DEFAULT_INSTANCE_NAME;
}

CONSOLE_PAGES.register("general", {
  href: GENERAL_HREF,
  settings: [
    {
      id: "name",
      title: "Name",
      description: "Shown on these pages and to apps you approve",
      group: "General",
      href: `${GENERAL_HREF}#general-name`,
    },
    {
      id: "trash",
      title: "Keep items in the trash",
      description: "How long before they're deleted for good",
      group: "General",
      href: `${GENERAL_HREF}#general-trash_retention_days`,
    },
    {
      id: "activity",
      title: "Keep activity",
      description: "How long the record of every change is kept",
      group: "General",
      href: `${GENERAL_HREF}#general-audit_retention_days`,
    },
  ],
  value: async ({ storage }) => ({
    text: generalName(await readInstanceConfig(storage.settings)),
  }),
});

export function generalRoutes(storage: Storage, config: AppConfig) {
  const router = new Hono<AppEnv>();
  router.get("/general", async (c) => {
    requireDirectAuthority(c);
    refuseUndeclaredKeysOf(c.req.url, []);
    const stored = await readInstanceConfig(storage.settings);
    c.header(
      "Content-Security-Policy",
      consoleContentSecurityPolicy(c.var.cspNonce),
    );
    return c.html(
      renderGeneralPage({
        nonce: c.var.cspNonce,
        instanceName: generalName(stored),
        keeping: keepingRows(config, stored),
        rules: ruleRows(stored),
        about: {
          address: new URL(config.authBaseUrl).host,
          version: versionWords(config),
        },
      }),
    );
  });
  return router;
}
