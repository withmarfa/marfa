import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

/**
 * A conflict is resolved by the server, in the transaction that performs the
 * update, by the type's declared policy.
 *
 * What these cover is the resolution itself and the shape of the answer. The
 * detection underneath — which fields collide, and against which ancestor —
 * is `conflict.test.ts`'s and is not repeated.
 *
 * `core.note` is used throughout because its policy exercises both arms in one
 * request: `body` keeps both copies, and `title` falls through to the type's
 * `last_writer_wins` default.
 */

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

interface CreatedItem {
  item: { id: string; version: number };
}

/** A note at a known version, plus a second writer that moves it on. */
async function collidingNote(): Promise<{ id: string; base: number }> {
  const created = await request(ctx.app, "POST", "/items", {
    key: ctx.spaceKey,
    body: {
      type: "core.note",
      properties: { title: "shared title", body: "shared body" },
    },
  });
  expect(created.status).toBe(201);
  const { item } = (await created.json()) as CreatedItem;

  const winner = await request(ctx.app, "PATCH", `/items/${item.id}`, {
    key: ctx.spaceKey,
    body: {
      properties: {
        title: "title from the winner",
        body: "body from the winner",
      },
      version: item.version,
    },
  });
  expect(winner.status).toBe(200);
  return { id: item.id, base: item.version };
}

describe("the server resolves a conflict", () => {
  it("applies the type's policy to both arms in one write", async () => {
    const { id, base } = await collidingNote();

    const resolved = await request(
      ctx.app,
      "PATCH",
      `/items/${id}?conflict=auto`,
      {
        key: ctx.spaceKey,
        body: {
          properties: {
            title: "title from the loser",
            body: "body from the loser",
          },
          version: base,
        },
      },
    );
    expect(resolved.status).toBe(200);

    const read = await request(ctx.app, "GET", `/items/${id}`, {
      key: ctx.spaceKey,
    });
    const { item } = (await read.json()) as {
      item: { properties: Record<string, unknown> };
    };

    // The later writer takes a last-writer-wins field. Keeping the server's
    // value here would be first-writer-wins under a name saying otherwise,
    // and would drop an edit its author was told had landed.
    expect(item.properties.title).toBe("title from the loser");
    // And the server's value stands on a keep-both field, which is what
    // makes the sibling below the only copy of the losing text.
    expect(item.properties.body).toBe("body from the winner");
  });

  it("writes the losing text to a sibling rather than dropping it", async () => {
    const { id, base } = await collidingNote();
    // Unique to this test: the listing below is space-wide, and every case in
    // this file resolves a conflict into the same space.
    const losing = "body only this test writes";

    const resolved = await request(
      ctx.app,
      "PATCH",
      `/items/${id}?conflict=auto`,
      {
        key: ctx.spaceKey,
        body: {
          properties: { body: losing },
          version: base,
        },
      },
    );
    expect(resolved.status).toBe(200);

    const listed = await request(ctx.app, "GET", "/items?limit=200", {
      key: ctx.spaceKey,
    });
    const { data } = (await listed.json()) as {
      data: { id: string; type: string; properties: Record<string, unknown> }[];
    };
    const siblings = data.filter(
      (row) => row.id !== id && row.properties.body === losing,
    );
    expect(siblings).toHaveLength(1);
    // Same type as the row it came from, or a reader of that type never
    // sees it.
    expect(siblings[0]?.type).toBe("core.note");
  });

  it("tags the sibling so an app can find it", async () => {
    const { id, base } = await collidingNote();

    await request(ctx.app, "PATCH", `/items/${id}?conflict=auto`, {
      key: ctx.spaceKey,
      body: { properties: { body: "tagged loser" }, version: base },
    });

    const listed = await request(ctx.app, "GET", "/items?limit=200", {
      key: ctx.spaceKey,
    });
    const { data } = (await listed.json()) as {
      data: { id: string; properties: Record<string, unknown> }[];
    };
    const sibling = data.find(
      (row) => row.id !== id && row.properties.body === "tagged loser",
    );
    expect(sibling).toBeDefined();

    const meta = await request(
      ctx.app,
      "GET",
      `/items/${String(sibling?.id)}`,
      {
        key: ctx.spaceKey,
      },
    );
    const { metadata } = (await meta.json()) as {
      metadata: { tags: string[] };
    };
    expect(metadata.tags).toContain("conflicted-copy");
  });

  it("refuses without the parameter, so the default is unchanged", async () => {
    const { id, base } = await collidingNote();

    const bare = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.spaceKey,
      body: {
        properties: { body: "body from the loser" },
        version: base,
      },
    });
    // The rule is opt-in. A client that has not asked for it keeps the
    // envelope it was written against.
    expect(bare.status).toBe(409);
    const body = (await bare.json()) as { error: { code: string } };
    expect(body.error.code).toBe("version_conflict");
  });

  it("keeps the 409 envelope under manual and callback", async () => {
    for (const mode of ["manual", "callback"] as const) {
      const { id, base } = await collidingNote();
      const res = await request(
        ctx.app,
        "PATCH",
        `/items/${id}?conflict=${mode}`,
        {
          key: ctx.spaceKey,
          body: { properties: { body: `loser under ${mode}` }, version: base },
        },
      );
      expect(res.status, `${mode} should not resolve on the server`).toBe(409);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("version_conflict");
    }
  });

  it("refuses a conflict mode it does not implement", async () => {
    const { id, base } = await collidingNote();
    // A mode the server does not know is refused rather than dropped. A
    // dropped parameter reads to the caller as a resolution that happened,
    // and the losing edit is gone before anyone can see it did not.
    const res = await request(ctx.app, "PATCH", `/items/${id}?conflict=merge`, {
      key: ctx.spaceKey,
      body: { properties: { body: "never applied" }, version: base },
    });
    expect(res.status).toBe(400);
  });
});

