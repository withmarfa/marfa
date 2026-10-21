import { AsyncLocalStorage } from "node:async_hooks";
import type { VersionWriter } from "@withmarfa/shared";

export type AuditActor =
  VersionWriter | { kind: "server"; id: "server"; name: "Marfa" };
const actors = new AsyncLocalStorage<() => Promise<AuditActor | null>>();

export function withAuditActor<T>(
  actor: () => Promise<AuditActor | null>,
  work: () => T,
): T {
  return actors.run(actor, work);
}

/** No request means the server's own work; an anonymous request remains unknown. */
export function auditActor(): Promise<AuditActor | null> {
  return (
    actors.getStore()?.() ??
    Promise.resolve({ kind: "server", id: "server", name: "Marfa" })
  );
}
