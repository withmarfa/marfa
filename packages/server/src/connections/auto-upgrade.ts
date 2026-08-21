/**
 * Moving connections onto the manifest their own deployment ships.
 *
 * A connection resolves the manifest frozen at install, and the boot
 * reconcile registers new versions without ever re-binding anything. Both
 * halves are right on their own and wrong together: every manifest bump
 * re-drifts every connection, so drift is the steady state rather than an
 * anomaly, and a number that is never green is a number nobody reads.
 *
 * **A non-widening upgrade is not a decision anybody needs to make.** The
 * connection is resolving a manifest its own deployment already ships, and
 * the consent gate has computed that it reaches nothing new. Holding it
 * back protects no one and leaves the signal permanently red. A widening
 * one still waits for a person, unchanged.
 *
 * Nothing here reimplements the upgrade. It reuses `previewUpgrade` to
 * decide and `performUpgrade` to act, so the automatic path and the manual
 * one cannot disagree about what an upgrade is or what widens a grant.
 *
 * **Triggers are non-widening, deliberately rather than by omission.** A
 * trigger changes *when* an integration runs, not what it can reach: reach
 * is `target_types`, the permission maps and the auth requirements, and
 * those already gate. `manual` is the case that proves it, granting no new
 * access and only letting a person ask for the sweep the schedule already
 * performs. `supports_user_mappings` becoming *true* is the same, a
 * capability declaration rather than a grant. Both fall outside
 * `diffManifestGrants` and that is the intended answer, pinned by tests in
 * `manifest-diff.test.ts` so it stays a decision rather than a gap.
 *
 * The one capability change that does stop this pass is
 * `supports_user_mappings` going the other way while a mapping is stored.
 * That takes nothing away from the integration, so it is not a widening,
 * but it strands the person: the runtime keeps applying the stored mapping
 * and `PUT /connections/{id}/mapping` stops accepting one, so they can
 * neither edit nor clear the rules still routing their data. Applying that
 * silently, on a timer, is the defect class this whole area exists to
 * close.
 */
import type { IntegrationManifest, Item } from "@withmarfa/shared";
import { ConnectionMappingSchema } from "@withmarfa/shared";
import type { Storage } from "../storage/interface.js";
import { log } from "../middleware/logger.js";
import type { CoordinationStore } from "../storage/interface.js";
import {
  previewUpgrade,
  performUpgrade,
  UpgradeError,
  type UpgradePreview,
} from "./upgrade-pipeline.js";

/** Page size for the connection walk. */
const CONNECTION_SCAN_PAGE = 200;

export type DriftDisposition =
  /** Already on the newest registered version. */
  | "current"
  /** Behind, reaches nothing new, and this pass may move it. */
  | "upgradable"
  /** Behind and reaches something new. Waits for a space admin. */
  | "awaiting_consent"
  /** Behind, but moving it would strand something. Waits for a person too,
   *  for a different reason, and says which. */
  | "blocked";

export interface ConnectionDrift {
  connection_id: string;
  manifest_name: string;
  from_version: string;
  to_version: string | null;
  disposition: DriftDisposition;
  /** Set when `blocked`. */
  blocked_reason?: "mapping_would_be_stranded";
}

export interface DriftSummary {
  /** Live integration connections considered. */
  live: number;
  /** Not on the newest registered version, whatever the reason. */
  behind: number;
  /** Behind and safe to move without a person. */
  upgradable: number;
  /** Behind and waiting on a space admin because the move widens a grant. */
  awaiting_consent: number;
  /** Behind and held back for a stated non-consent reason. */
  blocked: number;
}

/** Every live integration connection, across spaces. */
async function listLiveIntegrationConnections(
  storage: Storage,
): Promise<Item[]> {
  const out: Item[] = [];
  let cursor: string | null = null;
  do {
    const page: { data: Item[]; cursor: string | null } =
      await storage.items.list({
        type: "system.connection",
        state: "active",
        limit: CONNECTION_SCAN_PAGE,
        ...(cursor ? { cursor } : {}),
      });
    for (const connection of page.data) {
      if (connection.properties.kind === "integration") out.push(connection);
    }
    cursor = page.cursor;
  } while (cursor);
  return out;
}

/**
 * Would moving this connection leave a stored mapping it can no longer
 * edit? Only when a mapping is actually stored: an integration dropping
 * the capability it never had exercised takes nothing from anybody.
 */
function wouldStrandMapping(
  connection: Item,
  candidateManifest: IntegrationManifest | undefined,
): boolean {
  if (candidateManifest === undefined) return false;
  if (candidateManifest.supports_user_mappings === true) return false;
  return ConnectionMappingSchema.safeParse(
    (connection.properties as { mapping?: unknown }).mapping,
  ).success;
}

async function candidateManifestOf(
  storage: Storage,
  preview: UpgradePreview,
  spaceId: string | undefined,
): Promise<IntegrationManifest | undefined> {
  if (preview.candidate_integration_ref === null) return undefined;
  const row = await storage.items.get(
    preview.candidate_integration_ref,
    spaceId,
    { includePlatformScoped: true },
  );
  if (row?.type !== "system.integration") return undefined;
  return (row.properties as { manifest?: IntegrationManifest }).manifest;
}

