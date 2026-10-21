/**
 * What the console says about a connector's health, from what the connector
 * reported. The server takes no action on a stale heartbeat (`connectors.ts`),
 * so this reading is shared by the list, a connector's page, and the attention
 * operation.
 */
import type { Connector } from "../storage/interface.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a connector may say nothing before the console calls it silent. */
export const SILENT_AFTER_MS = DAY_MS;

export type ConnectorState = "failing" | "problems" | "silent" | "running";

export interface ConnectorStatus {
  state: ConnectorState;
  label: string;
  /** How the label is drawn; none for a connector that is running. */
  tone?: "warn" | "danger";
}

const LABELS: Record<ConnectorState, string> = {
  failing: "Failing",
  problems: "Problems",
  silent: "Not heard from",
  running: "Running",
};

const TONES: Record<ConnectorState, "warn" | "danger" | undefined> = {
  failing: "danger",
  problems: "warn",
  silent: "warn",
  running: undefined,
};

const timeOf = (text: string | null | undefined): number => {
  if (!text) return 0;
  const at = Date.parse(text);
  return Number.isNaN(at) ? 0 : at;
};

/** When the connector last said anything: a heartbeat, a run, or its registration. */
export function lastHeardAt(connector: Connector): number {
  return Math.max(
    timeOf(connector.last_heartbeat_at),
    timeOf(connector.last_run?.reported_at),
    timeOf(connector.registered_at),
  );
}

/**
 * A failed last run comes first, then problems the connector reported, then
 * silence for a day. Otherwise it is running.
 */
export function connectorStatus(
  connector: Connector,
  now: number,
): ConnectorStatus {
  let state: ConnectorState = "running";
  if (connector.last_run?.outcome === "failed") state = "failing";
  else if (Object.keys(connector.problems).length > 0) state = "problems";
  else if (now - lastHeardAt(connector) > SILENT_AFTER_MS) state = "silent";
  const tone = TONES[state];
  return { state, label: LABELS[state], ...(tone ? { tone } : {}) };
}
