/**
 * The process-role split's substrate mechanics.
 *
 * Three layers, matching how the split can fail:
 *
 *   1. **Enqueue-only shape (fake boss, both dialects).** `registerWorkers:
 *      false` must create the queues (an enqueue needs somewhere to land)
 *      while registering no workers, seeding no schedule crons, and — the
 *      cross-role footgun — never unscheduling on stop, because unschedule
 *      deletes cron rows cluster-wide and would strip the worker's
 *      schedules out from under it.
 *
 *   2. **Cross-role hand-off (real pg-boss, PG only).** A job enqueued
 *      through an enqueue-only supervisor on one pg-boss instance is
 *      executed by a dispatching supervisor on a second instance against
 *      the same database — the web-enqueues / worker-executes shape — and
 *      is never executed by the enqueue-only side.
 *
 *   3. **Bulk wake over pg_notify (PG only).** The channel the split uses
 *      to wake the worker's bulk-action poller from a web-role enqueue
 *      actually delivers on the session client the listener rides.
 */
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import {
  createSupervisor,
  QUEUE_NAME,
  DEAD_LETTER_QUEUE,
} from "./supervisor.js";
import type {
  LocalIntegrationRegistration,
  SchedulerEnvelope,
} from "./types.js";
import type { Storage } from "../../storage/interface.js";
import type { PgBoss } from "pg-boss";
import type { PgDb, PgClient } from "../../storage/pg/connection.js";
import { BULK_JOB_WAKE_CHANNEL } from "../../bulk-actions/enqueue-signal.js";
import { createTestContext, TEST_API_KEY_SALT } from "../../test-utils.js";
import { cloneTemplate } from "../../storage/pg/test-template.js";
import { createPgStorage } from "../../storage/pg/index.js";

const isPg = process.env.DB_DIALECT === "pg";

const envelopeFor = (connectionId: string): SchedulerEnvelope => ({
  integration_name: "test/role-split",
  message: {
    kind: "schedule",
    connection_id: connectionId,
    integration_name: "test/role-split",
    scheduled_for_ms: Date.now(),
  },
});

/** Records every pg-boss call the supervisor makes. Only the surface the
 *  supervisor uses is implemented; the cast is what lets the shape tests
 *  run without a database on both dialects. */
function recordingBoss() {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve();
    };
  // What the schedule table already holds. The reconcile in `start()` reads
  // this and retires anything under the prefix that no registration wants.
  let existingSchedules: { name: string }[] = [];
  const boss = {
    createQueue: record("createQueue"),
    work: record("work"),
    schedule: record("schedule"),
    unschedule: record("unschedule"),
    getSchedules: (...args: unknown[]) => {
      calls.push({ method: "getSchedules", args });
      return Promise.resolve(existingSchedules);
    },
    send: record("send"),
    stop: record("stop"),
  };
  const of = (method: string) => calls.filter((c) => c.method === method);
  const seedSchedules = (names: string[]): void => {
    existingSchedules = names.map((name) => ({ name }));
  };
  return { boss: boss as unknown as PgBoss, calls, of, seedSchedules };
}

const shapeRegistration: LocalIntegrationRegistration = {
  name: "test/role-split",
  handlerModulePath: null,
  directDispatch: () =>
    Promise.resolve({
      result: { ok: true as const },
      cursorUpdates: {},
      cursorDeletes: [],
      threw: false,
    }),
  scheduleCron: "*/5 * * * *",
  echo: { echo_ttl_seconds: 60, lag_window_seconds: 60 },
  triggerKinds: new Set(["schedule"]),
};

const noopExecutor = {
  dispatch: (
    reg: LocalIntegrationRegistration,
    request: Parameters<
      NonNullable<LocalIntegrationRegistration["directDispatch"]>
    >[0],
  ) => reg.directDispatch!(request),
  terminate: () => Promise.resolve(),
};

// Start/enqueue/stop never touch storage (dispatch does, and these shape
// tests dispatch nothing), so an empty stub keeps them database-free.
const unusedStorage = {} as Storage;

function shapeSupervisor(boss: PgBoss, registerWorkers: boolean) {
  return createSupervisor(unusedStorage, {
    apiUrl: "http://test.local",
    apiKeySalt: TEST_API_KEY_SALT,
    authMode: "keys",
    registrations: [shapeRegistration],
    executor: noopExecutor,
    boss,
    registerWorkers,
  });
}

