/**
 * The Health page of the owner console, read from the same answers `GET
 * /health` and `GET /housekeeping` give and drawn by `health-pages.tsx`.
 */
import { Hono } from "hono";
import { HOUSEKEEPING_JOBS } from "../housekeeping/metadata.js";
import { readInstanceName } from "../instance-name.js";
import * as clock from "../clock.js";
import { refuseUndeclaredKeysOf } from "../middleware/undeclared-query-keys.js";
import { requireDirectAuthority, type AppEnv } from "../middleware/auth.js";
import { usedWords } from "../pages/key-time.js";
import type { HousekeepingRow, Storage } from "../storage/interface.js";
import type { ConsoleHealth } from "./console-health.js";
import { CONSOLE_PAGES } from "./console.js";
import type { AttentionItem, ConsoleReads, HomeValue } from "./console.js";
import { consoleContentSecurityPolicy } from "./content-security-policy.js";
import type { ComponentStatus, Status } from "./health.js";
import {
  HEALTH_HREF,
  renderHealthPage,
  type HealthTone,
  type JobRow,
  type NowRow,
} from "./health-pages.js";

/** Home waits two seconds for a page, so its check of the object store gives up sooner. */
const HOME_OBJECT_STORE_BUDGET_MS = 1500;

interface Check {
  title: string;
  /** What it checks, in a few words. */
  about: string;
  /** What the right end says and the line under the title, by status. */
  says: Record<Exclude<Status, "ok">, { word: string; because: string }>;
  /** The title Needs attention gives it, by status. */
  alert: Record<Exclude<Status, "ok">, string>;
}

const CHECKS = {
  database: {
    title: "Database",
    about: "Where your items are kept",
    says: {
      degraded: {
        word: "Slow",
        because: "It's answering slowly. It may be busy.",
      },
      down: { word: "Not working", because: "It isn't answering." },
    },
    alert: {
      degraded: "The database is slow",
      down: "The database isn't working",
    },
  },
  database_write: {
    title: "Saving changes",
    about: "Writing new and changed items",
    says: {
      degraded: {
        word: "Slow",
        because: "Saving is slow. The database may be busy.",
      },
      down: { word: "Not working", because: "Changes can't be saved." },
    },
    alert: {
      degraded: "Saving changes is slow",
      down: "Changes can't be saved",
    },
  },
  disk: {
    title: "Disk",
    about: "Space for the database and files",
    says: {
      degraded: {
        word: "Nearly full",
        because: "Space is running low, or Marfa can't read how much is left.",
      },
      down: {
        word: "Full",
        because: "Almost no space is left, so changes can't be saved.",
      },
    },
    alert: {
      degraded: "The disk is nearly full",
      down: "The disk is full",
    },
  },
  blob_storage: {
    title: "File storage",
    about: "Where files are kept",
    says: {
      degraded: { word: "Slow", because: "It's answering slowly." },
      down: { word: "Not working", because: "Files can't be read or saved." },
    },
    alert: {
      degraded: "File storage is slow",
      down: "File storage isn't working",
    },
  },
  object_store: {
    title: "Object store",
    about: "A second place where files are kept",
    says: {
      degraded: { word: "Slow", because: "It's answering slowly." },
      down: { word: "Not working", because: "Marfa can't reach it." },
    },
    alert: {
      degraded: "The object store is slow",
      down: "Marfa can't reach the object store",
    },
  },
} satisfies Record<string, Check>;

type CheckName = keyof typeof CHECKS;

const toneOf = (status: Status): HealthTone | undefined =>
  status === "ok" ? undefined : status === "down" ? "danger" : "warn";

/** The checks in the order the page lists them, from what `readHealth` and the object store answered. */
function checksFrom(
  components: Readonly<Record<string, ComponentStatus>>,
  objectStore: ComponentStatus | null,
): { name: CheckName; status: Status }[] {
  const named: [CheckName, ComponentStatus | null | undefined][] = [
    ["database", components.database],
    ["database_write", components.database_write],
    ["disk", components.disk],
    ["blob_storage", components.blob_storage],
    ["object_store", objectStore],
  ];
  return named.flatMap(([name, found]) =>
    found ? [{ name, status: found.status }] : [],
  );
}

export function nowRows(
  components: Readonly<Record<string, ComponentStatus>>,
  objectStore: ComponentStatus | null,
): NowRow[] {
  return checksFrom(components, objectStore).map(({ name, status }) => {
    const check = CHECKS[name];
    if (status === "ok")
      return {
        title: check.title,
        description: check.about,
        word: "Working",
      };
    return {
      title: check.title,
      description: check.says[status].because,
      word: check.says[status].word,
      tone: toneOf(status),
    };
  });
}

const everyWords = (ms: number): string => {
  const units: [string, number][] = [
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
    ["second", 1000],
  ];
  for (const [unit, size] of units) {
    if (ms < size) continue;
    const n = Math.round(ms / size);
    return n === 1 ? `every ${unit}` : `every ${String(n)} ${unit}s`;
  }
  return `every ${String(ms)} milliseconds`;
};

