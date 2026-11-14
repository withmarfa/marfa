import type { Refusal } from "./protocol.js";

/**
 * The code a refusal names beside its class: the server's own where a server
 * answered, the device's where the device refused by itself.
 */
export function refusedCode(refusal: Refusal): string | null {
  return refusal.server?.code ?? refusal.local;
}

/** The details beside that code, read from the envelope the refusal came in. */
export function refusedDetails(refusal: Refusal): unknown {
  if (refusal.server) return refusal.server.details ?? null;
  const envelope = JSON.parse(refusal.raw) as {
    error?: { local?: { details?: unknown } | null };
  };
  return envelope.error?.local?.details ?? null;
}
