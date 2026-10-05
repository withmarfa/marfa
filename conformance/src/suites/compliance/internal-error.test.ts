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