describe("a base version that has been thinned away", () => {
  /** Create, move on twice, then thin the snapshot the write will name. */
  async function noteWithThinnedAncestor(): Promise<{
    id: string;
    base: number;
  }> {
    const created = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: { type: "core.note", properties: { body: "v1" } },
    });
    const { item } = (await created.json()) as CreatedItem;
    const base = item.version;

    for (const body of ["v2", "v3"]) {
      const res = await request(ctx.app, "PATCH", `/items/${item.id}`, {
        key: ctx.spaceKey,
        body: { properties: { body } },
      });
      expect(res.status).toBe(200);
    }

    // What the version thinner does, done directly: the snapshot for `base`
    // is gone while the item and its later history remain.
    const snapshots = await ctx.storage.versions.list(item.id);
    const doomed = snapshots.filter((v) => v.version === base).map((v) => v.id);
    expect(doomed.length).toBeGreaterThan(0);
    await ctx.storage.versions.deleteByIds(doomed);

    return { id: item.id, base };
  }

  it("is its own refusal, carrying the state to re-apply against", async () => {
    const { id, base } = await noteWithThinnedAncestor();

    const res = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.spaceKey,
      body: {
        properties: { body: "based on a version nobody kept" },
        version: base,
      },
    });
    expect(res.status).toBe(409);
    const conflict = (await res.json()) as {
      error: { code: string; status: number; message: string };
      current: { version: number; properties: Record<string, unknown> };
      requested_version: number;
    };
    // Not `version_conflict`. A client told every field collided resolves
    // into siblings holding text nobody typed, so the state gets its own name.
    expect(conflict.error.code).toBe("ancestor_unavailable");
    expect(conflict.error.status).toBe(409);
    expect(conflict.requested_version).toBe(base);
    // The current state travels with it, or a client refused here has
    // nowhere to go for the version it must re-apply against.
    expect(conflict.current.properties.body).toBe("v3");
    expect(conflict.current.version).toBeGreaterThan(base);
  });

  it("is never auto-merged, even when the write asked for it", async () => {
    const { id, base } = await noteWithThinnedAncestor();

    const res = await request(ctx.app, "PATCH", `/items/${id}?conflict=auto`, {
      key: ctx.spaceKey,
      body: { properties: { body: "must not be merged" }, version: base },
    });
    // `auto` resolves a conflict against an ancestor. There isn't one, and
    // merging against an absent ancestor is how an edit gets lost quietly.
    expect(res.status).toBe(409);
    const conflict = (await res.json()) as { error: { code: string } };
    expect(conflict.error.code).toBe("ancestor_unavailable");

    const read = await request(ctx.app, "GET", `/items/${id}`, {
      key: ctx.spaceKey,
    });
    const { item } = (await read.json()) as {
      item: { properties: Record<string, unknown> };
    };
    expect(item.properties.body).toBe("v3");
  });
});

describe("the conflict envelope", () => {
  it("says what went wrong in words as well as in codes", async () => {
    const { id, base } = await collidingNote();

    const res = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.spaceKey,
      body: { properties: { body: "loser" }, version: base },
    });
    expect(res.status).toBe(409);
    const conflict = (await res.json()) as {
      error: { code: string; status: number; message: string };
    };
    // `status` and `message` both travel. A caller with no resolution to
    // offer otherwise has to build a sentence out of two version numbers
    // before it can tell anyone anything, and mostly shows the bare code.
    expect(conflict.error.status).toBe(409);
    expect(conflict.error.message).toContain(String(base));
    expect(conflict.error.message.length).toBeGreaterThan(0);
  });
});

