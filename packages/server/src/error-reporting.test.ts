import { createServer } from "node:http";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { createTestContext } from "./test-utils.js";
import { readEffectiveConfig } from "./effective-config.js";
import { writeInstanceConfig } from "./storage/instance-config.js";
import {
  bindErrorReporting,
  errorReportingEnabled,
} from "./error-reporting.js";
import { createErrorHandler } from "./middleware/error-handler.js";
import type { AppEnv } from "./middleware/auth.js";

it("gates alerts and exceptions on the durable choice, including clearing and unavailable settings", async () => {
  expect(await errorReportingEnabled()).toBe(false);
  let alerts = 0;
  const receiver = createServer((_req, res) => {
    alerts++;
    res.writeHead(200).end();
  });
  await new Promise<void>((resolve) =>
    receiver.listen(0, "127.0.0.1", resolve),
  );
  const address = receiver.address();
  if (!address || typeof address === "string") throw new Error("No listener");
  const ctx = await createTestContext({
    errorWebhookUrl: `http://127.0.0.1:${String(address.port)}/secret`,
    errorReportingEnabled: false,
  });
  const prior = globalThis.__marfaReportException;
  const exceptions = vi.fn();
  globalThis.__marfaReportException = exceptions;
  bindErrorReporting(ctx.storage.settings, ctx.config);
  try {
    const app = new Hono<AppEnv>();
    app.onError(
      createErrorHandler({
        errorWebhookUrl: ctx.config.errorWebhookUrl,
        reportingEnabled: async () =>
          (await readEffectiveConfig(ctx.storage.settings, ctx.config))
            .error_reporting_enabled,
      }),
    );
    app.get("/*", () => {
      throw new Error("A test fault");
    });
    expect(await errorReportingEnabled()).toBe(false);
    expect((await app.request("/before")).status).toBe(500);
    await writeInstanceConfig(ctx.storage.settings, {
      error_reporting_enabled: true,
    });
    expect(await errorReportingEnabled()).toBe(true);
    expect((await app.request("/enabled")).status).toBe(500);
    await vi.waitFor(() => {
      expect(alerts).toBe(1);
    });
    expect(exceptions).toHaveBeenCalledTimes(1);
    await writeInstanceConfig(ctx.storage.settings, {
      error_reporting_enabled: false,
    });
    await app.request("/disabled");
    expect(exceptions).toHaveBeenCalledTimes(1);
    expect(alerts).toBe(1);
    await writeInstanceConfig(ctx.storage.settings, {});
    expect(await errorReportingEnabled()).toBe(false);
    await app.request("/default");
    expect(exceptions).toHaveBeenCalledTimes(1);
    const read = vi
      .spyOn(ctx.storage.settings, "get")
      .mockRejectedValueOnce(new Error("Unavailable"));
    expect(await errorReportingEnabled()).toBe(false);
    read.mockRestore();
  } finally {
    globalThis.__marfaReportException = prior;
    await ctx.cleanup();
    await new Promise<void>((resolve, reject) =>
      receiver.close((err) => {
        if (err) reject(err);
        else resolve();
      }),
    );
  }
});
