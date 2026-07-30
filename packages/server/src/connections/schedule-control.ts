/**
 * Arm or disarm a Connection's hosted-substrate schedule.
 *
 * Extracted so pause, resume and uninstall make the same control-plane call
 * with the same verdict rules. They are the same operation with a different
 * target, and the rules for reading the answer are the interesting part:
 * they were arrived at by finding out that a catch-all `200` had been
 * reported as a successful disarm for months.
 *
 * Never throws. Every caller is mid-lifecycle-change, and a throw here
 * would strand a connection between states. Failure comes back on `error`
 * so the caller can surface it and an operator can retry.
 */
import { log } from "../middleware/logger.js";
import type { Storage } from "../storage/interface.js";

export interface ScheduleControlInput {
  connectionId: string;
  spaceId?: string;
  integrationRef?: string;
  integrationRuntime: "hosted" | "local";
  controlPlaneUrl?: string;
  runtimeBrokerKey?: string;
  /** True arms the schedule, false disarms it. */
  armed: boolean;
}

export interface ScheduleControlResult {
  /** True only when a Durable Object attested the change. */
  changed: boolean;
  /** Set when the call ran and failed, or could not be made. */
  error?: string;
}

interface ScheduleEnvelope {
  ok?: boolean;
  dispatched?: boolean;
  reason?: string;
  result?: { armed?: boolean; disarmed?: boolean };
}

export async function setConnectionSchedule(
  storage: Storage,
  input: ScheduleControlInput,
): Promise<ScheduleControlResult> {
  // The local substrate has no Durable Object alarms. Its walker gates on
  // connection state and runtime status, so a paused connection simply
  // stops being scheduled with nothing to cancel.
  if (input.integrationRuntime !== "hosted") return { changed: false };

  const base = input.controlPlaneUrl;
  const brokerKey = input.runtimeBrokerKey;
  if (!base || !brokerKey) {
    return {
      changed: false,
      error:
        "hosted substrate is missing runtime-control coordinates (MARFA_RUNTIME_CONTROL_URL / MARFA_RUNTIME_BROKER_KEY)",
    };
  }

  let integrationName: string | undefined;
  if (input.integrationRef) {
    const integration = await storage.items.get(
      input.integrationRef,
      input.spaceId,
      { includePlatformScoped: true },
    );
    if (integration?.type === "system.integration") {
      const name = (integration.properties as { manifest_name?: unknown })
        .manifest_name;
      if (typeof name === "string" && name.length > 0) integrationName = name;
    }
  }
  if (!integrationName) {
    return {
      changed: false,
      error: "connection has no resolvable integration manifest name",
    };
  }

  const action = input.armed ? "arm-schedule" : "disarm-schedule";
  const url = `${base.replace(/\/$/, "")}/connections/${input.connectionId}/${action}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${brokerKey}`,
      },
      body: JSON.stringify({ integration_name: integrationName }),
    });
    if (!res.ok) {
      const body = await res.text();
      return {
        changed: false,
        error: `control plane returned ${String(res.status)}: ${body.slice(0, 256)}`,
      };
    }
    const body = (await res.json()) as ScheduleEnvelope;
    return readEnvelope(body, input.armed);
  } catch (err) {
    return {
      changed: false,
      error:
        err instanceof Error
          ? `control plane unreachable: ${err.message}`
          : `control plane unreachable: ${String(err)}`,
    };
  }
}

/**
 * Decide what the control plane actually said.
 *
 * `ok` and the HTTP status are both insufficient on their own, which is the
 * lesson this encodes: a Worker whose catch-all answered every unknown path
 * with a cheerful `200` was read as a successful disarm, so the attestation
 * has to be the specific field, not the envelope around it.
 *
 * `dispatched: false` is a clean skip rather than a failure. It is what an
 * integration that deploys no Worker returns, and there is no alarm to
 * change in that case.
 */
function readEnvelope(
  body: ScheduleEnvelope,
  armed: boolean,
): ScheduleControlResult {
  if (body.ok === false) {
    return { changed: false, error: "control plane reported the call failed" };
  }
  if (body.dispatched === false) return { changed: false };
  const attested = armed ? body.result?.armed : body.result?.disarmed;
  if (attested !== true) {
    log("warn", "schedule control: no attestation in envelope", {
      armed,
      reason: body.reason ?? null,
    });
    return {
      changed: false,
      error: `control plane returned success but the Worker did not attest the schedule was ${armed ? "armed" : "disarmed"}`,
    };
  }
  return { changed: true };
}
