/**
 * The All settings pages of the owner console, and the owner's own read of
 * every setting, drawn from the settings schema in `config.ts`.
 *
 * A secret's value is never read here. `config.settingReadings` holds none
 * for a secret, so no page and no answer can carry one: they say only whether
 * it is set.
 */
import { Hono } from "hono";
import { SETTING_GROUPS, describeSettings, type AppConfig } from "../config.js";
import { readInstanceName } from "../instance-name.js";
import { refuseUndeclaredKeysOf } from "../middleware/undeclared-query-keys.js";
import { requireDirectAuthority, type AppEnv } from "../middleware/auth.js";
import { matchesQuery } from "../pages/navigation.js";
import { firstSentence, groupSlug } from "../pages/settings-links.js";
import { readInstanceConfig } from "../storage/instance-config.js";
import type { Storage } from "../storage/interface.js";
import { settingWords, type SettingReading } from "../settings-reading.js";
import { homeSearchQuery } from "./home-page.js";
import { CONSOLE_PAGES } from "./console.js";
import { consoleContentSecurityPolicy } from "./content-security-policy.js";
import {
  SETTINGS_HREF,
  groupHref,
  renderSettingsGroupPage,
  renderSettingsIndexPage,
  renderSettingsMissingPage,
} from "./settings-pages.js";

/** One setting as the console and `GET /auth/owner/settings.json` give it. */
export interface SettingEntry extends Omit<SettingReading, "live"> {
  /** The owner can change it in General while Marfa runs. */
  live: boolean;
}

const BY_NAME = new Map(describeSettings().map((s) => [s.name, s.rule]));

/** Every setting in the schema, each at the value Marfa uses now. */
export async function readSettingEntries(
  storage: Storage,
  config: AppConfig,
): Promise<SettingEntry[]> {
  const stored = await readInstanceConfig(storage.settings);
  return (config.settingReadings ?? []).map(({ live, ...reading }) => {
    if (live === undefined) return { ...reading, live: false };
    const changed = stored?.[live];
    const rule = BY_NAME.get(reading.name);
    if (changed === undefined || rule === undefined)
      return { ...reading, live: true };
    const value = settingWords(rule, changed, true);
    return {
      ...reading,
      live: true,
      set: true,
      ...(value !== undefined && { value }),
    };
  });
}

/** The settings by group, in the order of the groups, empty groups left out. */
function inGroups(entries: readonly SettingEntry[]) {
  return SETTING_GROUPS.flatMap((group) => {
    const held = entries.filter((entry) => entry.group === group);
    return held.length === 0 ? [] : [{ group, entries: held }];
  });
}

CONSOLE_PAGES.register("settings", {
  href: SETTINGS_HREF,
  hasItems: true,
  settings: describeSettings().map((setting) => ({
    id: setting.name,
    title: setting.label,
    description: firstSentence(setting.description),
    group: setting.group,
    href: groupHref(setting.group, setting.name),
  })),
});

export function settingsRoutes(storage: Storage, config: AppConfig) {
  const router = new Hono<AppEnv>();

  router.get("/settings", async (c) => {
    requireDirectAuthority(c);
    refuseUndeclaredKeysOf(c.req.url, ["q"]);
    const entries = await readSettingEntries(storage, config);
    const query = homeSearchQuery(c.req.query("q"));
    c.header(
      "Content-Security-Policy",
      consoleContentSecurityPolicy(c.var.cspNonce),
    );
    return c.html(
      renderSettingsIndexPage({
        nonce: c.var.cspNonce,
        instanceName: await readInstanceName(storage.settings),
        generalHref: CONSOLE_PAGES.registry.page("general")?.href,
        query,
        groups: inGroups(entries),
        matches:
          query === ""
            ? []
            : inGroups(entries)
                .flatMap((held) => held.entries)
                .filter((entry) =>
                  matchesQuery(
                    query,
                    `${entry.label} ${entry.name} ${entry.group} ${entry.description}`,
                  ),
                ),
      }),
    );
  });

  router.get("/settings.json", async (c) => {
    requireDirectAuthority(c);
    refuseUndeclaredKeysOf(c.req.url, []);
    return c.json({
      data: inGroups(await readSettingEntries(storage, config)).flatMap(
        (held) => held.entries,
      ),
    });
  });

  router.get("/settings/:group", async (c) => {
    requireDirectAuthority(c);
    refuseUndeclaredKeysOf(c.req.url, []);
    const groups = inGroups(await readSettingEntries(storage, config));
    const slug = c.req.param("group");
    const held = groups.find(
      (candidate) => groupSlug(candidate.group) === slug,
    );
    const base = {
      nonce: c.var.cspNonce,
      instanceName: await readInstanceName(storage.settings),
      generalHref: CONSOLE_PAGES.registry.page("general")?.href,
    };
    c.header(
      "Content-Security-Policy",
      consoleContentSecurityPolicy(c.var.cspNonce),
    );
    if (held === undefined) return c.html(renderSettingsMissingPage(base), 404);
    return c.html(
      renderSettingsGroupPage({
        ...base,
        group: held.group,
        entries: held.entries,
        groups,
      }),
    );
  });

  return router;
}
