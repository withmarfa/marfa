import { afterEach, expect, it } from "vitest";
import { createTestContext, request, type TestContext } from "../test-utils.js";

let ctx: TestContext | undefined;
afterEach(async () => {
  await ctx?.cleanup();
});

it("persists live choices, preserves omitted fields, clears to defaults and refuses invalid effective policy", async () => {
  ctx = await createTestContext({
    versionRecentDays: 30,
    versionDailySnapshotDays: 90,
  });
  const update = (body: unknown) =>
    request(ctx!.app, "PATCH", "/config", { key: ctx!.workingKey, body });
  const chosen = {
    version_recent_days: 60,
    version_daily_snapshot_days: 120,
    version_weekly_snapshot_days: 365,
    version_max_versions: 20,
    grant_inactivity_days: 0,
    enrichment_enabled: false,
    enrichment_ocr_enabled: false,
    error_reporting_enabled: false,
    heartbeat_enabled: false,
  };
  const set = await update(chosen);
  expect(set.status).toBe(200);
  expect(await set.json()).toMatchObject(chosen);
  expect((await update({ enrichment_enabled: true })).status).toBe(200);
  const invalid = await update({ version_daily_snapshot_days: 10 });
  expect(invalid.status).toBe(400);
  const clear = await update({ version_recent_days: null });
  expect(clear.status).toBe(200);
  const body = await clear.json();
  expect(body).not.toHaveProperty("version_recent_days");
  const remaining: Record<string, unknown> = { ...chosen };
  delete remaining.version_recent_days;
  expect(body).toMatchObject({ ...remaining, enrichment_enabled: true });
});

it("refuses enabled reporting without a configured receiver and unknown or mistyped choices", async () => {
  ctx = await createTestContext();
  for (const body of [
    { heartbeat_enabled: true },
    { error_reporting_enabled: true },
    { enrichment_enabled: "true" },
    { version_max_versions: 0 },
  ]) {
    const res = await request(ctx.app, "PATCH", "/config", {
      key: ctx.workingKey,
      body,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: "validation_error" },
    });
  }
});

it("keeps unrelated changes possible after a configured receiver is removed", async () => {
  const { writeInstanceConfig } = await import("../storage/instance-config.js");
  const { readEffectiveConfig } = await import("../effective-config.js");
  ctx = await createTestContext();
  await writeInstanceConfig(ctx.storage.settings, {
    heartbeat_enabled: true,
    error_reporting_enabled: true,
  });
  const changed = await request(ctx.app, "PATCH", "/config", {
    key: ctx.workingKey,
    body: { enrichment_enabled: false },
  });
  expect(changed.status).toBe(200);
  expect(await changed.json()).toMatchObject({
    heartbeat_enabled: true,
    enrichment_enabled: false,
  });
  expect(
    await readEffectiveConfig(ctx.storage.settings, ctx.config),
  ).toMatchObject({ heartbeat_enabled: false, error_reporting_enabled: false });
});
