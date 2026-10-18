import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";
import { movedClock } from "../../utils/moved-clock.js";

/**
 * These cases need their own server: an in-flight claim needs stored state
 * arranged and the clock moved; an oversized answer needs a request cap above
 * the shared server's; a changed contract needs a restart onto another version.
 */
let server: FreshServer | undefined;
let clock: ReturnType<typeof movedClock>;

/** The request cap this file's server takes, above the 1 MiB it defaults to. */
const REQUEST_CAP_BYTES = 4 * 1024 * 1024;

/** The retention bound on a stored answer, in bytes. */
const RETENTION_BOUND_BYTES = 1_048_576;

beforeAll(async () => {
  server = await bootFreshServer("idempotency-refusals", {
    MARFA_MAX_REQUEST_BYTES: String(REQUEST_CAP_BYTES),
  });
  clock = movedClock(server);
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

async function send(
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${server!.apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${server!.workingKey}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function liveItems(): Promise<number> {
  const stats = await send("GET", "/items/stats", undefined);
  expect(stats.status).toBe(200);
  const body = (await stats.json()) as { active?: number };
  return body.active ?? 0;
}

/** A type of twelve text fields, so that a body can pass 1 MiB under the per-field cap. */
const WIDE_FIELDS = 12;
const WIDE_TYPE = "idempotency.wide";

async function registerWideType(): Promise<void> {
  const fields: Record<string, { type: "string" }> = {};
  for (let n = 0; n < WIDE_FIELDS; n++)
    fields[`f${String(n)}`] = { type: "string" };
  const registered = await send("POST", "/types", {
    id: WIDE_TYPE,
    version: 1,
    fields,
  });
  expect(registered.status).toBe(201);
}

function wideItem(fill: string): unknown {
  const properties: Record<string, string> = {};
  for (let n = 0; n < WIDE_FIELDS; n++) {
    // Under the 100,000-character cap a field takes, so the write is accepted.
    properties[`f${String(n)}`] = fill.repeat(99_000);
  }
  return { type: WIDE_TYPE, properties };
}

describe("an Idempotency-Key repeated after its first answer was too large to keep", () => {
  it("answers 422 idempotency_result_not_retained, naming the first status, and writes nothing again", async () => {
    await registerWideType();
    const before = await liveItems();
    const key = "retention-large-answer";

    const first = await send("POST", "/items", wideItem("a"), {
      "Idempotency-Key": key,
    });
    expect(first.status).toBe(201);
    // The premise: what was answered is past what a record keeps. Without it
    // the repeat below would be a replay, and the refusal untested.
    const answered = await first.arrayBuffer();
    expect(answered.byteLength).toBeGreaterThan(RETENTION_BOUND_BYTES);
    expect(await liveItems()).toBe(before + 1);

    const repeat = await send("POST", "/items", wideItem("a"), {
      "Idempotency-Key": key,
    });
    expect(repeat.status).toBe(422);
    expect(repeat.headers.get("X-Error-Code")).toBe(
      "idempotency_result_not_retained",
    );
    expect(repeat.headers.get("Idempotency-Replayed")).toBeNull();
    const body = (await repeat.json()) as {
      error: { code: string; message: string; details: unknown };
    };
    expect(body.error.code).toBe("idempotency_result_not_retained");
    expect(body.error.details).toEqual({ original_status: 201 });
    // The refusal is the whole answer: the write is not repeated.
    expect(await liveItems()).toBe(before + 1);
  });

  it("replays an answer within the bound, so the refusal belongs to the size", async () => {
    // The witness for the case above: the same door, key and credential
    // replay the first answer when it was small enough to keep.
    const key = "retention-small-answer";
    const small = { type: "core.note", properties: { body: "kept" } };
    const first = await send("POST", "/items", small, {
      "Idempotency-Key": key,
    });
    expect(first.status).toBe(201);
    const original = (await first.json()) as { item: { id: string } };

    const repeat = await send("POST", "/items", small, {
      "Idempotency-Key": key,
    });
    expect(repeat.status).toBe(201);
    expect(repeat.headers.get("Idempotency-Replayed")).toBe("true");
    expect(((await repeat.json()) as { item: { id: string } }).item.id).toBe(
      original.item.id,
    );
  });
});

describe("an Idempotency-Key repeated while its first request is still being served", () => {
  /**
   * The state a writer leaves while it runs: the key claimed, no answer
   * recorded. The window a live request holds it for is a few milliseconds
   * on one event loop, which sixteen concurrent sends of one key over HTTP
   * never landed in, so the record is arranged in the instance's own file.
   * Its age is not: the claim is as old as the server's clock says.
   */
  function leaveClaimed(key: string): number {
    return withInstanceDatabase(server!.sqlitePath, (db) => {
      const changed = db
        .prepare(
          `UPDATE idempotency_records
             SET state = 'in_flight', response_status = NULL,
                 response_content_type = NULL, response_body = NULL,
                 completed_at = NULL
           WHERE idempotency_key = ?`,
        )
        .run(key);
      return Number(changed.changes);
    });
  }

  it("answers 409 idempotency_key_in_flight and writes nothing, until the claim is past its lease", async () => {
    const key = "in-flight-claim";
    const request = { type: "core.note", properties: { body: "once" } };
    const before = await liveItems();

    const first = await send("POST", "/items", request, {
      "Idempotency-Key": key,
    });
    expect(first.status).toBe(201);
    // The control: with the record complete, the repeat is a replay.
    const replayed = await send("POST", "/items", request, {
      "Idempotency-Key": key,
    });
    expect(replayed.status).toBe(201);
    expect(replayed.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await liveItems()).toBe(before + 1);

    // Ten seconds inside the 60-second lease, so that the bound is what holds
    // the key and not the claim being new.
    expect(leaveClaimed(key)).toBe(1);
    await clock.advance(50 * 1000);
    const busy = await send("POST", "/items", request, {
      "Idempotency-Key": key,
    });
    expect(busy.status).toBe(409);
    expect(busy.headers.get("X-Error-Code")).toBe("idempotency_key_in_flight");
    const body = (await busy.json()) as { error: { code: string } };
    expect(body.error.code).toBe("idempotency_key_in_flight");
    expect(await liveItems()).toBe(before + 1);

    // A claim nobody is serving does not hold the key for good: a writer
    // that died leaves one, and the retry the code asks for takes it over
    // once it is a second past the lease.
    await clock.advance(11 * 1000);
    const taken = await send("POST", "/items", request, {
      "Idempotency-Key": key,
    });
    expect(taken.status).toBe(201);
    expect(taken.headers.get("Idempotency-Replayed")).toBeNull();
  });
});

describe("an Idempotency-Key repeated after the server's contract version changed", () => {
  const SECOND_CONTRACT = "1";

  async function contractOf(): Promise<{
    header: string | null;
    root: number;
  }> {
    const root = await fetch(`${server!.apiUrl}/`, {
      headers: { Accept: "application/json" },
    });
    const body = (await root.json()) as { contract: number };
    return {
      header: root.headers.get("X-Marfa-Contract"),
      root: body.contract,
    };
  }

  it(
    "answers 422 idempotency_key_reused and writes nothing again",
    async () => {
      const key = "contract-change";
      const request = { type: "core.note", properties: { body: "contract" } };
      const before = await liveItems();
      const first = await send("POST", "/items", request, {
        "Idempotency-Key": key,
      });
      expect(first.status).toBe(201);
      const original = (await first.json()) as { item: { id: string } };
      // The witness: under the contract it was made under, the repeat replays.
      const replayed = await send("POST", "/items", request, {
        "Idempotency-Key": key,
      });
      expect(replayed.status).toBe(201);
      expect(replayed.headers.get("Idempotency-Replayed")).toBe("true");
      const first_contract = await contractOf();

      try {
        await server!.restart({
          env: { MARFA_TEST_CONTRACT_VERSION: SECOND_CONTRACT },
        });
        const moved = await contractOf();
        expect(moved).toEqual({ header: SECOND_CONTRACT, root: 1 });
        expect(moved.root).not.toBe(first_contract.root);

        const repeat = await send("POST", "/items", request, {
          "Idempotency-Key": key,
        });
        expect(repeat.status).toBe(422);
        expect(repeat.headers.get("X-Error-Code")).toBe(
          "idempotency_key_reused",
        );
        expect(repeat.headers.get("Idempotency-Replayed")).toBeNull();
        expect(await liveItems()).toBe(before + 1);
      } finally {
        // The boot after this one is back on the first contract.
        await server!.restart();
      }

      // The witness: back on the first contract, the same key replays, so the
      // refusal belonged to the contract and not to a record the restart lost.
      expect(await contractOf()).toEqual(first_contract);
      const again = await send("POST", "/items", request, {
        "Idempotency-Key": key,
      });
      expect(again.status).toBe(201);
      expect(again.headers.get("Idempotency-Replayed")).toBe("true");
      expect(((await again.json()) as { item: { id: string } }).item.id).toBe(
        original.item.id,
      );
    },
    3 * FRESH_SERVER_TIMEOUT_MS,
  );
});