describe("enqueue-only supervisor shape", () => {
  it("creates the queues but registers no workers and seeds no crons", async () => {
    const { boss, of } = recordingBoss();
    const runtime = shapeSupervisor(boss, false);
    await runtime.start();

    const queues = of("createQueue").map((c) => c.args[0]);
    expect(queues).toContain(DEAD_LETTER_QUEUE);
    expect(queues).toContain(QUEUE_NAME);
    expect(of("work")).toHaveLength(0);
    expect(of("schedule")).toHaveLength(0);

    await runtime.enqueue(envelopeFor("conn-1"));
    expect(of("send").map((c) => c.args[0])).toEqual([QUEUE_NAME]);
  });

  it("never unschedules on stop — those cron rows are the worker's", async () => {
    const { boss, of } = recordingBoss();
    const runtime = shapeSupervisor(boss, false);
    await runtime.start();
    await runtime.stop();
    expect(of("unschedule")).toHaveLength(0);
    expect(of("stop")).toHaveLength(1);
  });

  // Seeding is driven from the registration set and so is the teardown, so
  // a removed integration's cron row used to be cleaned up only by luck: the
  // outgoing process had to run the old code, still list it, and exit
  // gracefully. Anything else left the row firing into a queue nothing would
  // ever work again, and nothing else would ever clear it.
  it("retires the cron of an integration this deployment no longer has", async () => {
    const { boss, of, seedSchedules } = recordingBoss();
    seedSchedules([
      "marfa.integrations.local.schedule.test/role-split",
      "marfa.integrations.local.schedule.acme/template",
    ]);
    const runtime = shapeSupervisor(boss, true);
    await runtime.start();

    // Only the one nothing registers. The live integration's schedule is
    // left alone, which is the half a blunt "unschedule everything then
    // reseed" would get wrong.
    expect(of("unschedule").map((c) => c.args[0])).toEqual([
      "marfa.integrations.local.schedule.acme/template",
    ]);
  });

  it("leaves schedules that are not the runtime's alone", async () => {
    const { boss, of, seedSchedules } = recordingBoss();
    seedSchedules([
      "marfa.scheduled.activity-purge",
      "marfa.scheduled.audit-cleanup",
      "__pgboss__send-it",
    ]);
    const runtime = shapeSupervisor(boss, true);
    await runtime.start();
    expect(of("unschedule")).toHaveLength(0);
  });

  // The enqueue-only role must not touch the schedule table at all, for the
  // same reason it never unschedules on stop: those cron rows belong to the
  // worker, and a web-role boot reconciling them would strip the worker's
  // schedules out from under it.
  it("the enqueue-only role does not reconcile schedules", async () => {
    const { boss, of, seedSchedules } = recordingBoss();
    seedSchedules(["marfa.integrations.local.schedule.acme/template"]);
    const runtime = shapeSupervisor(boss, false);
    await runtime.start();
    expect(of("getSchedules")).toHaveLength(0);
    expect(of("unschedule")).toHaveLength(0);
  });

  it("the default shape registers workers, seeds crons, and unschedules on stop", async () => {
    const { boss, of } = recordingBoss();
    const runtime = shapeSupervisor(boss, true);
    await runtime.start();
    // Dispatch queue + dead-letter queue + one schedule queue.
    expect(of("work").length).toBeGreaterThanOrEqual(3);
    expect(of("schedule")).toHaveLength(1);
    await runtime.stop();
    expect(of("unschedule")).toHaveLength(1);
  });
});

