import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { createTestContext, request, type TestContext } from "../test-utils.js";
import { readEffectiveConfig } from "../effective-config.js";
import { Housekeeping } from "./scheduler.js";
import { registerHousekeepingJobs } from "./registrations.js";

let ctx: TestContext | undefined;
let scheduler: Housekeeping | undefined;
afterEach(async () => {
  await scheduler?.stop();
  await ctx?.cleanup();
});

async function seedImage(context: TestContext, type: string): Promise<string> {
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=",
    "base64",
  );
  const upload = await context.app.request("/blobs", {
    method: "POST",
    headers: {
      authorization: `Bearer ${context.workingKey}`,
      "content-type": "image/png",
    },
    body: bytes,
  });
  expect(upload.status).toBe(201);
  const created = await request(context.app, "POST", "/items", {
    key: context.workingKey,
    body: {
      type,
      properties: {
        blob_ref: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        mime_type: "image/png",
      },
    },
  });
  expect(created.status).toBe(201);
  return ((await created.json()) as { item: { id: string } }).item.id;
}

it("starts initially disabled work, stops future work, restores defaults and recovers after a failed heartbeat", async () => {
  let pings = 0;
  let status = 503;
  const receiver = createServer((_req, res) => {
    pings++;
    res.writeHead(status).end();
  });
  await new Promise<void>((resolve) =>
    receiver.listen(0, "127.0.0.1", resolve),
  );
  try {
    const address = receiver.address();
    if (!address || typeof address === "string") throw new Error("No listener");
    ctx = await createTestContext({
      enrichmentEnabled: false,
      enrichmentOcrEnabled: false,
      heartbeatEnabled: false,
      heartbeatUrl: `http://127.0.0.1:${String(address.port)}/secret-receiver`,
      grantInactivityDays: 0,
    });
    const update = async (body: object) => {
      const res = await request(ctx!.app, "PATCH", "/config", {
        key: ctx!.workingKey,
        body,
      });
      expect(res.status, await res.clone().text()).toBe(200);
    };
    scheduler = new Housekeeping(ctx.storage.housekeeping, {
      pollIntervalMs: 3_600_000,
    });
    registerHousekeepingJobs(scheduler, ctx.storage, ctx.blobs, ctx.config);
    await scheduler.start();
    await scheduler.settle();
    expect(scheduler.names()).toContain("grant-inactivity-retirement");
    const seed = async (text: string) => {
      const bytes = Buffer.from(text);
      const blob = await ctx!.app.request("/blobs", {
        method: "POST",
        headers: {
          authorization: `Bearer ${ctx!.workingKey}`,
          "content-type": "text/plain",
        },
        body: bytes,
      });
      expect(blob.status).toBe(201);
      const created = await request(ctx!.app, "POST", "/items", {
        key: ctx!.workingKey,
        body: {
          type: "core.file",
          properties: {
            blob_ref: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
            mime_type: "text/plain",
          },
        },
      });
      expect(created.status).toBe(201);
      return ((await created.json()) as { item: { id: string } }).item.id;
    };
    const first = await seed("First readable file");
    await scheduler.runNow("enrichment-sweep");
    expect(
      (await ctx.storage.items.get(first))?.properties.extracted_text,
    ).toBeUndefined();
    expect(pings).toBe(0);
    await update({ enrichment_enabled: true, heartbeat_enabled: true });
    await scheduler.runNow("enrichment-sweep");
    expect(
      (await ctx.storage.items.get(first))?.properties.extracted_text,
    ).toBe("First readable file");
    await scheduler.runNow("heartbeat");
    expect(pings).toBe(1);
    status = 200;
    await scheduler.runNow("heartbeat");
    expect(pings).toBe(2);
    const second = await seed("Second readable file");
    await update({ enrichment_enabled: false, heartbeat_enabled: false });
    await scheduler.runNow("enrichment-sweep");
    await scheduler.runNow("heartbeat");
    expect(pings).toBe(2);
    expect(
      (await ctx.storage.items.get(second))?.properties.extracted_text,
    ).toBeUndefined();
    await update({ enrichment_enabled: null, heartbeat_enabled: null });
    expect(
      await readEffectiveConfig(ctx.storage.settings, ctx.config),
    ).toMatchObject({ enrichment_enabled: false, heartbeat_enabled: false });
    await update({ enrichment_enabled: true });
    await scheduler.runNow("enrichment-sweep");
    expect(
      (await ctx.storage.items.get(second))?.properties.extracted_text,
    ).toBe("Second readable file");
  } finally {
    await new Promise<void>((resolve, reject) =>
      receiver.close((err) => {
        if (err) reject(err);
        else resolve();
      }),
    );
  }
});