describe("the resolution report", () => {
  it("names the sibling, which nothing else does", async () => {
    const { id, base } = await collidingNote();

    const res = await request(ctx.app, "PATCH", `/items/${id}?conflict=auto`, {
      key: ctx.spaceKey,
      body: { properties: { body: "reported loser" }, version: base },
    });
    expect(res.status).toBe(200);
    const answered = (await res.json()) as {
      conflict_resolution?: {
        fields: string[];
        strategy: Record<string, string>;
        conflicted_copy_id?: string;
      };
    };

    expect(answered.conflict_resolution).toBeDefined();
    expect(answered.conflict_resolution?.fields).toContain("body");
    expect(answered.conflict_resolution?.strategy.body).toBe(
      "keep_both_copies",
    );

    // No route reports what a write created, so without this the sibling
    // exists and a caller has no way to reach the row it just caused.
    const siblingId = answered.conflict_resolution?.conflicted_copy_id;
    expect(siblingId).toBeDefined();
    const sibling = await request(
      ctx.app,
      "GET",
      `/items/${String(siblingId)}`,
      {
        key: ctx.spaceKey,
      },
    );
    expect(sibling.status).toBe(200);
    const { item } = (await sibling.json()) as {
      item: { properties: Record<string, unknown> };
    };
    expect(item.properties.body).toBe("reported loser");
  });

  it("is absent from a write that resolved nothing", async () => {
    const created = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: { type: "core.note", properties: { body: "uncontested" } },
    });
    const { item } = (await created.json()) as CreatedItem;

    const res = await request(ctx.app, "PATCH", `/items/${item.id}`, {
      key: ctx.spaceKey,
      body: { properties: { body: "still uncontested" } },
    });
    expect(res.status).toBe(200);
    const answered = (await res.json()) as Record<string, unknown>;
    // A key present and empty is a field a client can see and cannot use,
    // which is the shape of defect this envelope work exists to remove.
    expect("conflict_resolution" in answered).toBe(false);
  });

  it("does not put the report on the item itself", async () => {
    const { id, base } = await collidingNote();

    const res = await request(ctx.app, "PATCH", `/items/${id}?conflict=auto`, {
      key: ctx.spaceKey,
      body: { properties: { body: "not on the row" }, version: base },
    });
    const answered = (await res.json()) as {
      item: Record<string, unknown>;
    };
    // The row has no such column, so a field there would be one that no
    // read of the item ever returns.
    expect("conflict_resolution" in answered.item).toBe(false);
  });
});

describe("a refusal and its replay describe one conflict", () => {
  it("stamps X-Error-Code on a fresh 409 as well as on the replay", async () => {
    const { id, base } = await collidingNote();
    const key = `conflict-header-${Math.random().toString(36).slice(2, 10)}`;

    const fresh = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.spaceKey,
      headers: { "Idempotency-Key": key },
      body: { properties: { body: "header check" }, version: base },
    });
    expect(fresh.status).toBe(409);

    const replay = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.spaceKey,
      headers: { "Idempotency-Key": key },
      body: { properties: { body: "header check" }, version: base },
    });
    expect(replay.status).toBe(409);

    // The replay reads the code out of the recorded body and sets the
    // header. This refusal is returned rather than thrown, so the error
    // handler that would otherwise set it never runs — and a client
    // branching on the header saw it appear only on the retry.
    expect(fresh.headers.get("X-Error-Code")).toBe("version_conflict");
    expect(replay.headers.get("X-Error-Code")).toBe(
      fresh.headers.get("X-Error-Code"),
    );
  });

  it("names the ancestor_unavailable code in the header too", async () => {
    const created = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: { type: "core.note", properties: { body: "h1" } },
    });
    const { item } = (await created.json()) as CreatedItem;
    for (const body of ["h2", "h3"]) {
      await request(ctx.app, "PATCH", `/items/${item.id}`, {
        key: ctx.spaceKey,
        body: { properties: { body } },
      });
    }
    const snapshots = await ctx.storage.versions.list(item.id);
    await ctx.storage.versions.deleteByIds(
      snapshots.filter((v) => v.version === item.version).map((v) => v.id),
    );

    const res = await request(ctx.app, "PATCH", `/items/${item.id}`, {
      key: ctx.spaceKey,
      body: { properties: { body: "no ancestor" }, version: item.version },
    });
    expect(res.status).toBe(409);
    // The header carries the code that was actually sent, not a fixed
    // literal — the two refusals share this door.
    expect(res.headers.get("X-Error-Code")).toBe("ancestor_unavailable");
  });
});
