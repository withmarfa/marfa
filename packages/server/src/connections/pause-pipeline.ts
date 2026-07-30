/**
 * Pause and resume an `integration`-kind Connection.
 *
 * These exist as a server-side pipeline for the same reason uninstall does:
 * the write is privileged and the caller is not. Pausing a connection means
 * writing a `system.*` item, which the reserved-namespace rule correctly
 * refuses to ordinary space credentials, so pause built as a direct item
 * transition returned `403 type_not_permitted` naming a namespace the user
 * never asked to touch. Uninstall performed the same class of write through
 * a mediated path and worked.
 *
 * The consequence was that a connection owner could install a connection
 * and destroy it, but not temporarily stop it. Pause is the operation
 * someone reaches for first when a connector misbehaves, and the only route
 * from running to not-running was the irreversible one that drops the OAuth
 * grant and forces a fresh consent round trip.
 *
 * **Pause is expressed on `runtime_status`, not on the lifecycle.** The
 * `system.connection` lifecycle is bounded to `active | revoked`, so there
 * is no `archived` to transition to — the direct implementation was reaching
 * for a state the type does not have, and would have failed validation even
 * with the permission fixed. `runtime_status` already carries `paused`,
 * which is what it is for.
 *
 * **Pausing disarms.** A status field that stops nothing would be a lie the
 * operator acts on, so pause cancels the schedule through the same
 * control-plane call uninstall uses, and resume re-arms it. The reactive
 * dispatch path gates on `runtime_status` so item events stop as well.
 */
import type { Storage } from "../storage/interface.js";
import { withConnectionLifecycleLock } from "./lifecycle-lock.js";
import { setConnectionSchedule } from "./schedule-control.js";

export interface PauseInput {
  /** The api_keys row id of the caller (audit trail). */
  apiKeyId: string;
  /** Space scope. Must match the connection's. */
  spaceId?: string;
  connectionId: string;
  clientIp?: string | null;
  /** Which substrate runs integrations; only `hosted` has alarms to cancel. */
  integrationRuntime?: "hosted" | "local";
  controlPlaneUrl?: string;
  runtimeBrokerKey?: string;
}

export interface PauseResult {
  connection_id: string;
  runtime_status: "paused" | "healthy";
  /** True when a Durable Object attested the alarm changed state. False
   *  when there was nothing to change (the local substrate, or an
   *  integration deploying no Worker) and false when the attempt failed —
   *  the two are told apart by `schedule_error`. */
  schedule_changed: boolean;
  /** Present only when the schedule call ran and failed. The status write
   *  still happened: a paused connection that failed to disarm is worse
   *  reported than hidden, and the operator can retry. */
  schedule_error?: string;
  activity_id: string;
}

export class PauseError extends Error {
  constructor(
    public readonly code:
      | "connection_not_found"
      | "wrong_connection_kind"
      | "revoked"
      | "already_in_state",
    message: string,
  ) {
    super(message);
    this.name = "PauseError";
  }
}

export function performPause(
  storage: Storage,
  input: PauseInput,
): Promise<PauseResult> {
  return withConnectionLifecycleLock(storage, input.connectionId, () =>
    applyRuntimeState(storage, input, "paused"),
  );
}

export function performResume(
  storage: Storage,
  input: PauseInput,
): Promise<PauseResult> {
  return withConnectionLifecycleLock(storage, input.connectionId, () =>
    applyRuntimeState(storage, input, "healthy"),
  );
}

async function applyRuntimeState(
  storage: Storage,
  input: PauseInput,
  target: "paused" | "healthy",
): Promise<PauseResult> {
  const connection = await storage.items.get(input.connectionId, input.spaceId);
  if (connection?.type !== "system.connection") {
    throw new PauseError(
      "connection_not_found",
      `Connection ${input.connectionId} not found`,
    );
  }
  const kind = connection.properties.kind as string | undefined;
  if (kind !== "integration") {
    throw new PauseError(
      "wrong_connection_kind",
      `Connection ${input.connectionId} has kind "${kind ?? "<missing>"}"; pause accepts only "integration"`,
    );
  }
  // A revoked connection has no runtime to pause, and resuming one would
  // quietly undo an uninstall.
  if (connection.state === "revoked") {
    throw new PauseError(
      "revoked",
      `Connection ${input.connectionId} is revoked; pause and resume apply to live connections`,
    );
  }
  const current = connection.properties.runtime_status as string | undefined;
  if (current === target) {
    throw new PauseError(
      "already_in_state",
      `Connection ${input.connectionId} is already ${target === "paused" ? "paused" : "running"}`,
    );
  }

  // Status first, schedule second. The order matters on a partial failure:
  // a connection recorded as paused whose alarm is still armed is visibly
  // wrong and retryable, while an alarm cancelled with nothing recording
  // why looks like a connector that silently stopped working.
  await storage.items.update(
    input.connectionId,
    {
      properties: { ...connection.properties, runtime_status: target },
    },
    input.spaceId,
  );

  const schedule = await setConnectionSchedule(storage, {
    connectionId: input.connectionId,
    spaceId: input.spaceId,
    integrationRef: connection.properties.integration_ref as string | undefined,
    integrationRuntime: input.integrationRuntime ?? "local",
    ...(input.controlPlaneUrl !== undefined
      ? { controlPlaneUrl: input.controlPlaneUrl }
      : {}),
    ...(input.runtimeBrokerKey !== undefined
      ? { runtimeBrokerKey: input.runtimeBrokerKey }
      : {}),
    armed: target === "healthy",
  });

  const activity = await storage.items.create(
    {
      type: "system.activity",
      properties: {
        connection_id: input.connectionId,
        severity: schedule.error
          ? ("action_required" as const)
          : ("info" as const),
        summary:
          target === "paused"
            ? `Paused connection ${input.connectionId}`
            : `Resumed connection ${input.connectionId}`,
        detail: {
          runtime_status: target,
          schedule_changed: schedule.changed,
          ...(schedule.error ? { schedule_error: schedule.error } : {}),
        },
      },
    },
    input.spaceId,
  );

  await storage.audit.log({
    client_ip: input.clientIp ?? null,
    space_id: input.spaceId ?? null,
    key_id: input.apiKeyId,
    action: target === "paused" ? "integration.pause" : "integration.resume",
    resource_type: "item",
    resource_id: input.connectionId,
    details: {
      runtime_status: target,
      schedule_changed: schedule.changed,
      ...(schedule.error ? { schedule_error: schedule.error } : {}),
    },
  });

  return {
    connection_id: input.connectionId,
    runtime_status: target,
    schedule_changed: schedule.changed,
    ...(schedule.error ? { schedule_error: schedule.error } : {}),
    activity_id: activity.id,
  };
}
