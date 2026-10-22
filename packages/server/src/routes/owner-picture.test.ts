import { createHash } from "node:crypto";
import * as clock from "../clock.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PICTURE_MAX_BYTES } from "../picture.js";
import {
  avif,
  gif,
  html,
  jpeg,
  png,
  pngPadded,
  svg,
  webp,
} from "../test-pictures.js";
import {
  createTestContext,
  request,
  seedOauthBearer,
  type TestContext,
} from "../test-utils.js";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await ctx.cleanup();
});

type RawBody = NonNullable<RequestInit["body"]> | null;

const origin = () => new URL(ctx.config.authBaseUrl).origin;
const address = () => `${origin()}/owner/picture`;

type Raw = typeof ctx.storage & {
  __sqliteAll(query: string): Promise<Record<string, unknown>[]>;
  __sqliteRun(query: string, args: unknown[]): Promise<unknown>;
};
const raw = () => ctx.storage as Raw;
const rows = () =>
  raw().__sqliteAll(
    "SELECT user_id, content_type, sha256, length(bytes) AS held FROM owner_picture",
  );

function bytesOf(buffer: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(buffer);
}

function owner(
  body: RawBody,
  headers: Record<string, string> = {},
  init: RequestInit = {},
) {
  return ctx.app.request("/owner/picture", {
    method: "PUT",
    headers: { cookie: ctx.owner.cookie, origin: origin(), ...headers },
    body,
    ...init,
  });
}

function profile(
  body: RawBody,
  key: string | null = ctx.workingKey,
  headers: Record<string, string> = {},
  init: RequestInit = {},
) {
  return ctx.app.request("/profile/picture", {
    method: "PUT",
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
    body,
    ...init,
  });
}

function read(headers: Record<string, string> = {}) {
  return ctx.app.request("/owner/picture", {
    headers: { cookie: ctx.owner.cookie, ...headers },
  });
}

function readAs(key: string) {
  return request(ctx.app, "GET", "/owner/picture", { key });
}

function patchOwner(body: unknown) {
  return request(ctx.app, "PATCH", "/owner", {
    body,
    headers: { cookie: ctx.owner.cookie, origin: origin() },
  });
}

async function keyWith(profile_permissions: Record<string, string>) {
  const made = await ctx.ownerRequest("/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      label: "picture",
      source: `picture-${Math.random().toString(36).slice(2, 10)}`,
      profile_permissions,
    }),
  });
  expect(made.status).toBe(201);
  return ((await made.json()) as { key: string }).key;
}

/** A body that sends `chunks`, then fails as a dropped connection would. */
function brokenStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      const next = chunks[sent];
      sent += 1;
      if (next) controller.enqueue(next);
      else controller.error(new Error("connection reset"));
    },
  });
}

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

