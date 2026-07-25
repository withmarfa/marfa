import { describe, it, expect } from "vitest";
import { detectMultiReplica } from "./multi-replica-check.js";

describe("detectMultiReplica", () => {
  const single = { env: {}, isClusterWorker: false };

  it("detects nothing for an ordinary single-process deployment", () => {
    expect(detectMultiReplica(single)).toBeNull();
  });

  it("detects an explicitly declared replica count above one", () => {
    expect(
      detectMultiReplica({ ...single, env: { MARFA_REPLICA_COUNT: "3" } }),
    ).toEqual({ kind: "declared", count: 3 });
  });

  it("stays silent when the declared replica count is exactly one", () => {
    expect(
      detectMultiReplica({ ...single, env: { MARFA_REPLICA_COUNT: "1" } }),
    ).toBeNull();
  });

  it("detects a Node cluster worker", () => {
    expect(detectMultiReplica({ ...single, isClusterWorker: true })).toEqual({
      kind: "node-cluster",
    });
  });

  it("detects a PM2 worker beyond the first", () => {
    expect(
      detectMultiReplica({ ...single, env: { NODE_APP_INSTANCE: "2" } }),
    ).toEqual({ kind: "pm2", instance: "2" });
  });

  it("does not treat PM2 instance zero as multi-replica", () => {
    // Instance zero is what a single-process PM2 deployment also reports, so
    // it proves nothing on its own. Warning here would fire on safe setups.
    expect(
      detectMultiReplica({ ...single, env: { NODE_APP_INSTANCE: "0" } }),
    ).toBeNull();
  });

  it.each(["", "0", "-2", "many", "2.5"])(
    "ignores an unusable replica count (%j) rather than inventing one",
    (value) => {
      expect(
        detectMultiReplica({ ...single, env: { MARFA_REPLICA_COUNT: value } }),
      ).toBeNull();
    },
  );

  it("prefers the operator's declaration over process-level signals", () => {
    // An orchestrator-managed topology is only ever visible through the
    // declaration, so it has to win where both are present.
    expect(
      detectMultiReplica({
        env: { MARFA_REPLICA_COUNT: "4", NODE_APP_INSTANCE: "1" },
        isClusterWorker: true,
      }),
    ).toEqual({ kind: "declared", count: 4 });
  });
});
