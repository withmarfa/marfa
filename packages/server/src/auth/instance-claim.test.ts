import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteStorage } from "../storage/sqlite/index.js";
import { createMarfaAuth } from "./instance.js";
import {
  claimOwner,
  exchangeSetupTicket,
  exchangeSetupCode,
  getClaimStatus,
  issueSetupCode,
  issueSetupTicket,
  recoverOwnerPassword,
} from "./instance-claim.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "marfa-claim-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "db.sqlite");
  const storage = await createSqliteStorage(path);
  cleanups.push(() => storage.close());
  const auth = createMarfaAuth({
    db: storage.betterAuthDb as Parameters<typeof createMarfaAuth>[0]["db"],
    storage,
    baseURL: "http://localhost:8600",
    secret: "test-claim-secret-at-least-thirty-two-characters",
  });
  await auth.ready;
  return { storage, auth, path };
}
const details = {
  email: "owner@example.com",
  password: "correct horse battery",
};

describe("durable instance claim", () => {
  it("creates a real sign-in and keeps claim closed if the owner disappears", async () => {
    const { storage, auth } = await fixture();
    const { code } = await issueSetupCode(storage);
    expect(code.replaceAll("-", "")).toMatch(/^[A-Z2-7]{26}$/);
    const owner = await claimOwner(storage, auth, {
      ...details,
      proof: { kind: "code", code, address: "127.0.0.1" },
    });
    const response = await auth.handler(
      new Request("http://localhost:8600/auth/sign-in/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:8600",
        },
        body: JSON.stringify(details),
      }),
      "127.0.0.1",
    );
    expect(response.status).toBe(200);
    expect((await getClaimStatus(storage)).ownerId).toBe(owner.id);
    await storage.__sqliteRun("DELETE FROM auth_user", []);
    await expect(issueSetupCode(storage)).rejects.toMatchObject({
      code: "owner_exists",
    });
    await expect(
      claimOwner(storage, auth, { ...details, proof: { kind: "local" } }),
    ).rejects.toMatchObject({ code: "owner_exists" });
  });
  it("counts wrong codes durably by address, leaving another address and local proof usable", async () => {
    const { storage, auth, path } = await fixture();
    await issueSetupCode(storage);
    for (let i = 0; i < 10; i++)
      await expect(
        exchangeSetupCode(storage, "wrong", "192.0.2.1"),
      ).rejects.toMatchObject({ code: "unauthorized" });
    const peer = await createSqliteStorage(path);
    cleanups.push(() => peer.close());
    await expect(
      exchangeSetupCode(peer, "wrong", "192.0.2.1"),
    ).rejects.toMatchObject({ code: "rate_limited" });
    await expect(
      exchangeSetupCode(peer, "wrong", "192.0.2.2"),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(
      (
        await claimOwner(storage, auth, {
          ...details,
          proof: { kind: "local" },
        })
      ).email,
    ).toBe(details.email);
  });
  it("spends tickets once and invalidates tickets and sessions on replacement", async () => {
    const { storage, auth } = await fixture();
    await issueSetupCode(storage);
    const { ticket } = await issueSetupTicket(storage);
    const { token } = await exchangeSetupTicket(storage, ticket);
    await expect(exchangeSetupTicket(storage, ticket)).rejects.toMatchObject({
      code: "unauthorized",
    });
    const old = await issueSetupTicket(storage);
    await issueSetupCode(storage);
    await expect(
      exchangeSetupTicket(storage, old.ticket),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await expect(
      claimOwner(storage, auth, {
        ...details,
        proof: { kind: "session", token },
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });
  it("does not consume proof or create an account for malformed details or audit failure", async () => {
    const { storage, auth } = await fixture();
    const { code } = await issueSetupCode(storage);
    const input = {
      ...details,
      proof: { kind: "code" as const, code, address: "127.0.0.1" },
    };
    await expect(
      claimOwner(storage, auth, { ...input, email: "broken" }),
    ).rejects.toMatchObject({ code: "validation_error" });
    const audit = vi
      .spyOn(storage.audit, "log")
      .mockRejectedValue(new Error("audit unavailable"));
    await expect(claimOwner(storage, auth, input)).rejects.toThrow(
      "audit unavailable",
    );
    audit.mockRestore();
    expect(await storage.__sqliteAll("SELECT id FROM auth_user")).toHaveLength(
      0,
    );
    expect((await claimOwner(storage, auth, input)).email).toBe(details.email);
  });
  it("resets the password and revokes browser sessions atomically", async () => {
    const { storage, auth } = await fixture();
    await claimOwner(storage, auth, { ...details, proof: { kind: "local" } });
    async function signIn(password: string) {
      return auth.handler(
        new Request("http://localhost:8600/auth/sign-in/email", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://localhost:8600",
          },
          body: JSON.stringify({ ...details, password }),
        }),
        "127.0.0.1",
      );
    }
    expect((await signIn(details.password)).status).toBe(200);
    expect(
      await storage.__sqliteAll("SELECT id FROM auth_session"),
    ).toHaveLength(1);
    await recoverOwnerPassword(storage, auth, {
      password: "replacement password",
    });
    expect(
      await storage.__sqliteAll("SELECT id FROM auth_session"),
    ).toHaveLength(0);
    expect((await signIn(details.password)).status).toBe(401);
    expect((await signIn("replacement password")).status).toBe(200);
    expect((await getClaimStatus(storage)).claimed).toBe(true);
  });
});

describe("claim across real processes", () => {
  async function child(
    path: string,
    code: string,
    mode?: "before-commit" | "after-commit",
  ) {
    const { fork } = await import("node:child_process");
    const proc = fork(
      new URL("./instance-claim-worker.fixture.ts", import.meta.url),
      {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      },
    );
    cleanups.push(() => {
      if (proc.exitCode === null) proc.kill();
      return Promise.resolve();
    });
    const ready = new Promise<void>((resolve, reject) => {
      proc.once("message", () => {
        resolve();
      });
      proc.once("error", reject);
    });
    proc.send({ path, code, mode });
    await ready;
    return {
      run: () =>
        new Promise<{ id?: string; code?: string; signal?: string }>(
          (resolve, reject) => {
            proc.once("message", (message) => {
              resolve(message as { id?: string; code?: string });
            });
            proc.once("exit", (_code, signal) => {
              if (signal) resolve({ signal });
            });
            proc.once("error", reject);
            proc.send({ go: true });
          },
        ),
    };
  }
  it("creates exactly one owner from competing processes", async () => {
    const { storage, path } = await fixture();
    const { code } = await issueSetupCode(storage);
    const processes = await Promise.all([
      child(path, code),
      child(path, code),
      child(path, code),
    ]);
    const results = await Promise.all(processes.map((p) => p.run()));
    expect(results.filter((r) => r.id)).toHaveLength(1);
    expect(await storage.__sqliteAll("SELECT id FROM auth_user")).toHaveLength(
      1,
    );
    expect((await getClaimStatus(storage)).ownerId).toBe(
      results.find((r) => r.id)?.id,
    );
    expect(
      await storage.__sqliteAll(
        "SELECT id FROM audit_log WHERE action='owner.claimed'",
      ),
    ).toHaveLength(1);
  });
  it("rolls back a crash before audited completion and survives a lost response after commit", async () => {
    const { storage, auth, path } = await fixture();
    const { code } = await issueSetupCode(storage);
    const before = await child(path, code, "before-commit");
    expect((await before.run()).signal).toBe("SIGKILL");
    expect((await getClaimStatus(storage)).claimed).toBe(false);
    expect(await storage.__sqliteAll("SELECT id FROM auth_user")).toHaveLength(
      0,
    );
    const after = await child(path, code, "after-commit");
    expect((await after.run()).signal).toBe("SIGKILL");
    expect((await getClaimStatus(storage)).claimed).toBe(true);
    expect(await storage.__sqliteAll("SELECT id FROM auth_user")).toHaveLength(
      1,
    );
    await expect(
      claimOwner(storage, auth, { ...details, proof: { kind: "local" } }),
    ).rejects.toMatchObject({ code: "owner_exists" });
  });
});