describe("uploading a picture", () => {
  it("stores a picture sent to the owner door and answers the owner with its address", async () => {
    const file = png(12, 9);
    const response = await owner(bytesOf(file));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: ctx.owner.id,
      avatar: address(),
    });
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      user_id: ctx.owner.id,
      content_type: "image/png",
      sha256: sha(file),
      held: file.length,
    });
    const info = await (await ctx.ownerRequest("/owner")).json();
    expect(info).toMatchObject({ avatar: address() });
  });

  it("stores a picture sent to the profile door with a key that may write the avatar", async () => {
    const file = jpeg(30, 20);
    const response = await profile(bytesOf(file));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(await rows()).toMatchObject([
      { content_type: "image/jpeg", sha256: sha(file) },
    ]);
  });

  it("decides the kind from the bytes and ignores the claimed type and file name", async () => {
    // The witness: a real picture under the same claims is taken.
    const disguised = {
      "content-type": "image/png",
      "content-disposition": 'attachment; filename="portrait.png"',
    };
    expect((await owner(bytesOf(png()), disguised)).status).toBe(200);
    const kept = await rows();
    for (const [name, file] of [
      ["html", html()],
      ["svg", svg()],
      ["text", Buffer.from("not a picture at all")],
    ] as const) {
      const refused = await owner(bytesOf(file), disguised);
      expect(refused.status, name).toBe(400);
      expect(await refused.json(), name).toMatchObject({
        error: {
          code: "validation_error",
          message: expect.stringContaining("PNG, JPEG or WebP") as string,
        },
      });
      expect(await rows(), name).toEqual(kept);
    }
  });

  it("serves a picture by what it is, whatever type or name it arrived under", async () => {
    expect(
      (
        await owner(bytesOf(png()), {
          "content-type": "text/plain",
          "content-disposition": 'attachment; filename="notes.txt"',
        })
      ).status,
    ).toBe(200);
    expect((await read()).headers.get("content-type")).toBe("image/png");
    expect(
      (await owner(bytesOf(jpeg()), { "content-type": "image/png" })).status,
    ).toBe(200);
    expect((await read()).headers.get("content-type")).toBe("image/jpeg");
    expect(
      (await owner(bytesOf(webp()), { "content-type": "image/gif" })).status,
    ).toBe(200);
    expect((await read()).headers.get("content-type")).toBe("image/webp");
  });

  it("refuses GIF, AVIF and an empty body, and keeps the previous picture", async () => {
    const first = png();
    expect((await owner(bytesOf(first))).status).toBe(200);
    for (const [name, file] of [
      ["gif", gif()],
      ["avif", avif()],
      ["empty", Buffer.alloc(0)],
    ] as const) {
      const refused = await owner(bytesOf(file));
      expect(refused.status, name).toBe(400);
      expect(await refused.json(), name).toMatchObject({
        error: { code: "validation_error" },
      });
      expect(await rows(), name).toMatchObject([{ sha256: sha(first) }]);
    }
  });

  it("refuses a missing body", async () => {
    const refused = await owner(null);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      error: { code: "validation_error" },
    });
    expect(await rows()).toHaveLength(0);
  });

  it("refuses a picture that is cut short and keeps the previous one", async () => {
    const first = png();
    expect((await owner(bytesOf(first))).status).toBe(200);
    for (const whole of [png(), jpeg(), webp()]) {
      for (const length of [14, 33, whole.length - 1].filter(
        (at) => at < whole.length,
      )) {
        const refused = await owner(bytesOf(whole.subarray(0, length)));
        expect(
          refused.status,
          `${String(length)} of ${String(whole.length)}`,
        ).toBe(400);
        expect(await refused.json()).toMatchObject({
          error: { code: "validation_error" },
        });
        expect(await rows()).toMatchObject([{ sha256: sha(first) }]);
      }
    }
    // The witness: each whole file is taken.
    for (const whole of [jpeg(), webp(), png(9, 9)]) {
      expect((await owner(bytesOf(whole))).status).toBe(200);
      expect(await rows()).toMatchObject([{ sha256: sha(whole) }]);
    }
  });

  it("refuses a width or height outside 1 to 4096 and takes the edge itself", async () => {
    expect((await owner(bytesOf(png(4096, 1)))).status).toBe(200);
    expect((await owner(bytesOf(png(1, 4096)))).status).toBe(200);
    const kept = await rows();
    for (const [width, height] of [
      [0, 8],
      [8, 0],
      [4097, 1],
      [1, 4097],
    ] as const) {
      const refused = await owner(bytesOf(png(width, height)));
      expect(refused.status, `${String(width)}x${String(height)}`).toBe(400);
      expect(await refused.json()).toMatchObject({
        error: { code: "validation_error" },
      });
      expect(await rows()).toEqual(kept);
    }
  });
});

describe("the size cap", () => {
  it("takes a picture of exactly 2 MiB and refuses one byte more", async () => {
    expect(PICTURE_MAX_BYTES).toBe(2_097_152);
    const exact = pngPadded(PICTURE_MAX_BYTES);
    expect((await owner(bytesOf(exact))).status).toBe(200);
    expect(await rows()).toMatchObject([{ held: PICTURE_MAX_BYTES }]);
    const over = pngPadded(PICTURE_MAX_BYTES + 1);
    const refused = await owner(bytesOf(over));
    expect(refused.status).toBe(413);
    expect(await refused.json()).toMatchObject({
      error: { code: "request_too_large" },
    });
    expect(await rows()).toMatchObject([
      { held: PICTURE_MAX_BYTES, sha256: sha(exact) },
    ]);
  });

  it("refuses by the declared length before reading the body", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024));
      },
    });
    const refused = await owner(
      body,
      { "content-length": String(PICTURE_MAX_BYTES + 1) },
      { duplex: "half" },
    );
    expect(refused.status).toBe(413);
    expect(pulled).toBeLessThan(3);
  });

  it("stops reading a body with no declared length once it passes the cap", async () => {
    const chunk = 64 * 1024;
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(chunk));
        if (pulled > 1000) controller.close();
      },
    });
    const refused = await owner(body, {}, { duplex: "half" });
    expect(refused.status).toBe(413);
    // The cap is 32 chunks; one more crosses it, and the stream is let go.
    expect(pulled * chunk).toBeLessThanOrEqual(PICTURE_MAX_BYTES + 4 * chunk);
    expect(pulled).toBeGreaterThan(PICTURE_MAX_BYTES / chunk);
    expect(await rows()).toHaveLength(0);
  });

  it("applies the same cap at the profile door", async () => {
    const over = pngPadded(PICTURE_MAX_BYTES + 1);
    expect((await profile(bytesOf(over))).status).toBe(413);
    expect(await rows()).toHaveLength(0);
  });
});

