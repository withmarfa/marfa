/**
 * The sources a key claims besides its own, on the two doors that write them.
 *
 * A claim is reach: a key naming a claimed source on a write lands on every
 * row another key wrote under it. So it is held to the rules the permission
 * maps keep, and every refusal here is paired with the mint or edit that
 * must still succeed, or a route refusing every claim would pass.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  seedOauthBearer,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";

let ctx: TestContext;

interface KeyBody {
  id: string;
  source: string;
  sources?: string[];
  type_permissions: Record<string, string>;
}

interface RefusalBody {
  error: { code: string; details?: { source?: string } };
}

/** A working key holding `keys.mint`, write on notes, and the claims named. */
async function seedKey(
  label: string,
  sources: string[],
): Promise<{ id: string; raw: string; source: string }> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const raw = `marfa_k1_${label}_${suffix}`;
  const source = `claims-${label}-${suffix}`;
  const stored = await ctx.storage.keys.create(
    {
      label,
      source,
      sources,
      permissions: ["keys.mint"],
      type_permissions: { "core.note": "write" },
      default_tier: "library",
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
  );
  return { id: stored.id, raw, source };
}

/** A body for `POST /keys` under a source nothing else holds. */
function mintBody(extra: Record<string, unknown> = {}) {
  const suffix = Math.random().toString(36).slice(2, 10);
  return { label: `minted-${suffix}`, source: `minted-${suffix}`, ...extra };
}

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("minting a key", () => {
  it("takes the creator's claims when the body names neither a map nor claims", async () => {
    const creator = await seedKey("inherit", ["shared-folder"]);
    const res = await request(ctx.app, "POST", "/keys", {
      key: creator.raw,
      body: mintBody(),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as KeyBody;
    expect(body.sources).toEqual(["shared-folder"]);
    expect((await ctx.storage.keys.get(body.id))?.sources).toEqual([
      "shared-folder",
    ]);
  });

  it("holds only the claims it names, and none when it names a map alone", async () => {
    const creator = await seedKey("narrow", ["shared-folder", "second"]);

    const named = await request(ctx.app, "POST", "/keys", {
      key: creator.raw,
      body: mintBody({ sources: ["second"] }),
    });
    expect(named.status).toBe(201);
    const namedBody = (await named.json()) as KeyBody;
    expect(namedBody.sources).toEqual(["second"]);
    // Naming claims names reach, so the maps are what the body named too:
    // none, rather than the creator's for free.
    expect(namedBody.type_permissions).toEqual({});

    const mapOnly = await request(ctx.app, "POST", "/keys", {
      key: creator.raw,
      body: mintBody({ type_permissions: { "core.note": "read" } }),
    });
    expect(mapOnly.status).toBe(201);
    expect(((await mapOnly.json()) as KeyBody).sources).toEqual([]);
  });

  it("stores a claim named twice once", async () => {
    const creator = await seedKey("twice", ["shared-folder"]);
    const res = await request(ctx.app, "POST", "/keys", {
      key: creator.raw,
      body: mintBody({ sources: ["shared-folder", "shared-folder"] }),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as KeyBody).sources).toEqual(["shared-folder"]);
  });

  it("refuses a claim the creator does not hold, naming the first one", async () => {
    const creator = await seedKey("ceiling", ["shared-folder"]);
    const refused = await request(ctx.app, "POST", "/keys", {
      key: creator.raw,
      body: mintBody({ sources: ["shared-folder", "elsewhere", "further"] }),
    });
    expect(refused.status).toBe(403);
    const body = (await refused.json()) as RefusalBody;
    expect(body.error.code).toBe("forbidden");
    expect(body.error.details?.source).toBe("elsewhere");

    // The control: the creator's own source and its claims are its to grant.
    const granted = await request(ctx.app, "POST", "/keys", {
      key: creator.raw,
      body: mintBody({ sources: [creator.source, "shared-folder"] }),
    });
    expect(granted.status).toBe(201);
  });

  it("refuses a key whose own source another key claims, unless its caller could grant it", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const taken = `taken-folder-${suffix}`;
    const claimer = await seedKey("taken-claimer", [taken]);
    const stranger = await seedKey("taken-stranger", []);

    const refused = await request(ctx.app, "POST", "/keys", {
      key: stranger.raw,
      body: { label: `own-taken-${suffix}`, source: taken },
    });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as RefusalBody).error.details?.source).toBe(
      taken,
    );

    // The controls: a source nobody claims is anyone's to take as its own,
    // and the claimer may take the one it claims.
    const unclaimed = await request(ctx.app, "POST", "/keys", {
      key: stranger.raw,
      body: {
        label: `own-free-${suffix}`,
        source: `free-folder-${suffix}`,
      },
    });
    expect(unclaimed.status).toBe(201);
    const granted = await request(ctx.app, "POST", "/keys", {
      key: claimer.raw,
      body: { label: `own-granted-${suffix}`, source: taken },
    });
    expect(granted.status).toBe(201);
  });

  it("trims a claim as it trims a key's own source, and refuses one left empty", async () => {
    const trimmed = await request(ctx.app, "POST", "/keys", {
      headers: {
        cookie: ctx.owner.cookie,
        origin: new URL(ctx.config.authBaseUrl).origin,
      },
      body: mintBody({ sources: ["  padded-folder  "] }),
    });
    expect(trimmed.status).toBe(201);
    expect(((await trimmed.json()) as KeyBody).sources).toEqual([
      "padded-folder",
    ]);

    const blank = await request(ctx.app, "POST", "/keys", {
      headers: {
        cookie: ctx.owner.cookie,
        origin: new URL(ctx.config.authBaseUrl).origin,
      },
      body: mintBody({ sources: ["   "] }),
    });
    expect(blank.status).toBe(400);

    // The own source is held to the same rule. Stored empty, it would read
    // as no source at all to the natural-key lookup, so a repeated create
    // under it would collide instead of upserting.
    const suffix = Math.random().toString(36).slice(2, 10);
    const padded = await request(ctx.app, "POST", "/keys", {
      headers: {
        cookie: ctx.owner.cookie,
        origin: new URL(ctx.config.authBaseUrl).origin,
      },
      body: { label: `padded-${suffix}`, source: `  padded-own-${suffix}  ` },
    });
    expect(padded.status).toBe(201);
    expect(((await padded.json()) as KeyBody).source).toBe(
      `padded-own-${suffix}`,
    );
    const emptyOwn = await request(ctx.app, "POST", "/keys", {
      headers: {
        cookie: ctx.owner.cookie,
        origin: new URL(ctx.config.authBaseUrl).origin,
      },
      body: { label: `empty-own-${suffix}`, source: "   " },
    });
    expect(emptyOwn.status).toBe(400);
  });

  it("lets the direct owner grant any source", async () => {
    const res = await request(ctx.app, "POST", "/keys", {
      headers: {
        cookie: ctx.owner.cookie,
        origin: new URL(ctx.config.authBaseUrl).origin,
      },
      body: mintBody({ sources: ["anything-at-all"] }),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as KeyBody).sources).toEqual([
      "anything-at-all",
    ]);
  });

  it("refuses a reserved prefix to every caller, the direct owner included", async () => {
    for (const reserved of ["oauth:client:person", "OAuth:client:person"]) {
      const res = await request(ctx.app, "POST", "/keys", {
        headers: {
          cookie: ctx.owner.cookie,
          origin: new URL(ctx.config.authBaseUrl).origin,
        },
        body: mintBody({ sources: [reserved] }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as RefusalBody;
      expect(body.error.code).toBe("validation_error");
      expect(body.error.details?.source).toBe(reserved);
    }
  });

  it("holds a signed-in app to what its token claims, which is nothing", async () => {
    const { token } = await seedOauthBearer(ctx, [
      "keys.mint",
      "content:write",
    ]);
    const inherited = await request(ctx.app, "POST", "/keys", {
      key: token,
      body: mintBody(),
    });
    expect(inherited.status).toBe(201);
    expect(((await inherited.json()) as KeyBody).sources).toEqual([]);

    const refused = await request(ctx.app, "POST", "/keys", {
      key: token,
      body: mintBody({ sources: ["shared-folder"] }),
    });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as RefusalBody).error.details?.source).toBe(
      "shared-folder",
    );
  });
});

