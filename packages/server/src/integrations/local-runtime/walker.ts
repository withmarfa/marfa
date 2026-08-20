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
 *       - declares `runtime_compatibility` that includes `"local"`
 *       - has the integration name we're walking for
 *
 * The walk is cursor-paginated; cron-tick latency is bounded by the
 * Connection count for one integration and not the global Connection
 * cardinality.
 */
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
 */
export async function fanOutSchedule(
  storage: Storage,
  runtime: LocalRuntime,
  integrationName: string,
  scheduledForMs: number,
): Promise<number> {
  let cursor: string | undefined;
  let dispatched = 0;
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
  // The integration is only eligible for the local substrate if its
  // manifest opts in. The CF substrate fans out independently; an
  // integration declaring only `"hosted"` stays exclusively on
  // Cloudflare.
  if (!validated.manifest.runtime_compatibility.includes("local")) return null;
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