describe("an upload that does not finish", () => {
  it("stores nothing and keeps the previous picture, where the finished upload replaces it", async () => {
    const first = png(4, 4);
    expect((await owner(bytesOf(first))).status).toBe(200);
    const next = jpeg(6, 6);
    const refused = await owner(
      brokenStream([bytesOf(next)]),
      {},
      {
        duplex: "half",
      },
    );
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      error: { code: "validation_error" },
    });
    expect(await rows()).toMatchObject([{ sha256: sha(first) }]);
    // The witness: the same bytes, with the upload finished, do replace it.
    expect((await owner(bytesOf(next))).status).toBe(200);
    expect(await rows()).toMatchObject([{ sha256: sha(next) }]);
  });
});

describe("replacing and removing", () => {
  it("keeps one row holding only the newest bytes", async () => {
    const first = png(4, 4);
    const second = jpeg(5, 5);
    expect((await owner(bytesOf(first))).status).toBe(200);
    expect((await profile(bytesOf(second))).status).toBe(200);
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      content_type: "image/jpeg",
      held: second.length,
      sha256: sha(second),
    });
    const served = Buffer.from(await (await read()).arrayBuffer());
    expect(served.equals(second)).toBe(true);
  });

  it("clears the address, the claim and the picture when the owner removes it", async () => {
    const oauth = await seedOauthBearer(ctx, ["openid", "profile"]);
    const claim = async () =>
      (
        (await (
          await request(ctx.app, "GET", "/auth/oauth2/userinfo", {
            key: oauth.token,
          })
        ).json()) as Record<string, unknown>
      ).picture;
    // The witness: with a picture set, both are there.
    expect((await owner(bytesOf(png()))).status).toBe(200);
    expect(await claim()).toBe(address());
    expect((await read()).status).toBe(200);

    const removed = await patchOwner({ avatar: null });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ avatar: null });
    expect(await rows()).toHaveLength(0);
    expect(await claim()).toBeUndefined();
    const gone = await read();
    expect(gone.status).toBe(404);
    expect(await gone.json()).toMatchObject({ error: { code: "not_found" } });
    expect(await (await ctx.ownerRequest("/owner")).json()).toMatchObject({
      avatar: null,
    });
  });

  it("removes the picture through the profile door too", async () => {
    expect((await owner(bytesOf(png()))).status).toBe(200);
    const removed = await request(ctx.app, "PATCH", "/profile", {
      key: ctx.workingKey,
      body: { avatar: null },
    });
    expect(removed.status).toBe(200);
    expect(await rows()).toHaveLength(0);
    expect((await read()).status).toBe(404);
  });

  it("refuses a web address at both doors and changes nothing", async () => {
    expect((await owner(bytesOf(png()))).status).toBe(200);
    const kept = await rows();
    for (const avatar of ["https://example.com/p.png", "", "file:///p.png"]) {
      const viaOwner = await patchOwner({ avatar });
      expect(viaOwner.status, avatar).toBe(400);
      expect(await viaOwner.json()).toMatchObject({
        error: { code: "validation_error" },
      });
      const viaProfile = await request(ctx.app, "PATCH", "/profile", {
        key: ctx.workingKey,
        body: { avatar },
      });
      expect(viaProfile.status, avatar).toBe(400);
    }
    const mixed = await patchOwner({
      name: "Not renamed",
      avatar: "https://example.com/p.png",
    });
    expect(mixed.status).toBe(400);
    expect((await ctx.storage.owner!.find())!.name).not.toBe("Not renamed");
    expect(await rows()).toEqual(kept);
  });

  it("keeps the picture when the owner changes other fields", async () => {
    expect((await owner(bytesOf(png()))).status).toBe(200);
    const kept = await rows();
    expect((await patchOwner({ name: "Renamed" })).status).toBe(200);
    expect(await rows()).toEqual(kept);
  });
});

