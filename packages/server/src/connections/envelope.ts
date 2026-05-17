/**
 * Pure helpers for the reactive-run bridge envelope: subscription-entry
 * shape, queue-message body construction, and the per-subscriber dispatch
 * gate.
 *
 * Lives outside `reactive-run-bridge.ts` so the same logic backs both
 * fanout (which actually POSTs to Cloudflare Queues) and `POST
 * /connections/preview-event` (which renders the envelopes the bridge
 * would have emitted, without dispatch). One implementation, two callers.
 */
import type { ItemEventWithId } from "../pubsub.js";
import type { Storage } from "../storage/interface.js";
import { validateManifest } from "../integrations/validate-manifest.js";

export interface QueueMessageBody {
  kind: "item-event";
  integration_name: string;
  connection_id: string;
  tenant_id?: string;
  event_type: string;
  item_id: string;
  cycle: {
    originating_connection_id: string | null;
    hop_count: number;
  };
  payload: unknown;
}

export interface SubscriptionEntry {
  connection_id: string;
  integration_name: string;
  /** Tenant scope (T-042). Read from `connection.tenant_id` so callers
   *  can drop cross-tenant fanout cheaply. Single-tenant self-hosts leave
   *  this null on every connection — the gate trivially passes. */
  tenant_id: string | null;
}

interface ConnectionProperties {
  kind?: string;
  integration_ref?: string;
  status?: string;
}

interface IntegrationProperties {
  manifest?: unknown;
}

interface ManifestTrigger {
  type: string;
}

/**
 * Inspect a connection's manifest and return a SubscriptionEntry when
 * the connection should receive item-event fanout. Returns null when:
 *   - The connection's item-level `state` isn't `active` (T-175 — gate
 *     on the canonical lifecycle field, not just `properties.status`)
 *   - The connection isn't of kind `integration`
 *   - The connection has no integration_ref
 *   - The integration_ref doesn't resolve to a system.integration
 *   - The manifest is invalid (validateManifest rejects it)
 *   - The manifest declares no `item-event` trigger
 *   - The connection's `properties.status` is set and not `active`
 */
export async function buildEntryForConnection(
  storage: Storage,
  connection: {
    id: string;
    state?: string;
    properties: unknown;
    tenant_id?: string | null;
  },
): Promise<SubscriptionEntry | null> {
  // T-175: item-level state gate. Both layers must hold —
  // `state === "active"` (canonical lifecycle) AND `properties.status`
  // either unset or `active` (application-layer runtime status). The
  // pre-T-175 code only checked the latter, so a Connection transitioned
  // to `state: revoked` (via the uninstall pipeline) but retaining
  // `properties.status: active` continued firing reactive runs.
  if (connection.state !== undefined && connection.state !== "active") {
    return null;
  }
  const props = connection.properties as ConnectionProperties;
  if (props.kind !== "integration") return null;
  if (props.status && props.status !== "active") return null;
  const ref = props.integration_ref;
  if (!ref) return null;
  const integration = await storage.items.get(ref);
  if (integration?.type !== "system.integration") return null;
  const intProps = integration.properties as IntegrationProperties;
  const validated = validateManifest(intProps.manifest);
  if (!validated.ok) return null;
  const triggers = validated.manifest.triggers as ManifestTrigger[] | undefined;
  const hasItemEventTrigger =
    Array.isArray(triggers) && triggers.some((t) => t.type === "item-event");
  if (!hasItemEventTrigger) return null;
  return {
    connection_id: connection.id,
    integration_name: validated.manifest.name,
    tenant_id: connection.tenant_id ?? null,
  };
}

/**
 * Build the wire envelope the bridge would POST to Cloudflare Queues for
 * one (event, subscriber) pair. Pure function — no I/O, no side effects.
 *
 * Caller is responsible for the dispatch gate (see `evaluateDispatch`)
 * and the hop-budget gate (see `pubsub.passesHopBudget`); this function
 * just constructs the body assuming the gates passed.
 */
export function buildQueueMessageBody(
  event: ItemEventWithId,
  entry: SubscriptionEntry,
): QueueMessageBody {
  return {
    kind: "item-event",
    integration_name: entry.integration_name,
    connection_id: entry.connection_id,
    ...(event.tenantId !== undefined && { tenant_id: event.tenantId }),
    event_type: `item.${event.type}`,
    item_id: event.item.id,
    cycle: {
      originating_connection_id: event.originatingConnectionId ?? null,
      hop_count: event.hopCount ?? 0,
    },
    payload: { item: event.item, metadata: event.metadata },
  };
}

export type DispatchOutcome =
  | { would_dispatch: true }
  | {
      would_dispatch: false;
      reason: "self_event" | "cross_tenant";
    };

/**
 * The bridge's per-subscriber gate. Runs in order:
 *   1. self-event (the subscriber is the connection that originated the event)
 *   2. cross-tenant (the subscriber's tenant doesn't match the event's)
 *
 * Returns `{ would_dispatch: true }` when both gates pass — the caller
 * may then build the envelope. Hop-budget enforcement is upstream of the
 * bridge (`pubsub.passesHopBudget` runs at publish time) so it's NOT
 * checked here; see the preview-event route for how that's surfaced.
 */
export function evaluateDispatch(
  event: ItemEventWithId,
  entry: SubscriptionEntry,
): DispatchOutcome {
  if (entry.connection_id === event.originatingConnectionId) {
    return { would_dispatch: false, reason: "self_event" };
  }
  // Normalise to null on both sides so single-tenant self-hosted (where
  // both event.tenantId and entry.tenant_id are typically `undefined`)
  // doesn't fall foul of `undefined !== null` and accidentally drop every
  // subscriber. Hosted multi-tenant: both sides carry strings; the
  // comparison is the explicit cross-tenant guard.
  const eventTenantId = event.tenantId ?? null;
  if ((entry.tenant_id ?? null) !== eventTenantId) {
    return { would_dispatch: false, reason: "cross_tenant" };
  }
  return { would_dispatch: true };
}
