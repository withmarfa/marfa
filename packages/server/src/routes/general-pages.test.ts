import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  pageButtons,
  pageField,
  pageRegions,
  visibleText,
} from "../pages/reading.js";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { readInstanceConfig } from "../storage/instance-config.js";
import { generalName, keepingRows } from "./general-routes.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext({});
});

afterAll(async () => {
  await ctx.cleanup();
});

async function html(path: string): Promise<string> {
  const res = await ctx.ownerRequest(path, {
    headers: { accept: "text/html" },
  });
  expect(res.status).toBe(200);
  return res.text();
}

async function configure(body: Record<string, unknown>): Promise<void> {
  const res = await ctx.ownerRequest("/config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
}

/** The option a select shows as chosen. */
function chosen(page: string, name: string): string | undefined {
  const select = new RegExp(
    `<select\\b[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`,
  ).exec(page);
  return /<option value="([^"]*)" selected/.exec(select?.[1] ?? "")?.[1];
}

describe("the General page", () => {
  it("shows the name and each setting at the value the server uses now", async () => {
    const before = await html("/auth/owner/general");
    expect(pageField(before, "name")?.value).toBe(
      generalName(await readInstanceConfig(ctx.storage.settings)),
    );
    const standing = Object.fromEntries(
      keepingRows(ctx.config, null).map((row) => [row.field, row.value]),
    );
    for (const [field, value] of Object.entries(standing))
      expect(chosen(before, field)).toBe(value);

    // Witness: what is saved through the API is what the page then shows,
    // including a value no preset offers.
    await configure({ name: "Home Marfa", trash_retention_days: 45 });
    const after = await html("/auth/owner/general");
    expect(pageField(after, "name")?.value).toBe("Home Marfa");
    expect(chosen(after, "trash_retention_days")).toBe("45");
    expect(after).toContain('<option value="45"');
    expect(chosen(after, "audit_retention_days")).toBe(
      standing.audit_retention_days,
    );
  });

  it("keeps the save bar hidden until a change, and says which rules are on", async () => {
    await configure({ enforcement: { strict_mode: { types: ["core.note"] } } });
    const page = await html("/auth/owner/general");
    expect(
      pageRegions(page).find((region) => region.label === "Unsaved changes"),
    ).toMatchObject({ hidden: true });
    expect(
      pageButtons(page).find((button) => button.text === "Save")?.form,
    ).toBe("general-form");
    const text = visibleText(page);
    expect(text).toContain("On for 1 type");
    expect(text).toContain("Off for every type");
  });

  it("gives Home the name as its value", async () => {
    await configure({ name: "Study Marfa" });
    expect(visibleText(await html("/"))).toContain("Study Marfa");
  });
});