describe("who may upload", () => {
  it("answers 401 to a request with no credential at either door", async () => {
    expect((await profile(bytesOf(png()), null)).status).toBe(401);
    expect(
      (
        await ctx.app.request("/owner/picture", {
          method: "PUT",
          body: bytesOf(png()),
        })
      ).status,
    ).toBe(401);
    expect(await rows()).toHaveLength(0);
  });

  it("refuses a key at the owner door, even with an owner cookie beside it", async () => {
    const refused = await ctx.app.request("/owner/picture", {
      method: "PUT",
      headers: {
        authorization: `Bearer ${ctx.workingKey}`,
        cookie: ctx.owner.cookie,
        origin: origin(),
      },
      body: bytesOf(png()),
    });
    expect(refused.status).toBe(403);
    expect(await rows()).toHaveLength(0);
  });

  it("refuses the owner door when the sign-in is more than five minutes old", async () => {
    const session = (
      await raw().__sqliteAll("SELECT created_at FROM auth_session")
    )[0]!;
    const created = Number(session.created_at) * 1000;
    vi.spyOn(clock, "nowMs").mockReturnValue(created + 300_000);
    expect((await owner(bytesOf(png()))).status).toBe(200);
    vi.mocked(clock.nowMs).mockReturnValue(created + 300_001);
    const late = await owner(bytesOf(jpeg()));
    expect(late.status).toBe(403);
    expect(await rows()).toMatchObject([{ content_type: "image/png" }]);
  });

  it("limits the profile door to a credential that may write the avatar", async () => {
    const nameOnly = await keyWith({ name: "write" });
    const avatarRead = await keyWith({ avatar: "read" });
    for (const key of [nameOnly, avatarRead, ctx.managementKey]) {
      const refused = await profile(bytesOf(png()), key);
      expect(refused.status).toBe(403);
    }
    expect(await rows()).toHaveLength(0);
    const avatarWrite = await keyWith({ avatar: "write" });
    expect((await profile(bytesOf(png()), avatarWrite)).status).toBe(200);
    expect(await rows()).toHaveLength(1);
  });

  it("checks a key's write permission again where the picture is stored", async () => {
    const key = (await ctx.storage.keys.list()).find(
      (k) => k.profile_permissions["*"] === "write",
    )!;
    const original = ctx.storage.runInTransaction.bind(ctx.storage);
    let arrive!: () => void, release!: () => void;
    const arrived = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    ctx.storage.runInTransaction = async (fn, options) => {
      if (first) {
        first = false;
        arrive();
        await gate;
      }
      return original(fn, options);
    };
    const pending = profile(bytesOf(png()));
    try {
      await arrived;
      await original(() =>
        ctx.storage.keys.update(key.id, {
          profile_permissions: { name: "write" },
        }),
      );
    } finally {
      release();
    }
    expect((await pending).status).toBe(403);
    expect(await rows()).toHaveLength(0);
  });

  it("keeps the previous picture when the audit entry cannot be written", async () => {
    const first = png();
    expect((await owner(bytesOf(first))).status).toBe(200);
    for (const [action, send] of [
      ["owner.update", () => owner(bytesOf(jpeg()))],
      ["profile.update", () => profile(bytesOf(jpeg()))],
    ] as const) {
      await raw().__sqliteRun(
        `CREATE TRIGGER reject_picture_audit BEFORE INSERT ON audit_log WHEN NEW.action = '${action}' BEGIN SELECT RAISE(ABORT, 'audit fault'); END`,
        [],
      );
      expect((await send()).status, action).toBe(500);
      expect(await rows(), action).toMatchObject([{ sha256: sha(first) }]);
      await raw().__sqliteRun("DROP TRIGGER reject_picture_audit", []);
    }
    expect((await owner(bytesOf(jpeg()))).status).toBe(200);
  });

  it("records an upload in the audit log under the door that took it", async () => {
    expect((await owner(bytesOf(png()))).status).toBe(200);
    expect((await profile(bytesOf(jpeg()))).status).toBe(200);
    const entries = await raw().__sqliteAll(
      "SELECT action, resource_type, details FROM audit_log WHERE action IN ('owner.update','profile.update') ORDER BY rowid",
    );
    expect(entries.map((entry) => entry.action)).toEqual([
      "owner.update",
      "profile.update",
    ]);
    for (const entry of entries)
      expect(JSON.parse(String(entry.details))).toMatchObject({
        fields: ["avatar"],
      });
  });
});

