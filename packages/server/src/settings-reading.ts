/**
 * Every setting as the console shows it: its group, its name, whether the
 * environment states it, and its value in words.
 *
 * A secret's value is never read here. `readSettings` skips the resolved
 * value of every setting the schema flags as a secret, so it is not in the
 * result to be sent, logged or rendered by accident.
 */
import type {
  SettingDescription,
  SettingGroup,
  SettingRule,
} from "./config.js";

export interface SettingReading {
  /** The environment variable. */
  name: string;
  label: string;
  group: SettingGroup;
  description: string;
  secret: boolean;
  /** Its name in `PUT /config`, when the owner can also change it while the server runs. */
  live?: NonNullable<SettingDescription["live"]>;
  /** Whether the environment states it, as against the default standing. */
  set: boolean;
  /** Its value in words. Absent for a secret, and for a setting that resolves to nothing. */
  value?: string;
}

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const plural = (n: number, unit: string): string =>
  `${String(n)} ${unit}${n === 1 ? "" : "s"}`;

function milliseconds(ms: number): string {
  if (ms === 0) return "0 ms";
  for (const [size, unit] of [
    [DAY_MS, "day"],
    [HOUR_MS, "hour"],
    [MINUTE_MS, "minute"],
    [SECOND_MS, "second"],
  ] as const)
    if (ms % size === 0) return plural(ms / size, unit);
  return `${String(ms)} ms`;
}

function bytes(n: number): string {
  for (const [size, unit] of [
    [1024 ** 3, "GiB"],
    [1024 ** 2, "MiB"],
    [1024, "KiB"],
  ] as const)
    if (n >= size && n % size === 0) return `${String(n / size)} ${unit}`;
  return plural(n, "byte");
}

/** A setting's value in words, or `undefined` when it resolves to nothing. */
export function settingWords(
  rule: SettingRule,
  value: unknown,
  live: boolean,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "number") {
    if (rule.kind !== "count") return String(value);
    // Zero keeps things with no age limit.
    if (live && value === 0) return "Forever";
    if (rule.unit === "ms") return milliseconds(value);
    if (rule.unit === "bytes") return bytes(value);
    if (rule.unit === "days") return plural(value, "day");
    if (rule.unit === "hours") return plural(value, "hour");
    return String(value);
  }
  if (Array.isArray(value))
    return value.length === 0 ? undefined : value.join(", ");
  if (typeof value === "object") {
    const pairs = Object.entries(value).map(
      ([key, entry]) =>
        `${key}=${typeof entry === "object" ? JSON.stringify(entry) : String(entry)}`,
    );
    return pairs.length === 0 ? undefined : pairs.join(", ");
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function readSettings(
  described: readonly SettingDescription[],
  resolved: Readonly<Record<string, unknown>>,
  env: Readonly<Record<string, string | undefined>>,
): SettingReading[] {
  return described.map((setting) => {
    const stated = env[setting.name];
    const reading: SettingReading = {
      name: setting.name,
      label: setting.label,
      group: setting.group,
      description: setting.description,
      secret: setting.secret,
      ...(setting.live !== undefined && { live: setting.live }),
      set: stated !== undefined && stated.trim() !== "",
    };
    if (setting.secret) return reading;
    const value = settingWords(
      setting.rule,
      resolved[setting.name],
      setting.live !== undefined,
    );
    return value === undefined ? reading : { ...reading, value };
  });
}
