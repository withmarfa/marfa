/**
 * The two audit writers, held to opposite promises, against real storage.
 *
 * There used to be one writer, documented as fire-and-forget and awaited at
 * sixteen call sites — four of them inside a `try` built to fail the
 * operation when the row did not land. None of those could ever run: the
 * writer runs under a tracker that catches everything and warns, so it
 * cannot reject. The guard read as live code and was not, and the test that
 * proved one of them stubbed a rejection the store could not produce.
 *
 * These cases produce a real failure from the real store. The lever is a
 * `details` payload that cannot be serialized; everything that then happens
 * is the store's own.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import type { AuditLogEntry } from "./interface.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

/** An entry the store cannot write, because `details` will not serialize. */
function unwritableEntry(action: string): AuditLogEntry {
  return {
    action,
    resource_type: "item",
    resource_id: "itm_audit_contract",
    // A BigInt has no JSON representation, so the store's own
    // `JSON.stringify` of the details blob throws. Nothing here is stubbed:
    // the rejection comes from the write path the pipelines use.
    details: { attempts: 1n },
  };
}

describe("audit.log — fire-and-forget", () => {
  it("does not reject when the write genuinely fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(
        ctx.storage.audit.log(unwritableEntry("test.audit.swallowed")),
      ).resolves.toBeUndefined();
      // Swallowed, not silent: the tracker logs it. A caller cannot see the
      // failure, so the log line is the only place it exists.
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("writes nothing when it fails, so nothing reads as audited", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await ctx.storage.audit.log(unwritableEntry("test.audit.no_row"));
    } finally {
      warn.mockRestore();
    }
    const rows = await ctx.storage.audit.list({
      action: "test.audit.no_row",
      limit: 5,
    });
    expect(rows.data).toHaveLength(0);
  });
});

describe("audit.logOrThrow — propagating", () => {
  it("rejects when the write fails", async () => {
    await expect(
      ctx.storage.audit.logOrThrow(unwritableEntry("test.audit.propagated")),
    ).rejects.toThrow();
  });

  it("writes the row on the ordinary path", async () => {
    await ctx.storage.audit.logOrThrow({
      action: "test.audit.written",
      resource_type: "item",
      resource_id: "itm_audit_contract_ok",
      client_ip: "203.0.113.7",
      details: { reason: "contract" },
    });

    const rows = await ctx.storage.audit.list({
      action: "test.audit.written",
      limit: 5,
    });
    expect(rows.data).toHaveLength(1);
    // No polling. The propagating form is awaited to completion rather than
    // tracked, which is the other half of what makes it usable inside a
    // transaction.
    expect(rows.data[0]?.client_ip).toBe("203.0.113.7");
    expect(rows.data[0]?.details.reason).toBe("contract");
  });
});

// ---------------------------------------------------------------------------
// Which writer each propagating call site takes.
//
// Swapping one back to `log` compiles, passes every route test, and silently
// removes the guarantee: the account cascade would commit a hard delete with
// no record of it, and the install would return an id for a connection
// nothing audited. Two of the three have a behavioral test; the cascade
// resolves its storage at construction and cannot be handed a failing audit
// store from a test, so the shape is what is pinned.
// ---------------------------------------------------------------------------
