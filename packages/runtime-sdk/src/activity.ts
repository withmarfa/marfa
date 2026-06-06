/**
 * `system.activity` emission helper.
 *
 * The Marfa server's existing `system.activity` type carries severity
 * (`info | warning | error | action_required`), summary, and optional
 * detail. The runtime SDK uses this to surface every operator-visible
 * state change (cursor advance failures, reauth required, hop budget
 * overflow, scheduled-poll hit a 5xx, etc.).
 *
 * Connections with `feed_activity: true` get tier:'feed' stamped on
 * the resulting item by the server.
 */
import type { ConnectionClient } from "./connection-client.js";

export type ActivitySeverity = "info" | "warning" | "error" | "action_required";

export interface ActivityInput {
  severity: ActivitySeverity;
  /** Short, human-readable one-liner. Shown in operator UIs. */
  summary: string;
  /** Optional structured context. Use for the things an operator
   *  might want to see for diagnosis (failing URL, error code, etc.).
   *  Keep small — large blobs go in the activity item's body field
   *  via a manual create call instead. */
  detail?: Record<string, unknown>;
}

export interface ActivitySink {
  emit(activity: ActivityInput): Promise<void>;
}

/** Builds an ActivitySink bound to a specific Connection. */
export function createActivitySink(
  client: ConnectionClient,
  connectionId: string,
): ActivitySink {
  return {
    async emit(activity: ActivityInput): Promise<void> {
      await client.createItem({
        type: "system.activity",
        properties: {
          connection_id: connectionId,
          severity: activity.severity,
          summary: activity.summary,
          ...(activity.detail !== undefined ? { detail: activity.detail } : {}),
        },
      });
    },
  };
}
