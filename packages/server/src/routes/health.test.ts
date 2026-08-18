import { describe, expect, it } from "vitest";
import { healthRoutes } from "./health.js";
import type { AppConfig } from "../config.js";
import type { Storage } from "../storage/interface.js";
import type { BlobBackend } from "../storage/blob-backend.js";

/**
 * `/health` had no test at all until the endpoint stopped answering on
 * production. It could not answer because both of its probes were
 * unbounded: the database probe queues for a pool slot, and postgres.js
 * queues an unavailable reservation forever, so a fully-held pool turned
 * the liveness endpoint into the one surface that could say nothing while
 * ordinary requests were still being served.
 *
 * These use fakes rather than a database on purpose — the property under
 * test is what the endpoint does when a probe does not come back, and a
 * real database is the wrong instrument for producing that.
 */

const never = new Promise<never>(() => {
  // Deliberately never settles: this is the pool-exhaustion shape.
});

function buildStorage(count: () => Promise<number>): Storage {
  return { keys: { count } } as unknown as Storage;
}

function buildBlobs(exists: () => Promise<boolean>): BlobBackend {
  return { exists } as unknown as BlobBackend;
}

const config = { authMode: "keys" } as AppConfig;

interface HealthBody {
  status: string;
  components: {
    database?: { status: string; error?: string };
    blob_storage?: { status: string; error?: string };
  };
}

describe("GET /health", () => {
  it("reports ok when both probes answer", async () => {
    const app = healthRoutes(
      buildStorage(() => Promise.resolve(3)),
      buildBlobs(() => Promise.resolve(false)),
      config,
    );

    const res = await app.request("/");
    expect(res.status).toBe(200);

    const body = (await res.json()) as HealthBody;
    expect(body.status).toBe("ok");
    expect(body.components.database?.status).toBe("ok");
    expect(body.components.blob_storage?.status).toBe("ok");
  });

  it("answers degraded instead of hanging when the database probe never returns", async () => {
    const app = healthRoutes(
      buildStorage(() => never),
      buildBlobs(() => Promise.resolve(false)),
      config,
    );

    const started = Date.now();
    const res = await app.request("/");
    const elapsed = Date.now() - started;

    // Answering at all is the point. The status code stays 200 because
    // the deploy gate reads the body, and a degraded build that is
    // serving is still the build that is serving.
    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(10_000);

    const body = (await res.json()) as HealthBody;
    expect(body.status).toBe("degraded");
    expect(body.components.database?.status).toBe("degraded");
    expect(body.components.database?.error).toContain("pool");
  }, 15_000);

  it("answers degraded instead of hanging when blob storage never returns", async () => {
    const app = healthRoutes(
      buildStorage(() => Promise.resolve(3)),
      buildBlobs(() => never),
      config,
    );

    const res = await app.request("/");
    expect(res.status).toBe(200);

    const body = (await res.json()) as HealthBody;
    expect(body.status).toBe("degraded");
    expect(body.components.blob_storage?.status).toBe("degraded");
    // The database still answered, and the endpoint still says so.
    expect(body.components.database?.status).toBe("ok");
  }, 15_000);

  it("separates a refusal from a timeout", async () => {
    const app = healthRoutes(
      buildStorage(() => Promise.reject(new Error("connection refused"))),
      buildBlobs(() => Promise.resolve(false)),
      config,
    );

    const res = await app.request("/");
    const body = (await res.json()) as HealthBody;
    // `down` means the database answered with a refusal; `degraded` means
    // no answer arrived. Collapsing them would lose the distinction that
    // tells an operator whether to look at the database or at the pool.
    expect(body.components.database?.status).toBe("down");
    expect(body.components.database?.error).toContain("connection refused");
  });
});
