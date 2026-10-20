import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SETTING_NAMES, loadConfig } from "../config.js";
import { pageLinks, visibleText } from "../pages/reading.js";
import { writeInstanceConfig } from "../storage/instance-config.js";
import { createTestContext, type TestContext } from "../test-utils.js";

const SECRET = "sentinel-credential-value-0123456789";

let ctx: TestContext;

beforeAll(async () => {
  const config = loadConfig({
    MARFA_POSTHOG_PROJECT_TOKEN: SECRET,
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.test",
    MARFA_POSTHOG_HOST: "https://posthog.example.test",
    S3_ACCESS_KEY_ID: SECRET,
    S3_BUCKET: "witness-bucket",
  });
  ctx = await createTestContext({ settingReadings: config.settingReadings });
});

afterAll(async () => {
  await ctx.cleanup();
});

async function page(path: string): Promise<{ status: number; html: string }> {
  const res = await ctx.ownerRequest(path, {
    headers: { accept: "text/html" },
  });
  return { status: res.status, html: await res.text() };
}

interface Entry {
  name: string;
  group: string;
  secret: boolean;
  live: boolean;
  set: boolean;
  value?: string;
}

async function settings(): Promise<Entry[]> {
  const res = await ctx.ownerRequest("/auth/owner/settings.json");
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Entry[] }).data;
}

describe("All settings", () => {
  it("lists every setting with its group, and gives a secret's state but never its value", async () => {
    const entries = await settings();
    expect(entries.map((e) => e.name)).toEqual(
      expect.arrayContaining([...SETTING_NAMES]),
    );
    expect(entries).toHaveLength(SETTING_NAMES.length);
    const named = (name: string) => entries.find((e) => e.name === name);
    // The witness: a setting that is not a secret shows its value.
    expect(named("S3_BUCKET")).toMatchObject({
      set: true,
      value: "witness-bucket",
    });
    expect(named("S3_ACCESS_KEY_ID")).toMatchObject({
      secret: true,
      set: true,
    });
    expect(named("S3_ACCESS_KEY_ID")).not.toHaveProperty("value");

    const everything = [
      JSON.stringify(entries),
      (await page("/auth/owner/settings")).html,
      (await page("/")).html,
      (await page("/?q=token")).html,
    ];
    for (const group of new Set(entries.map((e) => e.group)))
      everything.push((await page(`/auth/owner/settings/${slug(group)}`)).html);
    for (const text of everything) expect(text).not.toContain(SECRET);
  });

  it("shows a secret as Set and a value in words, in the group it belongs to", async () => {
    const { status, html } = await page(
      "/auth/owner/settings/alerts-and-monitoring",
    );
    expect(status).toBe(200);
    expect(visibleText(html)).toMatch(
      /PostHog project token[^.]*\.? ?MARFA_POSTHOG_PROJECT_TOKEN Set/,
    );
    const files = visibleText(
      (await page("/auth/owner/settings/file-storage")).html,
    );
    expect(files).toContain("witness-bucket");
  });

  it("shows what a retention setting is changed to, and says it is live", async () => {
    await writeInstanceConfig(ctx.storage.settings, {
      audit_retention_days: 12,
    });
    const entry = (await settings()).find(
      (e) => e.name === "AUDIT_RETENTION_DAYS",
    );
    expect(entry).toMatchObject({ live: true, set: true, value: "12 days" });
  });

  it("finds a setting from Home's search and refuses a group that does not exist", async () => {
    const found = await page("/?q=heartbeat");
    expect(pageLinks(found.html).map((l) => l.href)).toContain(
      "/auth/owner/settings/alerts-and-monitoring#MARFA_HEARTBEAT_URL",
    );
    expect((await page("/auth/owner/settings/no-such-group")).status).toBe(404);
  });

  it("is the owner's alone", async () => {
    const res = await ctx.app.request("/auth/owner/settings.json");
    expect([401, 403]).toContain(res.status);
  });
});

const slug = (group: string): string =>
  group
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

describe("Activity", () => {
  beforeAll(async () => {
    for (let i = 1; i <= 12; i += 1)
      await ctx.storage.audit.log({
        action: "item.create",
        resource_type: "item",
        resource_id: `act-${String(i).padStart(2, "0")}`,
      });
    await ctx.storage.audit.log({
      action: "webhook.create",
      resource_type: "webhook",
      resource_id: "act-hook",
      client_ip: "203.0.113.7",
    });
  });

  it("lists the newest first, ten to a page, and carries on to the next", async () => {
    const first = visibleText((await page("/auth/owner/activity?q=act-")).html);
    expect(first.indexOf("act-hook")).toBeGreaterThan(-1);
    expect(first.indexOf("act-hook")).toBeLessThan(first.indexOf("act-12"));
    expect(first).toContain("act-04");
    expect(first).not.toContain("act-03");
    const second = visibleText(
      (await page("/auth/owner/activity?q=act-&page=2")).html,
    );
    expect(second).toContain("act-03");
    expect(second).not.toContain("act-04");
    const bigger = visibleText(
      (await page("/auth/owner/activity?q=act-&size=25")).html,
    );
    expect(bigger).toContain("act-01");
  });

  it("filters by kind and searches, and goes back to the first page from one past the end", async () => {
    const settingsOnly = visibleText(
      (await page("/auth/owner/activity?kind=settings&q=act-")).html,
    );
    expect(settingsOnly).toContain("act-hook");
    expect(settingsOnly).toContain("203.0.113.7");
    expect(settingsOnly).not.toContain("act-12");
    const none = visibleText(
      (await page("/auth/owner/activity?q=nothing-like-this")).html,
    );
    expect(none).toContain("No activity matches");
    const past = await ctx.ownerRequest("/auth/owner/activity?q=act-&page=40", {
      headers: { accept: "text/html" },
      redirect: "manual",
    });
    expect(past.status).toBe(302);
    expect(past.headers.get("location")).toBe("/auth/owner/activity?q=act-");
  });
});
