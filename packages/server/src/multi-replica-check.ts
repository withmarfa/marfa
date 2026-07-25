/**
 * Multi-replica boot guard — warns loud when more than one server process is
 * running against the same database.
 *
 * `pubsub.ts` distributes events through a process-local `EventEmitter`. It is
 * the sole distribution channel for Server-Sent Events and for outbound
 * webhook dispatch, which means every subscriber must live in the same process
 * as the writer that published the event.
 *
 * Run two processes against one database and that assumption quietly breaks.
 * A write handled by process A publishes only inside process A, so an SSE
 * client connected to process B never sees it, and a webhook whose consumer
 * happens to be running in process B never fires. Nothing errors. Nothing
 * retries. The write succeeds, the API returns 200, and the event is simply
 * gone. That silence is the reason this guard exists: the failure is invisible
 * at every layer an operator would think to check.
 *
 * Hosted deployments are unaffected — they run deliberately single-instance.
 * The exposure is self-hosters reaching for the ordinary way to add capacity.
 *
 * A warning rather than a refusal to start. An operator may knowingly accept
 * the trade (a replica serving only reads, say), and a guard that stops a
 * running deployment from booting after an unrelated topology change would do
 * more harm than the bug it prevents. Being impossible to miss is the goal;
 * being impossible to proceed past is not.
 *
 * **Detection is deliberately incomplete.** Node's cluster module and PM2
 * announce themselves; container orchestrators do not. A deployment scaled
 * with Kubernetes replicas, Compose `--scale`, or an ECS desired-count sets
 * nothing this code can read, so `MARFA_REPLICA_COUNT` exists for an operator
 * to declare the topology explicitly. A silent check therefore means "nothing
 * detected", never "verified safe" — which is why the documentation carries
 * the same warning for the cases no code can see.
 *
 * Mirrors the boot-guard pattern in `routes/cors-origins-check.ts`.
 */
import cluster from "node:cluster";
import { log } from "./middleware/logger.js";

export interface MultiReplicaCheckOptions {
  /**
   * Process environment to read. Injected so the check is testable without
   * mutating the real environment.
   */
  env?: NodeJS.ProcessEnv;
  /** True when this process is a Node cluster worker. */
  isClusterWorker?: boolean;
  /** When true, skip the check (test contexts). Defaults to NODE_ENV-derived. */
  skip?: boolean;
}

/**
 * Why we believe more than one replica is running. Exported for testing and
 * so callers can report the specific trigger rather than a generic message.
 */
export type ReplicaSignal =
  | { kind: "declared"; count: number }
  | { kind: "node-cluster" }
  | { kind: "pm2"; instance: string };

/**
 * Resolve whether this process appears to be one of several. Pure: no logging,
 * no environment access beyond what is passed in.
 */
export function detectMultiReplica(
  opts: MultiReplicaCheckOptions = {},
): ReplicaSignal | null {
  const env = opts.env ?? process.env;

  // An explicit operator declaration wins: it is the only signal that can
  // describe an orchestrator-managed topology, which nothing else here sees.
  const declared = env.MARFA_REPLICA_COUNT;
  if (declared !== undefined && declared !== "") {
    const count = Number(declared);
    // A value that is not a positive integer says nothing either way. Treating
    // unparseable input as "safe" would be wrong, but so would inventing a
    // replica count from it — the malformed-value warning is raised separately.
    if (Number.isInteger(count) && count > 1) {
      return { kind: "declared", count };
    }
  }

  if (opts.isClusterWorker ?? cluster.isWorker) {
    return { kind: "node-cluster" };
  }

  // PM2 numbers its cluster workers from zero. Any instance above the first
  // proves siblings exist; instance zero alone is indistinguishable from a
  // single-process PM2 deployment, which is safe.
  const pm2Instance = env.NODE_APP_INSTANCE;
  if (pm2Instance !== undefined && Number(pm2Instance) > 0) {
    return { kind: "pm2", instance: pm2Instance };
  }

  return null;
}

function describe(signal: ReplicaSignal): string {
  switch (signal.kind) {
    case "declared":
      return `MARFA_REPLICA_COUNT is set to ${String(signal.count)}`;
    case "node-cluster":
      return "this process is a Node cluster worker";
    case "pm2":
      return `this process is PM2 instance ${signal.instance}`;
  }
}

/**
 * Emit a loud startup warning when several server processes appear to be
 * running against one database. No-op when nothing is detected, or under test.
 */
export function checkMultiReplica(
  opts: MultiReplicaCheckOptions = {},
): ReplicaSignal | null {
  const skip =
    opts.skip ?? (process.env.NODE_ENV === "test" || !process.env.NODE_ENV);
  if (skip) return null;

  const env = opts.env ?? process.env;

  const declared = env.MARFA_REPLICA_COUNT;
  if (declared !== undefined && declared !== "") {
    const count = Number(declared);
    if (!Number.isInteger(count) || count < 1) {
      log(
        "warn",
        `MARFA_REPLICA_COUNT is set to "${declared}", which is not a positive ` +
          "integer. It is being ignored, so the multi-replica safety check " +
          "cannot run. Set it to the number of server processes sharing this " +
          "database.",
      );
    }
  }

  const signal = detectMultiReplica(opts);
  if (!signal) return null;

  log(
    "warn",
    `Multiple server processes appear to be running against one database ` +
      `(${describe(signal)}). Realtime event delivery is process-local: ` +
      "Server-Sent Events and outbound webhooks are distributed through an " +
      "in-process emitter, so a write handled by one process is never seen by " +
      "subscribers connected to another. Events are dropped silently — no " +
      "error, no retry, and the write itself still succeeds. Run a single " +
      "server process per database until cross-process event distribution is " +
      "supported.",
  );

  return signal;
}
