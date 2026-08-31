/**
 * The per-connection user-mapping resolver: the runtime side of
 * `system.connection.properties.mapping`. Handlers present each
 * upstream-faithful record; the resolver answers with the user's routing,
 * the selected-family fallthrough, or a skip. Author code never
 * interprets user rules, and the resolver never runs author mapping code.
 */
import {
  ConnectionMappingSchema,
  evaluateConnectionMapping,
  type ConnectionMapping,
} from "@withmarfa/shared";
import type { ActivitySink } from "./activity.js";
import type { ConnectionClient, CreateItemInput } from "./connection-client.js";

export type MappingResolution =
  | { kind: "user"; input: Pick<CreateItemInput, "type" | "properties"> }
  | { kind: "family" }
  | { kind: "skip" };

export interface MappingResolver {
  /**
   * Route one upstream record. `family` means: write your selected write
   * family's shape for this record, exactly as an unmapped connection
   * would. `skip` means: write nothing for it — the resolver counts the
   * skip for the end-of-run summary.
   */
  resolve(record: unknown): Promise<MappingResolution>;
  /**
   * Emit the one-per-run summary row for deliberately skipped records,
   * then reset the count. The substrate calls this after the handler
   * returns; per-record rows for chosen skips would drown the feed the
   * summary exists to keep readable.
   */
  flushSkipSummary(activity: ActivitySink): Promise<void>;
}

/**
 * Build the resolver for one dispatch. The mapping document is read from
 * the connection item lazily on first use and cached for the run — the
 * handlers that consult it already fetch the connection for their own
 * configuration, and a run with no records to route should cost nothing.
 */
export function createMappingResolver(
  client: ConnectionClient,
  connectionId: string,
): MappingResolver {
  let loaded = false;
  let mapping: ConnectionMapping | null = null;
  let skips = 0;
  /** Why the user's routing is not being applied, when it is not. `null`
   *  covers both "no mapping configured", which is the ordinary case and
   *  says nothing, and "the mapping is applying", which needs no row. */
  let degraded: "unparseable" | "unreadable" | null = null;
  let readFailures = 0;
  let lastReadError: string | null = null;

  /** How many times a failed connection read is retried within one run
   *  before the resolver gives up and stays degraded for the rest of it.
   *  Retrying at all is the fix for the original defect; retrying forever
   *  would put a database round trip in front of every record. */
  const MAX_READ_ATTEMPTS = 3;

  async function load(): Promise<ConnectionMapping | null> {
    if (loaded) return mapping;
    let connection;
    try {
      connection = await client.getItem(connectionId);
    } catch (err) {
      // Deliberately NOT marking the run loaded. The original defect set
      // that flag before the read, so a single transient failure was
      // cached for the whole dispatch and silently downgraded every later
      // record to the family. A blip should cost one record, not a run.
      readFailures += 1;
      lastReadError = err instanceof Error ? err.message : String(err);
      if (readFailures >= MAX_READ_ATTEMPTS) {
        loaded = true;
        degraded = "unreadable";
      }
      return null;
    }
    loaded = true;
    // The connection is already in hand, so the re-apply answer costs no
    // extra round trip. Judged here rather than by the handler: the
    // deadline is the server's, and a handler is offered no way to ask
    // for re-typing on its own.
    const until = (
      connection?.properties as { mapping_reapply_until?: unknown } | undefined
    )?.mapping_reapply_until;
    if (typeof until === "string") {
      const deadline = Date.parse(until);
      // An unparseable stamp is not an answer. Treating it as one would
      // turn a corrupt field into a standing instruction to move a
      // corpus, which is the direction that cannot be undone by noticing.
      if (Number.isFinite(deadline) && deadline > Date.now()) {
        client.enableRetypeWrites();
      }
    }
    const raw = (connection?.properties as { mapping?: unknown } | undefined)
      ?.mapping;
    if (raw === undefined || raw === null) {
      // No mapping configured. The one case that is genuinely silent:
      // the connection is behaving exactly as it was asked to.
      return null;
    }
    const parsed = ConnectionMappingSchema.safeParse(raw);
    if (!parsed.success) {
      // A stored mapping that no longer parses falls through to the
      // family rather than failing the run, because configure-time
      // validation owns refusal and the family is the behavior the
      // connection had before the mapping existed. What changes here is
      // that it says so: the user configured routing and is not getting
      // it, which they cannot otherwise tell from never having asked.
      degraded = "unparseable";
      return null;
    }
    mapping = parsed.data;
    return mapping;
  }

  return {
    async resolve(record) {
      const active = await load();
      if (!active) return { kind: "family" };
      const outcome = evaluateConnectionMapping(active, record);
      if (outcome.kind === "user") {
        return {
          kind: "user",
          input: { type: outcome.target_type, properties: outcome.properties },
        };
      }
      if (outcome.kind === "skip") {
        skips += 1;
        return { kind: "skip" };
      }
      return { kind: "family" };
    },
    async flushSkipSummary(activity) {
      // The degradation row comes first and is not an `info`. A stored
      // mapping that is not being applied is the shape this whole area
      // exists to stop: the integration reports a healthy run, the user's
      // routing quietly stops happening, and nothing distinguishes it
      // from a connection that never had a mapping at all.
      if (degraded !== null) {
        const why = degraded;
        degraded = null;
        await activity.emit({
          severity: "action_required",
          summary:
            why === "unparseable"
              ? "This connection has a mapping that could not be read, so its items were written in the integration's own shape instead"
              : "This connection's mapping could not be loaded, so its items were written in the integration's own shape instead",
          detail:
            why === "unparseable"
              ? { reason: "mapping_unparseable" }
              : {
                  reason: "mapping_unreadable",
                  read_attempts: readFailures,
                  error: lastReadError,
                },
        });
      }
      if (skips === 0) return;
      const count = skips;
      skips = 0;
      await activity.emit({
        severity: "info",
        summary: `Mapping skipped ${String(count)} record${count === 1 ? "" : "s"} this run`,
        detail: { skipped: count },
      });
    },
  };
}

/**
 * A resolver that always answers with the family fallthrough. The shape
 * tests and the runtime-test harness hand to handlers that are not
 * exercising mappings — equivalent to a connection with none configured,
 * with no connection read behind it.
 */
export function familyOnlyMappingResolver(): MappingResolver {
  return {
    resolve: () => Promise.resolve({ kind: "family" }),
    flushSkipSummary: () => Promise.resolve(),
  };
}