it.each(["core.file", "core.file.image"])(
  "reconsiders %s after OCR is enabled without repeating finished work",
  async (type) => {
    const { TesseractOcr } = await import("../enrichment/ocr.js");
    const { vi } = await import("vitest");
    // The OCR seam avoids downloading a language model in a unit run.
    const recognize = vi
      .spyOn(TesseractOcr.prototype, "recognize")
      .mockResolvedValue("Readable image");
    try {
      ctx = await createTestContext({
        enrichmentEnabled: true,
        enrichmentOcrEnabled: false,
      });
      scheduler = new Housekeeping(ctx.storage.housekeeping, {
        pollIntervalMs: 3_600_000,
      });
      registerHousekeepingJobs(scheduler, ctx.storage, ctx.blobs, ctx.config);
      await scheduler.start();
      const id = await seedImage(ctx, type);
      await scheduler.runNow("enrichment-sweep");
      expect(recognize).not.toHaveBeenCalled();
      const parked = await ctx.storage.enrichment.get(id);
      const dimensions =
        type === "core.file.image" ? { width: 1, height: 1 } : {};
      expect((await ctx.storage.items.get(id))?.properties).toMatchObject(
        dimensions,
      );
      await scheduler.runNow("enrichment-sweep");
      expect(await ctx.storage.enrichment.get(id)).toEqual(parked);
      const enabled = await request(ctx.app, "PATCH", "/config", {
        key: ctx.workingKey,
        body: { enrichment_ocr_enabled: true },
      });
      expect(enabled.status).toBe(200);
      await scheduler.runNow("enrichment-sweep");
      expect(recognize).toHaveBeenCalledOnce();
      expect((await ctx.storage.items.get(id))?.properties).toMatchObject(
        dimensions,
      );
      expect((await ctx.storage.items.get(id))?.properties.extracted_text).toBe(
        "Readable image",
      );
      for (const choice of [false, null, true]) {
        expect(
          (
            await request(ctx.app, "PATCH", "/config", {
              key: ctx.workingKey,
              body: { enrichment_ocr_enabled: choice },
            })
          ).status,
        ).toBe(200);
        await scheduler.runNow("enrichment-sweep");
        expect(recognize).toHaveBeenCalledOnce();
        expect(
          (await ctx.storage.items.get(id))?.properties.extracted_text,
        ).toBe("Readable image");
      }
    } finally {
      recognize.mockRestore();
    }
  },
);

it.each(["enrichment_enabled", "enrichment_ocr_enabled"])(
  "checks %s before starting the next queued image",
  async (field) => {
    const { TesseractOcr } = await import("../enrichment/ocr.js");
    const { vi } = await import("vitest");
    // The OCR seam avoids downloading a language model in a unit run.
    const recognize = vi
      .spyOn(TesseractOcr.prototype, "recognize")
      .mockImplementation(async () => {
        expect(
          (
            await request(ctx!.app, "PATCH", "/config", {
              key: ctx!.workingKey,
              body: { [field]: false },
            })
          ).status,
        ).toBe(200);
        return "Readable image";
      });
    try {
      ctx = await createTestContext({
        enrichmentEnabled: true,
        enrichmentOcrEnabled: true,
      });
      scheduler = new Housekeeping(ctx.storage.housekeeping, {
        pollIntervalMs: 3_600_000,
      });
      registerHousekeepingJobs(scheduler, ctx.storage, ctx.blobs, ctx.config);
      await scheduler.start();
      const id = await seedImage(ctx, "core.file.image");
      const secondId = await seedImage(ctx, "core.file.image");
      await scheduler.runNow("enrichment-sweep");
      expect(recognize).toHaveBeenCalledOnce();
      expect((await ctx.storage.items.get(id))?.properties.extracted_text).toBe(
        "Readable image",
      );
      expect(
        (await ctx.storage.items.get(secondId))?.properties.extracted_text,
      ).toBeUndefined();
      recognize.mockResolvedValue("Second image");
      expect(
        (
          await request(ctx.app, "PATCH", "/config", {
            key: ctx.workingKey,
            body: { [field]: null },
          })
        ).status,
      ).toBe(200);
      await scheduler.runNow("enrichment-sweep");
      expect(recognize).toHaveBeenCalledTimes(2);
      expect(
        (await ctx.storage.items.get(secondId))?.properties.extracted_text,
      ).toBe("Second image");
      expect((await ctx.storage.items.get(id))?.properties.extracted_text).toBe(
        "Readable image",
      );
    } finally {
      recognize.mockRestore();
    }
  },
);

it("refuses a version sweep when changed environment defaults conflict with overrides and recovers after correction", async () => {
  const { writeInstanceConfig } = await import("../storage/instance-config.js");
  ctx = await createTestContext({
    versionRecentDays: 30,
    versionDailySnapshotDays: 90,
  });
  const created = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.note", properties: { body: "Policy witness" } },
  });
  expect(created.status).toBe(201);
  const id = ((await created.json()) as { item: { id: string } }).item.id;
  for (let version = 1; version <= 3; version++) {
    const changed = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.workingKey,
      body: { version, properties: { body: `Version ${String(version)}` } },
    });
    expect(changed.status).toBe(200);
  }
  await writeInstanceConfig(ctx.storage.settings, { version_recent_days: 120 });
  scheduler = new Housekeeping(ctx.storage.housekeeping, {
    pollIntervalMs: 3_600_000,
  });
  registerHousekeepingJobs(scheduler, ctx.storage, ctx.blobs, ctx.config);
  await scheduler.start();
  expect(await scheduler.runNow("version-thinning")).toMatchObject({
    kind: "ran",
    run: { outcome: "error" },
  });
  const fixed = await request(ctx.app, "PATCH", "/config", {
    key: ctx.workingKey,
    body: { version_daily_snapshot_days: 180 },
  });
  expect(fixed.status).toBe(200);
  expect(await scheduler.runNow("version-thinning")).toMatchObject({
    kind: "ran",
    run: { outcome: "ok" },
  });
});