describe.skipIf(!isPg)("cross-role dispatch hand-off (real pg-boss)", () => {
  it("a job enqueued by the enqueue-only side runs on the dispatching side only", async () => {
    // Everything after the clone runs inside the try so a throw on any
    // path still drops the database and stops both boss instances.
    const clone = await cloneTemplate();
    let storage: Awaited<ReturnType<typeof createPgStorage>> | undefined;
    let bossWeb: PgBoss | undefined;
    let bossWorker: PgBoss | undefined;
    let supWeb: ReturnType<typeof createSupervisor> | undefined;
    let supWorker: ReturnType<typeof createSupervisor> | undefined;
    try {
      storage = await createPgStorage(clone.url, {
        authMode: "keys",
        maxPoolSize: 3,
        skipBootstrap: true,
      });
      // Two pg-boss instances against one database stand in for the two
      // containers; what separates roles is which instance registered
      // workers, exactly as in production.
      const { PgBoss } = await import("pg-boss");
      bossWeb = new PgBoss(clone.url);
      bossWorker = new PgBoss(clone.url);
      for (const b of [bossWeb, bossWorker]) {
        b.on("error", () => {
          // Maintenance errors must not crash the runner.
        });
        await b.start();
      }

      const seenByWeb: string[] = [];
      const seenByWorker: string[] = [];
      const reg = (
        seen: string[],
        name = "test/role-split",
      ): LocalIntegrationRegistration => ({
        ...shapeRegistration,
        name,
        directDispatch: (request) => {
          seen.push(request.message.connection_id);
          return Promise.resolve({
            result: { ok: true as const },
            cursorUpdates: {},
            cursorDeletes: [],
            threw: false,
          });
        },
      });

      // Both supervisors resolve dispatches against a real Connection so the
      // mint path works; the integration + connection rows are shared.
      const integration = await storage.items.create(
        {
          type: "system.integration",
          properties: {
            manifest_name: "test/role-split",
            manifest_version: "0.0.1",
            publisher: "test",
            manifest: {
              name: "test/role-split",
              version: "0.0.1",
              publisher: "test",
              description: "role split hand-off test",
              manifest_schema_version: "2.0.0",
              direction: "read",
              target_types: ["core.note"],
              triggers: [{ type: "schedule", config: { cron: "*/5 * * * *" } }],
              bidirectional_handling: {
                echo_ttl_seconds: 60,
                lag_window_seconds: 60,
                tombstone_mapping: "state-trashed",
                partial_write_mode: "all-or-nothing",
              },
              oauth_requirements: {},
              webhook_verification: { method: "hmac-sha256" },
              permissions: {
                extension: { "connection.runtime": "write" },
              },
            },
            registered_at: new Date().toISOString(),
          },
        },
        undefined,
      );
      const connection = await storage.items.create(
        {
          type: "system.connection",
          properties: {
            kind: "integration",
            status: "active",
            integration_ref: integration.id,
            granted_at: new Date().toISOString(),
          },
        },
        undefined,
      );

      supWeb = createSupervisor(storage, {
        apiUrl: "http://test.local",
        apiKeySalt: TEST_API_KEY_SALT,
        authMode: "keys",
        registrations: [reg(seenByWeb)],
        executor: noopExecutor,
        boss: bossWeb,
        registerWorkers: false,
      });
      supWorker = createSupervisor(storage, {
        apiUrl: "http://test.local",
        apiKeySalt: TEST_API_KEY_SALT,
        authMode: "keys",
        registrations: [reg(seenByWorker)],
        executor: noopExecutor,
        boss: bossWorker,
      });

      await supWeb.start();
      await supWorker.start();

      await supWeb.enqueue(envelopeFor(connection.id));

      while (seenByWorker.length === 0) {
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(seenByWorker).toEqual([connection.id]);
      // The enqueue-only side registered no worker, so it can never have
      // executed anything — whatever the timing.
      expect(seenByWeb).toEqual([]);

      // The worker seeded its schedule cron; the enqueue-only side
      // shutting down must not delete it.
      await supWeb.stop();
      const schedules = await bossWorker.getSchedules();
      expect(schedules.some((s) => s.name.includes("test/role-split"))).toBe(
        true,
      );
    } finally {
      // Supervisor stop() also stops its boss (idempotent — the `stopped`
      // flag makes a second call a no-op); the bare boss stops are the
      // backstop for a throw before the supervisors existed.
      await supWeb?.stop().catch(() => undefined);
      await supWorker?.stop().catch(() => undefined);
      await bossWeb?.stop({ graceful: false }).catch(() => undefined);
      await bossWorker?.stop({ graceful: false }).catch(() => undefined);
      await storage?.close().catch(() => undefined);
      await clone.drop();
    }
  }, 40_000);
});

describe.skipIf(!isPg)("bulk wake over pg_notify", () => {
  it("a notify on the wake channel reaches a listener on the session client", async () => {
    const ctx = await createTestContext();
    try {
      const sessionClient = (ctx.storage.pgStreamClient ??
        ctx.storage.pgClient) as PgClient;
      let wakes = 0;
      await sessionClient.listen(BULK_JOB_WAKE_CHANNEL, () => {
        wakes += 1;
      });
      await (ctx.storage.pgDb as PgDb).execute(
        sql`SELECT pg_notify(${BULK_JOB_WAKE_CHANNEL}, '')`,
      );
      while (wakes === 0) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(wakes).toBeGreaterThanOrEqual(1);
    } finally {
      await ctx.cleanup();
    }
  }, 20_000);
});
