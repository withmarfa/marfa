/**
 * Pure helpers for the reactive-run bridge envelope: subscription-entry
 * shape, queue-message body construction, and the per-subscriber dispatch
 * gate.
 *
 * Lives outside the bridge so the same logic backs both fanout (which
 * actually enqueues) and `POST /connections/preview-event` (which
 * renders the envelopes the bridge would have emitted, without
 * dispatch). One implementation, two callers.
 */
import type { ItemEventWithId } from "../pubsub.js";
import type { Storage } from "../storage/interface.js";
import { validateManifest } from "../integrations/validate-manifest.js";

export interface QueueMessageBody {
  kind: "item-event";
  integration_name: string;
  connection_id: string;
  space_id?: string;
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
  /** Space scope for cross-space fanout suppression. Read from
   *  `connection.space_id` so the bridge can drop cross-space events
   *  cheaply. Single-space self-hosts leave this null on every
   *  connection — the gate trivially passes. */
  space_id: string | null;
  /** The manifest's declared type set, verbatim. Runtime credentials are
   *  minted to exactly these types, so an event for any other type is a
   *  dispatch the handler could only fail — the gate drops it instead. */
  target_types: readonly string[];
}

interface ConnectionProperties {
  kind?: string;
  integration_ref?: string;
  status?: string;
  runtime_status?: string;
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
 *   - The connection's item-level `state` isn't `active` (gate on the
 *     canonical lifecycle field, not just `properties.status`)
 *   - The connection isn't of kind `integration`
 *   - The connection has no integration_ref
 *   - The integration_ref doesn't resolve to a system.integration
 *   - The manifest is invalid (validateManifest rejects it)
 *   - The manifest declares no `item-event` trigger
 *   - The connection's `properties.status` is set and not `active`
 *   - The connection's `properties.runtime_status` is `failing` (the
 *     subscriber tripped the bridge's sustained-failure escalation;
 *     dispatch stays gated until an operator clears the field or
 *     transitions it back to a non-failing value)
 *   - The connection's `properties.runtime_status` is `paused` (the
 *     operator asked it to stop; the pause pipeline's own update event
 *     re-evaluates the entry and drops it, and resume re-adds it the
 *     same way). Inbound webhook receipt is deliberately not gated
 *     here — it has its own route and its own decision to make.
 *
 * The entry snapshots the persisted manifest (name, target_types), so
 * cached entries assume manifests are immutable per version — which the
 * registration route enforces. An in-place edit of a system.integration
 * item's manifest through the generic item routes bypasses the
 * system.connection invalidation events and leaves entries stale until
 * the next rebuild.
 */
export async function buildEntryForConnection(
  storage: Storage,
  connection: {
    id: string;
    state?: string;
    properties: unknown;
    space_id?: string | null;
  },
): Promise<SubscriptionEntry | null> {
  // Both lifecycle layers must hold — `state === "active"` (canonical
  // item lifecycle) AND `properties.status` either unset or `active`
  // (application-layer runtime status). Checking only the latter would
  // let a Connection whose item state was transitioned to `revoked`
  // (via the uninstall pipeline) but whose `properties.status` was left
  // as `active` keep firing reactive runs.
  if (connection.state !== undefined && connection.state !== "active") {
    return null;
  }
  const props = connection.properties as ConnectionProperties;
  if (props.kind !== "integration") return null;
  if (props.status && props.status !== "active") return null;
  if (props.runtime_status === "failing") return null;
  if (props.runtime_status === "paused") return null;
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
    space_id: connection.space_id ?? null,
    target_types: validated.manifest.target_types,
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
    ...(event.spaceId !== undefined && { space_id: event.spaceId }),
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
      reason:
        | "self_event"
        | "cross_space"
        | "system_type"
        | "type_not_targeted";
    };

/**
 * The bridge's per-subscriber gate. Runs in order:
 *   1. system type (the event is the platform's own bookkeeping)
 *   2. self-event (the subscriber is the connection that originated the event)
 *   3. cross-space (the subscriber's space doesn't match the event's)
 *   4. type-not-targeted (the item's type is outside the subscriber
 *      manifest's target_types — its credential could not read the item)
 *
 * Returns `{ would_dispatch: true }` when every gate passes — the caller
 * may then build the envelope. Hop-budget enforcement is upstream of the
 * bridge (`pubsub.passesHopBudget` runs at publish time) so it's NOT
 * checked here; see the preview-event route for how that's surfaced.
 */
export function evaluateDispatch(
  event: ItemEventWithId,
  entry: SubscriptionEntry,
): DispatchOutcome {
  // `system.*` rows are the platform talking to itself — activity rows,
  // connection lifecycle, credentials, the integration catalog. Reacting
  // to another integration's log line is never what a handler wants, and
  // the fanout is not merely wasted: reporting progress is itself an
  // event, so two reactive connections in one space answer each other's
  // activity rows and walk the cycle hop counter up until the budget is
  // reached and real events start being dropped. An ordinary import into
  // an ordinary space was enough to do it.
  if (event.item.type.startsWith("system.")) {
    return { would_dispatch: false, reason: "system_type" };
  }
  if (entry.connection_id === event.originatingConnectionId) {
    return { would_dispatch: false, reason: "self_event" };
  }
  // Normalize to null on both sides so single-space self-hosted (where
  // both event.spaceId and entry.space_id are typically `undefined`)
  // doesn't fall foul of `undefined !== null` and accidentally drop every
  // subscriber. Hosted multi-space: both sides carry strings; the
  // comparison is the explicit cross-space guard.
  const eventSpaceId = event.spaceId ?? null;
  if ((entry.space_id ?? null) !== eventSpaceId) {
    return { would_dispatch: false, reason: "cross_space" };
  }
  // A subscriber's runtime credential holds exactly its manifest's
  // declared types, so an event for any other type can only ever fail in
  // the handler — usually as a 403 the moment it reads the item back,
  // recorded as an action_required permanent failure. Item type is fixed
  // for the life of an item, so the payload's type is safe to judge for
  // update and delete events alike. Last of the gates deliberately: the
  // more specific refusals above keep their reasons for events that fail
  // on several axes.
  if (!entry.target_types.includes(event.item.type)) {
    return { would_dispatch: false, reason: "type_not_targeted" };
  }
  return { would_dispatch: true };
}