describe("who may read", () => {
  beforeEach(async () => {
    expect((await owner(bytesOf(png()))).status).toBe(200);
  });

  it("serves the signed-in owner and a key or app that may read the avatar", async () => {
    expect((await read()).status).toBe(200);
    expect((await readAs(ctx.workingKey)).status).toBe(200);
    expect((await readAs(await keyWith({ avatar: "read" }))).status).toBe(200);
    expect((await readAs(await keyWith({ avatar: "write" }))).status).toBe(200);
    expect((await readAs(await keyWith({ "*": "read" }))).status).toBe(200);
    for (const scopes of [
      ["openid", "profile"],
      ["openid", "profile.avatar:read"],
      ["openid", "profile:read"],
    ]) {
      const app = await seedOauthBearer(ctx, scopes);
      expect((await readAs(app.token)).status, scopes.join(" ")).toBe(200);
    }
  });

  it("refuses a credential that may not read the avatar", async () => {
    expect((await readAs(ctx.managementKey)).status).toBe(403);
    expect((await readAs(await keyWith({ name: "read" }))).status).toBe(403);
    expect((await readAs(await keyWith({ email: "read" }))).status).toBe(403);
    for (const scopes of [["openid"], ["openid", "profile.name:read"]]) {
      const app = await seedOauthBearer(ctx, scopes);
      expect((await readAs(app.token)).status, scopes.join(" ")).toBe(403);
    }
  });

  it("answers 401 to a request with no credential", async () => {
    const refused = await ctx.app.request("/owner/picture");
    expect(refused.status).toBe(401);
  });

  it("answers 404 when no picture is set, to a caller that may read", async () => {
    expect((await patchOwner({ avatar: null })).status).toBe(200);
    for (const response of [await read(), await readAs(ctx.workingKey)]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        error: { code: "not_found" },
      });
    }
    // A caller that may not read still learns nothing about whether one is set.
    expect((await readAs(ctx.managementKey)).status).toBe(403);
  });
});

describe("the served picture", () => {
  it("is held back from every other use of it", async () => {
    const file = png(10, 10);
    expect((await owner(bytesOf(file))).status).toBe(200);
    const response = await read();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe(
      "sandbox; default-src 'none'",
    );
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="picture"',
    );
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(response.headers.get("etag")).toBe(`"${sha(file)}"`);
    expect(response.headers.get("content-length")).toBe(String(file.length));
    expect(Buffer.from(await response.arrayBuffer()).equals(file)).toBe(true);
  });

  it("answers 304 to a matching ETag and the picture to any other", async () => {
    const file = png(10, 10);
    expect((await owner(bytesOf(file))).status).toBe(200);
    const etag = `"${sha(file)}"`;
    const same = await read({ "if-none-match": etag });
    expect(same.status).toBe(304);
    expect(await same.text()).toBe("");
    expect(same.headers.get("etag")).toBe(etag);
    expect((await read({ "if-none-match": '"other"' })).status).toBe(200);
    expect((await read({ "if-none-match": `W/${etag}` })).status).toBe(304);
    expect((await read({ "if-none-match": `"other", ${etag}` })).status).toBe(
      304,
    );
    expect((await owner(bytesOf(jpeg()))).status).toBe(200);
    expect((await read({ "if-none-match": etag })).status).toBe(200);
  });

  it("is not conditional for a caller that may not read it", async () => {
    expect((await owner(bytesOf(png()))).status).toBe(200);
    const refused = await request(ctx.app, "GET", "/owner/picture", {
      key: ctx.managementKey,
      headers: { "if-none-match": `"${sha(png())}"` },
    });
    expect(refused.status).toBe(403);
  });
});

describe("the picture claim", () => {
  it("is the picture's address on userinfo and in the id token, and absent without a picture", async () => {
    const oauth = await seedOauthBearer(ctx, [
      "openid",
      "profile",
      "offline_access",
    ]);
    const userinfo = async () =>
      (await (
        await request(ctx.app, "GET", "/auth/oauth2/userinfo", {
          key: oauth.token,
        })
      ).json()) as Record<string, unknown>;
    expect(await userinfo()).not.toHaveProperty("picture");
    expect((await owner(bytesOf(png()))).status).toBe(200);
    expect(await userinfo()).toMatchObject({ picture: address() });
    const refreshed = await request(ctx.app, "POST", "/auth/oauth2/token", {
      form: {
        client_id: oauth.clientId,
        grant_type: "refresh_token",
        refresh_token: oauth.refreshToken!,
      },
    });
    expect(refreshed.status).toBe(200);
    const { id_token } = (await refreshed.json()) as { id_token: string };
    const claims = JSON.parse(
      Buffer.from(id_token.split(".")[1]!, "base64url").toString(),
    ) as Record<string, unknown>;
    expect(claims.picture).toBe(address());
  });
});
