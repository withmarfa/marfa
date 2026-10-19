import { afterEach, describe, expect, it } from "vitest";
import { PERMISSIONS } from "@withmarfa/shared";
import { createTestContext, type TestContext } from "../test-utils.js";
import { decodeEntities, visibleText } from "../test-html.js";
import {
  DESTRUCTIVE_PERMISSIONS,
  PERMISSION_LABELS,
  PERMISSION_NOTES,
  permissionDescription,
} from "./permission-labels.js";

let ctx: TestContext | undefined;
afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

/** What GLOSSARY.md says each permission permits, as the verbs a label must carry. */
const MUST_SAY: Record<(typeof PERMISSIONS)[number], RegExp[]> = {
  "keys.mint": [/make/i, /see/i, /edit/i, /revoke/i],
  "keys.manage": [/see/i, /edit/i, /narrow/i, /revoke/i, /every key/i],
  "grants.manage": [/see/i, /disconnect/i, /apps/i],
  "config.manage": [/see/i, /change/i, /settings/i],
  "instance.read": [/health/i, /metrics/i, /status/i],
  "instance.maintain": [/housekeeping/i, /reset/i, /bulk jobs/i],
  "schema.write": [/replace/i, /remove/i, /type definitions/i],
  "blobs.manage": [/read/i, /add/i, /file/i, /storage/i],
  "webhooks.manage": [/manage/i, /webhooks/i],
  "connectors.manage": [/see/i, /manage/i, /remove/i, /connectors/i],
  "audit.read": [/read/i, /log/i],
  "items.purge": [/delete/i, /trash/i, /for good/i],
};

describe("permission labels", () => {
  it("names every permission, and says each power in full", () => {
    expect(Object.keys(MUST_SAY).sort()).toEqual([...PERMISSIONS].sort());
    for (const permission of PERMISSIONS)
      for (const word of MUST_SAY[permission])
        expect(PERMISSION_LABELS[permission], permission).toMatch(word);
  });

  it("reads the same whoever holds the permission, so says nothing of 'it'", () => {
    for (const permission of PERMISSIONS) {
      const text = permissionDescription(permission) ?? "";
      expect(PERMISSION_LABELS[permission], permission).not.toMatch(
        /\b(it|its)\b/i,
      );
      expect(text, permission).not.toMatch(/\b(it|its)\b/i);
    }
  });

  it("keeps a label to a few words", () => {
    for (const permission of PERMISSIONS)
      expect(
        PERMISSION_LABELS[permission].split(/\s+/).length,
        permission,
      ).toBeLessThanOrEqual(10);
  });

  it("describes a destructive permission as unable to be undone, and no other", () => {
    for (const permission of PERMISSIONS)
      expect(
        /can't be undone/i.test(permissionDescription(permission) ?? ""),
        permission,
      ).toBe(DESTRUCTIVE_PERMISSIONS.has(permission));
  });

  it("adds the note to the description where there is one", () => {
    for (const permission of PERMISSIONS) {
      const note = PERMISSION_NOTES[permission];
      if (note) expect(permissionDescription(permission)).toContain(note);
    }
  });
});

describe("the key form on the Manage page", () => {
  it("shows each permission as the approval pages do, with its note and its mark", async () => {
    ctx = await createTestContext({});
    const res = await ctx.ownerRequest("/auth/owner/manage");
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const permission of PERMISSIONS) {
      const row = new RegExp(
        `<label><input[^>]*value="${permission}"[^>]*>([\\s\\S]*?)</label>`,
      ).exec(html);
      expect(row, permission).not.toBeNull();
      const text = visibleText(decodeEntities(row?.[1] ?? ""));
      expect(text, permission).toBe(
        [PERMISSION_LABELS[permission], permissionDescription(permission)]
          .filter(Boolean)
          .join(" "),
      );
    }
  });
});
