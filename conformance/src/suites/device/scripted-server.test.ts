import { describe, it, expect, afterEach } from "vitest";
import { ScriptedServer } from "../../device/scripted-server.js";
import {
  answers,
  catchupTooOld,
  connected,
  streamCursor,
} from "../../device/marfa-answers.js";

/**
 * The stimuli, before any device is asked to answer them.
 *
 * Every verdict a device has to reach starts with something the server did,
 * and several of those things the real server cannot be asked for — a dropped
 * connection, a server at rest, a spent credential, a refusal repeated until a
 * ceiling. This file proves the scripted server produces each of them, so a
 * fixture that later reports a device failing to classify one is reporting the
 * device rather than a stimulus that never arrived.
 *
 * `fidelity.test.ts` is the other half: it holds these same answers against
 * the real server's for every case the real server can produce.
 */

let server: ScriptedServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function read(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, init);
}

describe("the answers a device has to classify", () => {
  it("produces both 409 envelopes, with the fields a device rebases from", async () => {
    server = await ScriptedServer.start();
    server.answer(
      "PATCH",
      "/items/a",
      answers.versionConflict(
        { version: 3, properties: { title: "current", body: "current" } },
        { version: 1, properties: { title: "base", body: "base" } },
        ["body", "title"],
        { fields: { body: "keep_both_copies" }, default: "last_writer_wins" },
      ),
      answers.ancestorUnavailable(
        { version: 9, properties: { title: "current" } },
        1,
      ),
    );

    const conflict = await read(`${server.url}/items/a`, { method: "PATCH" });
    expect(conflict.status).toBe(409);
    const conflictBody = (await conflict.json()) as Record<
      string,
      Record<string, unknown>
    >;
    expect(conflictBody.error.code).toBe("version_conflict");
    expect(
      conflictBody.current.version,
      "the envelope did not carry the live version, so a device meeting it cannot rebase without another round trip",
    ).toBe(3);
    expect(
      conflictBody.ancestor,
      "the envelope carried no ancestor, so a device cannot tell which of its own fields actually collided",
    ).toBeDefined();
    expect(conflictBody.conflicting_fields).toEqual(["body", "title"]);
    expect(conflictBody.merge_policy).toBeDefined();

    const unavailable = await read(`${server.url}/items/a`, {
      method: "PATCH",
    });
    expect(unavailable.status).toBe(409);
    const unavailableBody = (await unavailable.json()) as Record<
      string,
      Record<string, unknown>
    >;
    expect(unavailableBody.error.code).toBe("ancestor_unavailable");
    expect(
      unavailableBody.ancestor,
      "an ancestor-unavailable refusal carried an ancestor, which is the one thing it means the server does not have",
    ).toBeUndefined();
    expect(unavailableBody.requested_version).toBe(1);
  });

  it("produces a resolution with a sibling and a resolution without one", async () => {
    server = await ScriptedServer.start();
    const item = {
      id: "a",
      version: 4,
      properties: { title: "loser", body: "winner" },
    };
    server.answer(
      "PATCH",
      "/items/a",
      answers.resolved(
        item,
        { body: "keep_both_copies", title: "last_writer_wins" },
        "sibling-1",
      ),
      answers.resolved(item, { title: "last_writer_wins" }),
    );

    const kept = (await (
      await read(`${server.url}/items/a`, { method: "PATCH" })
    ).json()) as {
      conflict_resolution: { conflicted_copy_id?: string };
    };
    expect(
      kept.conflict_resolution.conflicted_copy_id,
      "the resolution named no sibling, which is the only place the losing copy's id appears",
    ).toBe("sibling-1");

    const lww = (await (
      await read(`${server.url}/items/a`, { method: "PATCH" })
    ).json()) as {
      conflict_resolution: { conflicted_copy_id?: string };
    };
    expect(
      lww.conflict_resolution.conflicted_copy_id,
      "a resolution that kept one value still named a sibling, so a device cannot tell the two verdicts apart",
    ).toBeUndefined();
  });

  it("produces the refusals a device must not retry and the ones it must", async () => {
    server = await ScriptedServer.start();
    server.answer(
      "POST",
      "/items",
      answers.validation("invalid_properties", "body is required"),
      answers.forbidden("type_not_permitted"),
      answers.unauthorized(),
      answers.keyReused(),
      answers.serverFault(),
      answers.rateLimited(),
    );

    const seen: Array<[number, string]> = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      const response = await read(`${server.url}/items`, { method: "POST" });
      const body = (await response.json()) as { error: { code: string } };
      seen.push([response.status, body.error.code]);
    }
    expect(
      seen,
      "one of the refusals a device classifies could not be produced, so the fixture that reads it would be reporting a stimulus that never arrived",
    ).toEqual([
      [400, "invalid_properties"],
      [403, "type_not_permitted"],
      [401, "unauthorized"],
      [422, "idempotency_key_reused"],
      [500, "internal_error"],
      [429, "rate_limited"],
    ]);
  });

  it("drops a connection, which is the failure a device retries for ever", async () => {
    server = await ScriptedServer.start();
    server.answer(
      "POST",
      "/items",
      answers.dropped(),
      answers.created({ id: "a", version: 1 }),
    );

    await expect(
      read(`${server.url}/items`, { method: "POST" }),
      "the connection was answered rather than dropped, so nothing here produces the failure class that never counts toward a ceiling",
    ).rejects.toThrow();

    // The control: the same door answers once the script moves on, so the
    // throw above is the scripted drop rather than a server that is gone.
    const after = await read(`${server.url}/items`, { method: "POST" });
    expect(after.status).toBe(201);
  });

  it("goes to rest and comes back on the same address", async () => {
    server = await ScriptedServer.start();
    server.answer("GET", "/health", {
      kind: "json",
      status: 200,
      body: { status: "ok" },
    });
    expect((await read(`${server.url}/health`)).status).toBe(200);

    await server.offline();
    await expect(
      read(`${server.url}/health`),
      "the server answered while it was meant to be at rest, so offline and reconnect cannot be exercised at all",
    ).rejects.toThrow();

    await server.online();
    expect(
      (await read(`${server.url}/health`)).status,
      "the server did not come back on the address the device is bound to, so a reconnect would look like a different server",
    ).toBe(200);
  });

  it("serves an event stream, and a terminal aged-out frame", async () => {
    server = await ScriptedServer.start();
    server.answer("GET", "/events", {
      kind: "sse",
      frames: [connected, streamCursor("42"), catchupTooOld("500", "10")],
    });

    const stream = await read(`${server.url}/events`);
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
    const text = await stream.text();
    expect(
      text,
      "the stream did not open with a cursor a client can resume from",
    ).toContain("event: stream_cursor");
    expect(
      text,
      "the terminal frame an aged-out cursor gets was not produced, so the re-hydration it demands cannot be exercised",
    ).toContain("event: catchup_too_old");
    expect(text).toContain('"min_retained_id":"500"');
  });
});

describe("the script is the whole of what the server does", () => {
  it("refuses a door the fixture never scripted rather than inventing an answer", async () => {
    server = await ScriptedServer.start();
    server.answer("GET", "/health", {
      kind: "json",
      status: 200,
      body: { status: "ok" },
    });

    const unscripted = await read(`${server.url}/items`);
    expect(unscripted.status).toBe(501);
    expect(
      server.unmatchedRequests,
      "a door nobody scripted was not recorded, so a device calling somewhere the fixture never thought about would go unnoticed",
    ).toEqual(["GET /items"]);
  });

  it("records every request in the order it arrived", async () => {
    server = await ScriptedServer.start();
    server.answer("GET", "/types", { kind: "json", status: 200, body: [] });
    server.answer("GET", "/items", {
      kind: "json",
      status: 200,
      body: { data: [] },
    });

    await read(`${server.url}/types`);
    await read(`${server.url}/items?type=core.note`);

    expect(
      server.requests.map(
        (request) => `${String(request.seq)} ${request.pathname}`,
      ),
      "the order requests arrived in was not recorded, and half the statements about a device are statements about which door it went to first",
    ).toEqual(["0 /types", "1 /items"]);
    expect(server.requests[1].query.get("type")).toBe("core.note");
  });
});
