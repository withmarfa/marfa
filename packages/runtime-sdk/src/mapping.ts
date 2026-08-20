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

  async function load(): Promise<ConnectionMapping | null> {
    if (loaded) return mapping;
    loaded = true;
    try {
      const connection = await client.getItem(connectionId);
      const raw = (connection?.properties as { mapping?: unknown } | undefined)
        ?.mapping;
      if (raw !== undefined && raw !== null) {
        const parsed = ConnectionMappingSchema.safeParse(raw);
        // A stored mapping that no longer parses is treated as absent
        // rather than failing the whole run: configure-time validation
        // owns refusal, and the family fallthrough is the behavior the
        // connection had before the mapping existed.
        mapping = parsed.success ? parsed.data : null;
      }
    } catch {
      mapping = null;
    }
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
