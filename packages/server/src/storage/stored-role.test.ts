/**
 * The boundary that narrows a stored role.
 *
 * These exist because the fix they cover is otherwise untestable from the
 * outside. Every gate downstream compares role literals, so a stale value
 * and a genuine `member` both come out as "refused" at the route layer, and
 * a test driving a route would pass identically whether or not this
 * narrowing happens. The one place the two differ is here.
 *
 * They assert on what the logger was called with rather than that it ran,
 * because the log line is the entire operator-visible signal that a database
 * is holding a role no build understands. That signal not existing is how
 * the original defect survived a whole rename cycle.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import * as logger from "../middleware/logger.js";
import { storedRole } from "./stored-role.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("storedRole", () => {
  it("passes every recognized role through untouched and says nothing", () => {
    const spy = vi.spyOn(logger, "log").mockReturnValue(undefined);
    for (const role of ["admin", "space_admin", "member"] as const) {
      expect(storedRole(role, { table: "users", id: "u1" })).toBe(role);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("narrows a retired role to the least authority rather than translating it", () => {
    vi.spyOn(logger, "log").mockReturnValue(undefined);
    // The value both live databases held. Mapping it forward to
    // `space_admin` here would be a compatibility shim that keeps a
    // migration from ever being noticed as missing.
    expect(storedRole("tenant_admin", { table: "users", id: "u1" })).toBe(
      "member",
    );
  });

  it("narrows anything that is not a string at all", () => {
    vi.spyOn(logger, "log").mockReturnValue(undefined);
    for (const value of [undefined, null, 0, {}, [], true]) {
      expect(storedRole(value, { table: "api_keys", id: "k1" })).toBe("member");
    }
  });

  it("names the row so the log line is actionable on its own", () => {
    const spy = vi.spyOn(logger, "log").mockReturnValue(undefined);
    storedRole("tenant_admin", { table: "users", id: "user-42" });
    expect(spy).toHaveBeenCalledTimes(1);
    const [, , payload] = spy.mock.calls[0]!;
    expect(payload).toMatchObject({
      table: "users",
      row_id: "user-42",
      stored_role: "tenant_admin",
      projected_as: "member",
    });
  });

  it("reports a bad user role as an error and a bad credential role as a warning", () => {
    const spy = vi.spyOn(logger, "log").mockReturnValue(undefined);
    storedRole("tenant_admin", { table: "users", id: "u1" });
    storedRole("tenant_admin", { table: "api_keys", id: "k1" });
    // No route writes `users.role`, so a value outside the union there means
    // a migration did not run. A credential is minted from validated input,
    // so the same value is worth seeing without claiming data corruption.
    expect(spy.mock.calls.map((c) => c[0])).toEqual(["error", "warn"]);
  });

  it("reports the type rather than the value when the value is not a string", () => {
    // A non-string in this column is a shape problem, and echoing an
    // arbitrary object into a log line is how unbounded values reach a log
    // pipeline. The type is what the reader needs.
    const spy = vi.spyOn(logger, "log").mockReturnValue(undefined);
    storedRole({ nested: "object" }, { table: "users", id: "u1" });
    const [, , payload] = spy.mock.calls[0]!;
    expect(payload).toMatchObject({ stored_role: "object" });
  });
});