describe("editing a key's claims", () => {
  it("refuses a claim the editor does not hold, and writes one it does", async () => {
    const editor = await seedKey("editor", ["shared-folder"]);
    const target = await seedKey("target", []);

    const refused = await request(ctx.app, "PATCH", `/keys/${target.id}`, {
      key: editor.raw,
      body: { sources: ["elsewhere"] },
    });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as RefusalBody).error.details?.source).toBe(
      "elsewhere",
    );
    expect((await ctx.storage.keys.get(target.id))?.sources).toEqual([]);

    const written = await request(ctx.app, "PATCH", `/keys/${target.id}`, {
      key: editor.raw,
      body: { sources: ["shared-folder"] },
    });
    expect(written.status).toBe(200);
    expect(((await written.json()) as KeyBody).sources).toEqual([
      "shared-folder",
    ]);
    expect((await ctx.storage.keys.get(target.id))?.sources).toEqual([
      "shared-folder",
    ]);
  });

  it("refuses a reserved prefix on an edit", async () => {
    const target = await seedKey("reserved-edit", []);
    const res = await request(ctx.app, "PATCH", `/keys/${target.id}`, {
      headers: {
        cookie: ctx.owner.cookie,
        origin: new URL(ctx.config.authBaseUrl).origin,
      },
      body: { sources: ["oauth:client:person"] },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as RefusalBody).error.code).toBe(
      "validation_error",
    );
  });
});
