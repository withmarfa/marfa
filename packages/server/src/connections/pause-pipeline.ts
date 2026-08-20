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
 * someone reaches for first when an integration misbehaves, and the only route
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
 * **Pausing stops the runtime through state alone.** The scheduler's
 * walker and the reactive dispatch path both gate on `runtime_status`,
 * so a paused connection simply stops being scheduled and stops
 * receiving item events; there is no alarm to cancel.
 */
import type { Storage } from "../storage/interface.js";
import { withConnectionLifecycleLock } from "./lifecycle-lock.js";

export interface PauseInput {
  /** The api_keys row id of the caller (audit trail). */
  apiKeyId: string;
  /** Space scope. Must match the connection's. */
  spaceId?: string;
  connectionId: string;
  clientIp?: string | null;
}

export interface PauseResult {
  connection_id: string;
  runtime_status: "paused" | "healthy";
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

  await storage.items.update(
    input.connectionId,
    {
      properties: { ...connection.properties, runtime_status: target },
    },
    input.spaceId,
  );

  const activity = await storage.items.create(
    {
      type: "system.activity",
      properties: {
        connection_id: input.connectionId,
        severity: "info" as const,
        summary:
          target === "paused"
            ? `Paused connection ${input.connectionId}`
            : `Resumed connection ${input.connectionId}`,
        detail: {
          runtime_status: target,
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
    },
  });

  return {
    connection_id: input.connectionId,
    runtime_status: target,
    activity_id: activity.id,
  };
}
