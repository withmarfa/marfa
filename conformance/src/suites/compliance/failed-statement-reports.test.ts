import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * A failed database statement reported where a client can read the report:
 * the health answer, a housekeeping run's record and a bulk action's errors
 * carry `Database operation failed` and the SQLite result code, and none of
 * the statement, the driver's own message or the values it was bound to.
 *
 * **A fault the fixture makes, on a server of its own.** No request reaches a
 * failed statement, so the target fails one: the probe write of the health
 * answer, the first statement of a housekeeping run and the first statement
 * of a bulk action's row, as `internal-error.test.ts` does for a write.
 *
 * **What a fixture shows of the values.** The witness that the report could
 * have carried one is the value the failing write was given, read back over
 * HTTP from the rows the same write stored before the fault.
 */
let server: FreshServer | undefined;

beforeAll(async () => {
  server = await bootFreshServer("failed-statement-reports");
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterEach(async () => {
  await server?.clearFault();
});

afterAll(async () => {
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

function operator(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${server!.apiUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${server!.managementKey}`,
      ...init.headers,
    },
  });
}

/** What a failed statement makes a report say, and nothing of the statement or the driver's message. */
function expectFixedFailure(reported: string | null | undefined): void {
  expect(reported).toBe("Database operation failed (SQLITE_IOERR)");
}

describe("the health answer to a write that fails", () => {
  type Health = {
    status: string;
    components: Record<string, { status: string; error?: string }>;
  };

  async function health(): Promise<Health & { httpStatus: number }> {
    const res = await operator("/health");
    return { httpStatus: res.status, ...((await res.json()) as Health) };
  }

  it("names a database failure with its SQLite code, and none of the statement, the driver's message or the values the probe write was bound to", async () => {
    // The witness: the probe's write commits while its table is there.
    const before = await health();
    expect(before.httpStatus).toBe(200);
    expect(before.components.database_write?.status).toBe("ok");

    await server!.setFault("fail:health-write");
    // A committed probe answers for the callers after it for a few seconds,
    // so the fault is waited for rather than assumed.
    const deadline = Date.now() + 30_000;
    let down = await health();
    while (
      down.components.database_write?.status === "ok" &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      down = await health();
    }

    const write = down.components.database_write;
    expect(down.status).toBe("down");
    expect(write?.status).toBe("down");
    expectFixedFailure(write?.error);
  });
});

describe("a housekeeping run whose statement fails", () => {
  it("records a database failure with its SQLite code and none of the statement, the driver's message or the values, in the run's answer and in the list", async () => {
    // The witness: the same run ends well while its table is there.
    const clean = await operator("/housekeeping/audit-cleanup/run", {
      method: "POST",
    });
    expect(clean.status).toBe(200);
    expect(((await clean.json()) as { outcome: string }).outcome).toBe("ok");

    await server!.setFault("fail:housekeeping:audit-cleanup");
    const failed = await operator("/housekeeping/audit-cleanup/run", {
      method: "POST",
    });
    expect(failed.status).toBe(200);
    const run = (await failed.json()) as {
      outcome: string;
      error: string | null;
    };
    expect(run.outcome).toBe("error");

    const listed = await operator("/housekeeping");
    const job = (
      (await listed.json()) as {
        data: {
          name: string;
          last_outcome: string;
          last_error: string | null;
        }[];
      }
    ).data.find((row) => row.name === "audit-cleanup");
    expect(job?.last_outcome).toBe("error");

    for (const recorded of [run.error, job?.last_error])
      expectFixedFailure(recorded);
  });
});

describe("a bulk action whose writes fail", () => {
  async function act(tag: string, marker: string): Promise<unknown> {
    const queued = await fetch(`${server!.apiUrl}/items/bulk-actions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${server!.workingKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action: "update_tags",
        filter: { tags: [marker] },
        add: [tag],
      }),
    });
    expect(queued.status).toBe(202);
    const { id } = (await queued.json()) as { id: string };
    const deadline = Date.now() + 30_000;
    for (;;) {
      const read = await fetch(
        `${server!.apiUrl}/items/bulk-actions/jobs/${id}`,
        {
          headers: { Authorization: `Bearer ${server!.workingKey}` },
        },
      );
      expect(read.status).toBe(200);
      const job = (await read.json()) as { status: string };
      if (["completed", "failed"].includes(job.status)) return job;
      expect(Date.now(), "the job never ended").toBeLessThan(deadline);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  it("names a database failure with its SQLite code in each entry's error, and none of the statement, the driver's message or the values its write was bound to", async () => {
    const marker = `marker-${Date.now().toString(36)}`;
    const body = `body ${marker}`;
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const created = await fetch(`${server!.apiUrl}/items`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${server!.workingKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "core.note",
          properties: { body },
          tags: [marker],
        }),
      });
      expect(created.status).toBe(201);
      ids.push(((await created.json()) as { item: { id: string } }).item.id);
    }

    // The witness: with no fault the action lands, and the items it tagged
    // carry the tag and the properties, which are what the failing write is
    // bound to.
    const tagged = `tagged-${marker}`;
    const landed = (await act(tagged, marker)) as {
      succeeded: number;
      errored: number;
    };
    expect(landed).toMatchObject({ succeeded: 2, errored: 0 });
    const listed = await fetch(
      `${server!.apiUrl}/items?tags=${encodeURIComponent(tagged)}`,
      { headers: { Authorization: `Bearer ${server!.workingKey}` } },
    );
    const { data } = (await listed.json()) as {
      data: { id: string; properties: { body: string } }[];
    };
    expect(data.map((item) => item.id).sort()).toEqual([...ids].sort());
    for (const item of data) expect(item.properties.body).toBe(body);

    const refused = `refused-${marker}`;
    await server!.setFault("fail:job-row");
    const failed = (await act(refused, marker)) as {
      succeeded: number;
      errored: number;
      result: { errors: { id: string; code: string; message: string }[] };
    };
    // The fault ends the chunk at its first item, which is reported, and the
    // job goes on to write the other.
    expect(failed).toMatchObject({ succeeded: 1, errored: 1 });
    expect(failed.result.errors).toHaveLength(1);
    expect(ids).toContain(failed.result.errors[0]?.id);
    for (const entry of failed.result.errors) {
      expect(entry.code).toBe("internal_error");
      expectFixedFailure(entry.message);
    }
  });
});
