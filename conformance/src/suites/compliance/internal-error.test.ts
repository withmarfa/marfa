import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";

/**
 * A fault nothing foresaw answers `500 internal_error`, in the envelope,
 * saying nothing of what failed.
 *
 * **A fault the fixture makes, on a server of its own.** The server answers
 * every input it knows a refusal for, so no request reaches a fault: that is
 * the point of the refusals. What reaches one is an instance whose storage is
 * not what the server expects, here the audit log's table renamed in the
 * stored file while the server runs, which the audit door reads. The table is
 * renamed back afterward.
 */
let server: FreshServer | undefined;

beforeAll(async () => {
  server = await bootFreshServer("internal-error");
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

function audit(): Promise<Response> {
  return fetch(`${server!.apiUrl}/audit`, {
    headers: { Authorization: `Bearer ${server!.workingKey}` },
  });
}

function renameAuditLog(from: string, to: string): void {
  withInstanceDatabase(server!.sqlitePath, (db) => {
    db.exec(`ALTER TABLE ${from} RENAME TO ${to}`);
  });
}

describe("an unhandled fault", () => {
  it("answers 500 internal_error with the code and a fixed message and nothing else, and the instance answers again once it is gone", async () => {
    // The control: the door answers before the fault is made.
    expect((await audit()).status).toBe(200);

    renameAuditLog("audit_log", "audit_log_gone");
    try {
      const faulted = await audit();
      expect(faulted.status).toBe(500);
      expect(faulted.headers.get("X-Error-Code")).toBe("internal_error");
      expect(faulted.headers.get("X-Request-ID")).not.toBeNull();
      // Exactly the envelope's two members: nothing of the table, the query
      // or the stack that failed reaches a caller.
      expect(await faulted.json()).toEqual({
        error: { code: "internal_error", message: "Internal server error" },
      });
    } finally {
      renameAuditLog("audit_log_gone", "audit_log");
    }

    expect((await audit()).status).toBe(200);
  });
});

/**
 * A fault that one entry of a bulk page meets, which the page reports on
 * the entry: a trigger in the stored file refuses the insert of one row, by
 * a value only that entry carries, with a reason of its own.
 */
function withTrigger<T>(statement: string, use: () => Promise<T>): Promise<T> {
  withInstanceDatabase(server!.sqlitePath, (db) => {
    db.exec(statement);
  });
  return use().finally(() => {
    withInstanceDatabase(server!.sqlitePath, (db) => {
      db.exec("DROP TRIGGER IF EXISTS refuse_entry");
    });
  });
}

function bulk(path: string, body: unknown): Promise<Response> {
  return fetch(`${server!.apiUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${server!.workingKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

interface Page {
  counts: Record<string, number>;
  results: {
    index: number;
    outcome: string;
    id?: string;
    error?: { code: string; message: string; details?: unknown };
  }[];
}

const ENTRY_FAULT = "The entry could not be written, and nothing of it was";

describe("an unhandled fault met by one entry of a bulk page", () => {
  it("is reported on that entry as internal_error with the entry's own message and no details, while the entries around it land", async () => {
    const refused = "refused-in-a-page";
    const items = [
      {
        type: "core.note",
        source_id: "bulk-fault-a",
        properties: { body: "a" },
      },
      { type: "core.note", source_id: refused, properties: { body: "b" } },
      {
        type: "core.note",
        source_id: "bulk-fault-c",
        properties: { body: "c" },
      },
    ];
    const faulted = await withTrigger(
      `CREATE TRIGGER refuse_entry BEFORE INSERT ON items WHEN NEW.source_id = '${refused}' BEGIN SELECT RAISE(ABORT, 'refused by the store'); END`,
      () => bulk("/items/bulk", { atomic: false, items }),
    );
    expect(faulted.status).toBe(200);
    const page = (await faulted.json()) as Page;
    expect(page.counts).toEqual({
      created: 2,
      updated: 0,
      skipped: 0,
      errored: 1,
    });
    expect(page.results.map((r) => r.outcome)).toEqual([
      "created",
      "errored",
      "created",
    ]);
    // Exactly the code and the message: nothing of the trigger's reason, the
    // statement or the values reaches the entry.
    expect(page.results[1]?.error).toEqual({
      code: "internal_error",
      message: ENTRY_FAULT,
    });

    // The witness that nothing of the entry was written: with the fault
    // gone the same entry is created, not updated.
    const again = await bulk("/items/bulk", {
      atomic: false,
      items: [items[1]],
    });
    expect(again.status).toBe(200);
    expect(((await again.json()) as Page).results[0]?.outcome).toBe("created");
  });

  it("answers an atomic page 500 internal_error in the envelope, with no entry to name", async () => {
    const refused = "refused-in-an-atomic-page";
    const items = [
      {
        type: "core.note",
        source_id: "atomic-fault-a",
        properties: { body: "a" },
      },
      { type: "core.note", source_id: refused, properties: { body: "b" } },
    ];
    const faulted = await withTrigger(
      `CREATE TRIGGER refuse_entry BEFORE INSERT ON items WHEN NEW.source_id = '${refused}' BEGIN SELECT RAISE(ABORT, 'refused by the store'); END`,
      () => bulk("/items/bulk", { atomic: true, items }),
    );
    expect(faulted.status).toBe(500);
    expect(faulted.headers.get("X-Error-Code")).toBe("internal_error");
    expect(await faulted.json()).toEqual({
      error: { code: "internal_error", message: "Internal server error" },
    });
  });

  it("is reported the same way on an entry of an edge page", async () => {
    const ids: string[] = [];
    for (const body of ["source", "kept", "refused", "also kept"]) {
      const made = await fetch(`${server!.apiUrl}/items`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${server!.workingKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ type: "core.note", properties: { body } }),
      });
      expect(made.status).toBe(201);
      ids.push(((await made.json()) as { item: { id: string } }).item.id);
    }
    const [source, kept, poisoned, alsoKept] = ids as [
      string,
      string,
      string,
      string,
    ];
    const edges = [kept, poisoned, alsoKept].map((target_id) => ({
      source_id: source,
      target_id,
      edge_type: "references",
    }));
    const faulted = await withTrigger(
      `CREATE TRIGGER refuse_entry BEFORE INSERT ON edges WHEN NEW.target_id = '${poisoned}' BEGIN SELECT RAISE(ABORT, 'refused by the store'); END`,
      () => bulk("/edges/bulk", { atomic: false, edges }),
    );
    expect(faulted.status).toBe(200);
    const page = (await faulted.json()) as Page;
    expect(page.counts).toMatchObject({ created: 2, errored: 1 });
    expect(page.results[1]?.error).toEqual({
      code: "internal_error",
      message: ENTRY_FAULT,
    });

    const atomic = await withTrigger(
      `CREATE TRIGGER refuse_entry BEFORE INSERT ON edges WHEN NEW.target_id = '${poisoned}' BEGIN SELECT RAISE(ABORT, 'refused by the store'); END`,
      () => bulk("/edges/bulk", { atomic: true, edges }),
    );
    expect(atomic.status).toBe(500);
    expect(await atomic.json()).toEqual({
      error: { code: "internal_error", message: "Internal server error" },
    });
  });
});
