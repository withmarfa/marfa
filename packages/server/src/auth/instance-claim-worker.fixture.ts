import { createSqliteStorage } from "../storage/sqlite/index.js";
import { createMarfaAuth } from "./instance.js";
import { claimOwner } from "./instance-claim.js";
interface Input {
  path: string;
  code: string;
  mode?: "before-commit" | "after-commit";
}
async function start(input: Input) {
  const storage = await createSqliteStorage(input.path);
  const auth = createMarfaAuth({
    db: storage.betterAuthDb as Parameters<typeof createMarfaAuth>[0]["db"],
    storage,
    baseURL: "http://localhost:8600",
    secret: "child-claim-secret-at-least-thirty-two-characters",
  });
  await auth.ready;
  if (input.mode === "before-commit") {
    const original = storage.audit.log.bind(storage.audit);
    storage.audit.log = async (...args) => {
      if (args[0].action === "owner.claimed")
        process.kill(process.pid, "SIGKILL");
      return original(...args);
    };
  }
  const run = async () => {
    try {
      const owner = await claimOwner(storage, auth, {
        email: "owner@example.com",
        password: "correct horse battery",
        proof: { kind: "code", code: input.code, address: "127.0.0.1" },
      });
      if (input.mode === "after-commit") process.kill(process.pid, "SIGKILL");
      process.send?.({ id: owner.id });
    } catch (error) {
      process.send?.({
        code: (error as { code?: string }).code ?? "unexpected_failure",
      });
    } finally {
      await storage.close();
      process.disconnect?.();
    }
  };
  process.once("message", () => {
    void run().catch(() => {
      process.exitCode = 1;
    });
  });
  process.send?.({ ready: true });
}
process.once("message", (input: Input) => {
  void start(input).catch(() => {
    process.exitCode = 1;
    process.disconnect?.();
  });
});