/** Where one connection stands against the newest registered version. */
export async function assessConnection(
  storage: Storage,
  connection: Item,
): Promise<ConnectionDrift> {
  const spaceId = connection.space_id ?? undefined;
  const preview = await previewUpgrade(storage, {
    spaceId,
    connectionId: connection.id,
  });

  const base = {
    connection_id: connection.id,
    manifest_name: preview.current.manifest_name,
    from_version: preview.current.manifest_version,
  };

  if (preview.candidate === null) {
    return { ...base, to_version: null, disposition: "current" };
  }
  const to_version = preview.candidate.manifest_version;

  if (preview.delta?.widens === true) {
    return { ...base, to_version, disposition: "awaiting_consent" };
  }

  const manifest = await candidateManifestOf(storage, preview, spaceId);
  if (wouldStrandMapping(connection, manifest)) {
    return {
      ...base,
      to_version,
      disposition: "blocked",
      blocked_reason: "mapping_would_be_stranded",
    };
  }

  return { ...base, to_version, disposition: "upgradable" };
}

/**
 * Where every live connection stands. Read-only.
 *
 * This is the signal the drift number never had: `previewUpgrade` existed
 * and served exactly one connection at a time, so "how much drift is
 * there" was a question only answerable by iterating by hand, which is how
 * every measurement of it has been taken so far.
 */
export async function surveyConnectionDrift(storage: Storage): Promise<{
  summary: DriftSummary;
  connections: ConnectionDrift[];
}> {
  const live = await listLiveIntegrationConnections(storage);
  const connections: ConnectionDrift[] = [];
  for (const connection of live) {
    try {
      connections.push(await assessConnection(storage, connection));
    } catch (err) {
      // One unreadable connection must not blind the whole signal.
      log("warn", "Drift survey skipped a connection", {
        connection_id: connection.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const count = (d: DriftDisposition): number =>
    connections.filter((c) => c.disposition === d).length;

  return {
    summary: {
      live: connections.length,
      behind: connections.filter((c) => c.disposition !== "current").length,
      upgradable: count("upgradable"),
      awaiting_consent: count("awaiting_consent"),
      blocked: count("blocked"),
    },
    connections,
  };
}

export interface AutoUpgradeReport {
  upgraded: { connection_id: string; from: string; to: string }[];
  awaiting_consent: number;
  blocked: number;
  failed: { connection_id: string; error: string }[];
}

/**
 * Move every connection that can move, and leave the rest alone.
 *
 * `performUpgrade` is called without `consentedToWidening`, so a candidate
 * that turns out to widen between the assessment and the act is refused by
 * the same gate a route call hits rather than by this function's own
 * reading. The check here decides what to *try*; the pipeline decides what
 * is *allowed*, and only one of those may be authoritative.
 *
 * A connection whose stored configuration no longer validates fails its own
 * upgrade and nothing else, which is why each one is attempted separately.
 */
export async function applyNonWideningUpgrades(
  storage: Storage,
): Promise<AutoUpgradeReport> {
  const { connections } = await surveyConnectionDrift(storage);
  const report: AutoUpgradeReport = {
    upgraded: [],
    awaiting_consent: connections.filter(
      (c) => c.disposition === "awaiting_consent",
    ).length,
    blocked: connections.filter((c) => c.disposition === "blocked").length,
    failed: [],
  };

  for (const drift of connections) {
    if (drift.disposition !== "upgradable") continue;
    try {
      const result = await performUpgrade(storage, {
        spaceId: undefined,
        connectionId: drift.connection_id,
      });
      report.upgraded.push({
        connection_id: drift.connection_id,
        from: result.from.manifest_version,
        to: result.to.manifest_version,
      });
    } catch (err) {
      const message =
        err instanceof UpgradeError
          ? `${err.code}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      report.failed.push({
        connection_id: drift.connection_id,
        error: message,
      });
      log("warn", "Automatic upgrade failed for one connection", {
        connection_id: drift.connection_id,
        error: message,
      });
    }
  }

  return report;
}

/**
 * The scheduled pass. Worker-role, cluster-locked, same shape as the
 * retention jobs.
 *
 * Deliberately not a boot-time block like the catalog reconcile beside it:
 * a bump can register a new version at any point in a deployment's life,
 * including from another process, so a once-per-boot sweep would leave
 * drift standing until somebody restarted something.
 */
export class ConnectionUpgrader {
  private interval: ReturnType<typeof setInterval> | null = null;
  private startupTimeout: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private storage: Storage,
    private intervalMs: number,
    private coordination?: CoordinationStore,
  ) {}

  start(): void {
    this.stopped = false;
    // Behind the boot reconcile, which is what registers the versions this
    // pass then moves connections onto.
    this.startupTimeout = setTimeout(() => void this.poll(), 40_000);
    this.interval = setInterval(() => void this.poll(), this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.startupTimeout) {
      clearTimeout(this.startupTimeout);
      this.startupTimeout = null;
    }
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Test and scheduler entry point. */
  async runOnce(): Promise<AutoUpgradeReport> {
    return applyNonWideningUpgrades(this.storage);
  }

  runScheduled(): Promise<void> {
    return this.poll();
  }

  private async poll(): Promise<void> {
    try {
      const report = this.coordination
        ? await this.coordination.withJobLock("connection-auto-upgrade", () =>
            this.runOnce(),
          )
        : await this.runOnce();
      if (report === undefined) return;
      if (
        report.upgraded.length > 0 ||
        report.failed.length > 0 ||
        report.blocked > 0
      ) {
        log("info", "Connection auto-upgrade", {
          upgraded: report.upgraded.length,
          awaiting_consent: report.awaiting_consent,
          blocked: report.blocked,
          failed: report.failed.length,
        });
      }
    } catch (err) {
      if (this.stopped) return;
      log("error", "Connection auto-upgrade tick failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
