/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
/**
 * The All settings pages of the owner console: every setting by group, and
 * one group's settings. A secret shows only whether it is set, and no value
 * reaches this file for it to show.
 */
import {
  ConsolePage,
  EmptyState,
  ListToolbar,
  PageHeader,
  Row,
  RowGroup,
  SearchField,
} from "../pages/parts/index.js";
import type { RegistryItem } from "../pages/registry.js";
import { firstSentence, groupSlug } from "../pages/settings-links.js";
import { renderDocument } from "../pages/render.js";
import type { SettingGroup } from "../config.js";
import type { SettingEntry } from "./settings-routes.js";

export const SETTINGS_HREF = "/auth/owner/settings";

const TRAIL = { label: "All settings", href: SETTINGS_HREF } as const;

/** The address of one group's page, and of one setting on it. */
export const groupHref = (group: string, setting?: string): string =>
  `${SETTINGS_HREF}/${groupSlug(group)}${setting === undefined ? "" : `#${setting}`}`;

/** What a row says at its right end. A secret says only whether it is set. */
export function valueWords(entry: SettingEntry): string {
  if (entry.secret) return entry.set ? "Set" : "Not set";
  return entry.value ?? "Not set";
}

interface PageBase {
  nonce: string;
  instanceName: string;
  /** Where General is, once it is built. */
  generalHref: string | undefined;
}

interface GroupSummary {
  group: SettingGroup;
  entries: readonly SettingEntry[];
}

const count = (n: number, noun: string): string =>
  `${String(n)} ${noun}${n === 1 ? "" : "s"}`;

/** Of a group's settings, how many are set where Marfa runs, out of how many are. */
function setWhereRun(entries: readonly SettingEntry[]): {
  set: number;
  total: number;
  live: number;
} {
  const machine = entries.filter((entry) => !entry.live);
  return {
    set: machine.filter((entry) => entry.set).length,
    total: machine.length,
    live: entries.length - machine.length,
  };
}

const items = (groups: readonly GroupSummary[]): RegistryItem[] =>
  groups.map(({ group }) => ({ title: group, href: groupHref(group) }));

function SettingRow(props: { entry: SettingEntry; generalHref?: string }) {
  const { entry } = props;
  const common = {
    id: entry.name,
    title: entry.label,
    description: (
      <>
        {firstSentence(entry.description)} <code>{entry.name}</code>
        {entry.live && " You can change it in General."}
      </>
    ),
    value: valueWords(entry),
    valueAuto: true,
  };
  return entry.live && props.generalHref !== undefined ? (
    <Row {...common} href={props.generalHref} />
  ) : (
    <Row {...common} />
  );
}

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

export interface SettingsIndexParams extends PageBase {
  query: string;
  groups: readonly GroupSummary[];
  /** The settings that match a search, in the order of the groups. Empty when nothing was searched. */
  matches: readonly SettingEntry[];
}

export function SettingsIndexPage(props: SettingsIndexParams) {
  return (
    <ConsolePage
      title="All settings"
      nonce={props.nonce}
      instanceName={props.instanceName}
      trail={[{ label: "All settings" }]}
      pageId="settings"
      items={{ settings: items(props.groups) }}
    >
      <div class="stack-24">
        <PageHeader
          title="All settings"
          lede="Every setting Marfa reads. Most are set where Marfa runs; the few you can change while it runs are in General."
        />
        <ListToolbar
          action={SETTINGS_HREF}
          label="Search settings"
          search={
            <SearchField value={props.query} placeholder="Search settings" />
          }
        />
        {props.query === "" ? (
          <RowGroup>
            {props.groups.map(({ group, entries }) => {
              const { set } = setWhereRun(entries);
              return (
                <Row
                  title={group}
                  description={`${entries
                    .slice(0, 3)
                    .map((entry) => entry.label)
                    .join(", ")}${entries.length > 3 ? ", and more" : ""}`}
                  value={`${count(entries.length, "setting")}, ${String(set)} set`}
                  href={groupHref(group)}
                />
              );
            })}
          </RowGroup>
        ) : props.matches.length === 0 ? (
          <EmptyState
            title="No settings match"
            description="Try another word from the name, or its environment variable."
          />
        ) : (
          <RowGroup oneLine>
            {props.matches.map((entry) => (
              <Row
                title={entry.label}
                description={`${entry.group}. ${entry.name}`}
                value={valueWords(entry)}
                href={groupHref(entry.group, entry.name)}
              />
            ))}
          </RowGroup>
        )}
      </div>
    </ConsolePage>
  );
}

export const renderSettingsIndexPage = (params: SettingsIndexParams): string =>
  renderDocument(<SettingsIndexPage {...params} />);

// ---------------------------------------------------------------------------
// One group
// ---------------------------------------------------------------------------

export interface SettingsGroupParams extends PageBase {
  group: SettingGroup;
  entries: readonly SettingEntry[];
  groups: readonly GroupSummary[];
}

export function SettingsGroupPage(props: SettingsGroupParams) {
  const { set, total, live } = setWhereRun(props.entries);
  return (
    <ConsolePage
      title={props.group}
      nonce={props.nonce}
      instanceName={props.instanceName}
      trail={[TRAIL, { label: props.group }]}
      pageId="settings"
      items={{ settings: items(props.groups) }}
      currentItemHref={groupHref(props.group)}
    >
      <div class="stack-24">
        <PageHeader
          title={props.group}
          lede={`${String(set)} of ${String(total)} ${total === 1 ? "is" : "are"} set where Marfa runs. The rest use their standard values.${live > 0 ? ` ${count(live, "setting")} can also change in General.` : ""}`}
        />
        <RowGroup>
          {props.entries.map((entry) => (
            <SettingRow entry={entry} generalHref={props.generalHref} />
          ))}
        </RowGroup>
      </div>
    </ConsolePage>
  );
}

export const renderSettingsGroupPage = (params: SettingsGroupParams): string =>
  renderDocument(<SettingsGroupPage {...params} />);

export function SettingsMissingPage(props: PageBase) {
  return (
    <ConsolePage
      title="No such group"
      nonce={props.nonce}
      instanceName={props.instanceName}
      trail={[TRAIL, { label: "Not found" }]}
      pageId="settings"
    >
      <div class="stack-24">
        <EmptyState
          title="No such group of settings"
          description={<a href={SETTINGS_HREF}>See all settings</a>}
        />
      </div>
    </ConsolePage>
  );
}

export const renderSettingsMissingPage = (params: PageBase): string =>
  renderDocument(<SettingsMissingPage {...params} />);
