import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pageFields, visibleText } from "../pages/reading.js";
import { createTestContext, type TestContext } from "../test-utils.js";
import { sizeWords } from "./export-routes.js";

describe("sizeWords", () => {
  it("uses decimal units and one decimal only below ten", () => {
    expect(sizeWords(0)).toBe("0 bytes");
    expect(sizeWords(850_000)).toBe("850 KB");
    expect(sizeWords(3_400_000)).toBe("3.4 MB");
    expect(sizeWords(12_000_000)).toBe("12 MB");
    expect(sizeWords(2_000_000_000)).toBe("2 GB");
  });
});

describe("the Export and restore page", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.cleanup();
  });

  it("offers every type and says how many files an archive would carry", async () => {
    const res = await ctx.app.request("/auth/owner/export", {
      headers: { accept: "text/html", cookie: ctx.owner.cookie },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    const text = visibleText(html);
    expect(text).toContain("Export and restore");
    expect(text).toContain("No files");
    const type = pageFields(html).find((field) => field.name === "type");
    expect(type).toBeDefined();
    expect(html).toContain("Everything");
    expect(html).toContain('value="core.note"');
    // Witness: an undeclared query key is refused, not ignored.
    const extra = await ctx.app.request("/auth/owner/export?nope=1", {
      headers: { accept: "text/html", cookie: ctx.owner.cookie },
    });
    expect(extra.status).toBe(400);
  });
});