/** "audit-cleanup" as "Audit cleanup". */
const jobTitle = (name: string): string =>
  name.charAt(0).toUpperCase() + name.slice(1).replaceAll("-", " ");

const jobAbout = (name: string): string =>
  (HOUSEKEEPING_JOBS as Record<string, { description: string } | undefined>)[
    name
  ]?.description ?? "";

const failed = (job: HousekeepingRow): boolean => job.last_outcome === "error";

const timeOf = (text: string | null): number | null => {
  if (text === null) return null;
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : at;
};

/** The jobs as the page lists them: those whose last run failed first, then by name. */
export function jobRows(
  jobs: readonly HousekeepingRow[],
  now: number,
): JobRow[] {
  return [...jobs]
    .sort(
      (a, b) =>
        Number(failed(b)) - Number(failed(a)) || a.name.localeCompare(b.name),
    )
    .map((job) => {
      const finished = timeOf(job.last_finished_at);
      const base = { name: job.name, title: jobTitle(job.name) };
      if (failed(job))
        return {
          ...base,
          description: job.last_error ?? "The last run failed.",
          descriptionTone: "danger" as const,
          value:
            finished === null
              ? "Failed"
              : `Failed ${usedWords(finished, now).replace(/^Used /, "")}`,
          valueTone: "danger" as const,
        };
      const about = `${jobAbout(job.name)} Runs ${everyWords(job.interval_ms)}.`;
      const value =
        job.running_since !== null
          ? "Running now"
          : finished === null
            ? "Not run yet"
            : `Ran ${usedWords(finished, now).replace(/^Used /, "")}`;
      return { ...base, description: about.trim(), value };
    });
}

/** What Home says at the right of the Health row. */
export function healthValue(
  checks: readonly { status: Status }[],
  jobs: readonly HousekeepingRow[],
): HomeValue {
  if (checks.some((check) => check.status === "down"))
    return { text: "Not working", tone: "danger" };
  if (checks.some((check) => check.status === "degraded") || jobs.some(failed))
    return { text: "Needs a look", tone: "warn" };
  return { text: "Working" };
}

/** What Needs attention lists: a check that found a problem, and a job whose last run failed. */
export function healthAttention(
  checks: readonly { name: CheckName; status: Status }[],
  jobs: readonly HousekeepingRow[],
): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const { name, status } of checks) {
    if (status === "ok") continue;
    items.push({
      title: CHECKS[name].alert[status],
      description: CHECKS[name].says[status].because,
      href: HEALTH_HREF,
      tone: toneOf(status),
    });
  }
  for (const job of jobs.filter(failed))
    items.push({
      title: `${jobTitle(job.name)} failed`,
      description: job.last_error ?? undefined,
      href: HEALTH_HREF,
      tone: "warn",
    });
  return items;
}

/** What Home reads: the checks Marfa makes locally, the object store under a short budget, and the jobs. */
async function readForHome(health: ConsoleHealth) {
  const [reading, objectStore, jobs] = await Promise.all([
    health.read(),
    health.objectStore(HOME_OBJECT_STORE_BUDGET_MS),
    health.jobs().catch((): HousekeepingRow[] => []),
  ]);
  return {
    checks: checksFrom(reading.components, objectStore),
    jobs,
  };
}

/** Home hands the value and the attention items the same reads, so one reading answers both. */
const homeReadings = new WeakMap<
  ConsoleReads,
  ReturnType<typeof readForHome>
>();

function homeReading(reads: ConsoleReads, health: ConsoleHealth) {
  const held = homeReadings.get(reads);
  if (held) return held;
  const reading = readForHome(health);
  homeReadings.set(reads, reading);
  return reading;
}

CONSOLE_PAGES.register("health", {
  href: HEALTH_HREF,
  settings: [
    {
      id: "housekeeping",
      title: "Housekeeping",
      description: "Run the jobs Marfa does on its own",
      group: "Health",
      href: `${HEALTH_HREF}#housekeeping`,
    },
  ],
  value: async (reads) => {
    if (!reads.health) return undefined;
    const { checks, jobs } = await homeReading(reads, reads.health);
    return healthValue(checks, jobs);
  },
  attention: async (reads) => {
    if (!reads.health) return [];
    const { checks, jobs } = await homeReading(reads, reads.health);
    return healthAttention(checks, jobs);
  },
});

export function healthPageRoutes(storage: Storage, health: ConsoleHealth) {
  const router = new Hono<AppEnv>();
  router.get("/health", async (c) => {
    requireDirectAuthority(c);
    refuseUndeclaredKeysOf(c.req.url, []);
    const [reading, objectStore, jobs] = await Promise.all([
      health.read(),
      health.objectStore(),
      health.jobs().then(
        (rows) => rows,
        () => null,
      ),
    ]);
    c.header(
      "Content-Security-Policy",
      consoleContentSecurityPolicy(c.var.cspNonce),
    );
    return c.html(
      renderHealthPage({
        nonce: c.var.cspNonce,
        instanceName: await readInstanceName(storage.settings),
        now: nowRows(reading.components, objectStore),
        jobs: jobs === null ? null : jobRows(jobs, clock.nowMs()),
      }),
    );
  });
  return router;
}
