/**
 * Walks active `system.connection` items for a given integration and
 * emits a `SchedulerEnvelope` per matching Connection — the local
 * substrate's equivalent of the Cloudflare Cron Trigger fanout. One
 * cron entry per integration; the cron tick walks every Connection for
 * that integration and pushes a schedule message per Connection onto
 * the queue.
 *
 * Match rules (mirrors `buildEntryForConnection` in `envelope.ts`):
 *   - item-level `state === "active"`
 *   - `properties.kind === "integration"`
 *   - `properties.status` unset OR `"active"`
 *   - `properties.runtime_status` not `"paused"` (pause stops the
 *     schedule; the next tick simply skips the connection, and resume
 *     picks it back up with nothing to re-arm)
 *   - `properties.integration_ref` resolves to a `system.integration` whose
 *     manifest:
 *       - validates against `IntegrationManifestSchema`
 *       - has the integration name we're walking for
 *
 * The walk is cursor-paginated; cron-tick latency is bounded by the
 * Connection count for one integration and not the global Connection
 * cardinality.
 */
import { CronExpressionParser } from "cron-parser";
import { stampNextRun } from "./connection-timings.js";
import type { Storage } from "../../storage/interface.js";
import type { ScheduleMessage } from "@withmarfa/runtime-sdk";
import { validateManifest } from "../validate-manifest.js";
import type { LocalRuntime, SchedulerEnvelope } from "./types.js";

const WALKER_PAGE_SIZE = 200;

interface ConnectionProperties {
  kind?: string;
  integration_ref?: string;
  status?: string;
  runtime_status?: string;
}

interface IntegrationProperties {
  manifest?: unknown;
}

/**
 * Enqueue a schedule message for every active local Connection bound to
 * the named integration. Returns the count of envelopes enqueued — useful
 * for telemetry / tests.
 *
 * With `scheduleCron` supplied, each connection also records when it is next
 * due. This is the only place that knows both the cron and the connection
 * set, which is why the stamp lives here rather than on the dispatch path.
 */
/**
 * When the cron next fires after `fromMs`. Returns undefined for an
 * expression the parser rejects: a connection reporting no next run is a
 * better answer than one reporting a wrong time, and a malformed cron is
 * already a registration-time problem rather than something to fail a
 * fan-out over.
 */
function nextRunAfter(cron: string, fromMs: number): number | undefined {
  try {
    return CronExpressionParser.parse(cron, { currentDate: new Date(fromMs) })
      .next()
      .toDate()
      .getTime();
  } catch {
    return undefined;
  }
}

export async function fanOutSchedule(
  storage: Storage,
  runtime: LocalRuntime,
  integrationName: string,
  scheduledForMs: number,
  scheduleCron?: string,
): Promise<number> {
  let cursor: string | undefined;
  let dispatched = 0;
  // Computed once per fan-out, not once per connection: every connection on
  // this integration shares the cron, so they share the answer.
  const nextRunAtMs =
    scheduleCron === undefined
      ? undefined
      : nextRunAfter(scheduleCron, scheduledForMs);
  for (;;) {
    const page = await storage.items.list({
      type: "system.connection",
      limit: WALKER_PAGE_SIZE,
      cursor,
    });
    for (const connection of page.data) {
      if (!isLocalIntegrationConnection(connection)) continue;
      const matched = await resolveManifestName(storage, connection);
      if (matched?.integrationName !== integrationName) continue;
      const envelope: SchedulerEnvelope = {
        integration_name: integrationName,
        message: buildScheduleMessage(
          connection,
          integrationName,
          scheduledForMs,
        ),
      };
      await runtime.enqueue(envelope);
      if (nextRunAtMs !== undefined) {
        await stampNextRun(
          storage,
          connection.id,
          connection.space_id ?? undefined,
          nextRunAtMs,
        );
      }
      dispatched++;
    }
    if (!page.has_more || !page.cursor) break;
    cursor = page.cursor;
  }
  return dispatched;
}

function isLocalIntegrationConnection(connection: {
  state?: string;
  properties: unknown;
}): boolean {
  if (connection.state !== undefined && connection.state !== "active") {
    return false;
  }
  const props = connection.properties as ConnectionProperties;
  if (props.kind !== "integration") return false;
  if (props.status !== undefined && props.status !== "active") return false;
  if (props.runtime_status === "paused") return false;
  if (!props.integration_ref) return false;
  return true;
}

async function resolveManifestName(
  storage: Storage,
  connection: { id: string; properties: unknown; space_id?: string | null },
): Promise<{ integrationName: string } | null> {
  const props = connection.properties as ConnectionProperties;
  if (!props.integration_ref) return null;
  const integration = await storage.items.get(props.integration_ref);
  if (integration?.type !== "system.integration") return null;
  const intProps = integration.properties as IntegrationProperties;
  const validated = validateManifest(intProps.manifest);
  if (!validated.ok) return null;
  // No substrate check any more. There is one runtime, so an integration
  // either has a registration here or it does not, and the supervisor
  // answers that question when the envelope arrives. The manifest field
  // that used to gate this described a choice between substrates that
  // stopped existing when the Workers estate was deleted.
  return { integrationName: validated.manifest.name };
}

function buildScheduleMessage(
  connection: { id: string; space_id?: string | null },
  integrationName: string,
  scheduledForMs: number,
): ScheduleMessage {
  return {
    kind: "schedule",
    integration_name: integrationName,
    connection_id: connection.id,
    ...(connection.space_id ? { space_id: connection.space_id } : {}),
    scheduled_for_ms: scheduledForMs,
  };
}
