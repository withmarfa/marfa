import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

/**
 * Wave C PR1 — email suppression list store.
 *
 * Runs against whichever dialect the test process targets (SQLite by
 * default, Postgres when STORAGE_DIALECT=pg). The cross-dialect parity
 * is what we're proving — same input, same observable output.
 */
describe("EmailSuppressionsStore", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it("returns null for an unsuppressed address", async () => {
    const suppressions = ctx.storage.emailSuppressions;
    expect(suppressions).toBeDefined();
    if (!suppressions) return;
    const result = await suppressions.isSuppressed("", "test@example.com");
    expect(result).toBeNull();
  });

  it("upsert + isSuppressed round-trip", async () => {
    const suppressions = ctx.storage.emailSuppressions;
    if (!suppressions) return;
    await suppressions.upsert({
      tenantId: "",
      email: "bounced@resend.dev",
      reason: "hard_bounce",
      sourceEmailId: "msg-123",
    });
    const result = await suppressions.isSuppressed("", "bounced@resend.dev");
    expect(result).not.toBeNull();
    expect(result?.email).toBe("bounced@resend.dev");
    expect(result?.reason).toBe("hard_bounce");
    expect(result?.source_email_id).toBe("msg-123");
    expect(result?.tenant_id).toBe("");
  });

  it("normalises email to lowercase on lookup and upsert", async () => {
    const suppressions = ctx.storage.emailSuppressions;
    if (!suppressions) return;
    await suppressions.upsert({
      tenantId: "",
      email: "User@Example.COM",
      reason: "complaint",
    });
    // Lookup with mixed case still hits the row.
    const result = await suppressions.isSuppressed("", "USER@example.com");
    expect(result).not.toBeNull();
    expect(result?.email).toBe("user@example.com");
  });

  it("upsert refreshes reason on duplicate (tenant_id, email)", async () => {
    const suppressions = ctx.storage.emailSuppressions;
    if (!suppressions) return;
    await suppressions.upsert({
      tenantId: "",
      email: "test@example.com",
      reason: "hard_bounce",
    });
    await suppressions.upsert({
      tenantId: "",
      email: "test@example.com",
      reason: "complaint",
    });
    const result = await suppressions.isSuppressed("", "test@example.com");
    expect(result?.reason).toBe("complaint");
  });

  it("scopes by tenant_id — same email in two tenants are independent", async () => {
    const suppressions = ctx.storage.emailSuppressions;
    if (!suppressions) return;
    await suppressions.upsert({
      tenantId: "tenant-a",
      email: "shared@example.com",
      reason: "hard_bounce",
    });
    // Tenant B has no suppression for the same address.
    const tenantBResult = await suppressions.isSuppressed(
      "tenant-b",
      "shared@example.com",
    );
    expect(tenantBResult).toBeNull();
    // Tenant A does.
    const tenantAResult = await suppressions.isSuppressed(
      "tenant-a",
      "shared@example.com",
    );
    expect(tenantAResult).not.toBeNull();
  });

  it("list returns only the tenant's own suppressions", async () => {
    const suppressions = ctx.storage.emailSuppressions;
    if (!suppressions) return;
    await suppressions.upsert({
      tenantId: "tenant-a",
      email: "a1@example.com",
      reason: "hard_bounce",
    });
    await suppressions.upsert({
      tenantId: "tenant-a",
      email: "a2@example.com",
      reason: "complaint",
    });
    await suppressions.upsert({
      tenantId: "tenant-b",
      email: "b1@example.com",
      reason: "hard_bounce",
    });
    const aList = await suppressions.list("tenant-a");
    expect(aList).toHaveLength(2);
    expect(aList.map((r) => r.email).sort()).toEqual([
      "a1@example.com",
      "a2@example.com",
    ]);
  });

  it("remove drops the row; subsequent isSuppressed returns null", async () => {
    const suppressions = ctx.storage.emailSuppressions;
    if (!suppressions) return;
    await suppressions.upsert({
      tenantId: "",
      email: "remove-me@example.com",
      reason: "manual",
    });
    await suppressions.remove("", "remove-me@example.com");
    const result = await suppressions.isSuppressed("", "remove-me@example.com");
    expect(result).toBeNull();
  });
});
