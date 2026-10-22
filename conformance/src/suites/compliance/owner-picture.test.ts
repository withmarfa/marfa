import { createHash } from "node:crypto";
import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  approvedApp,
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { controlRequest } from "../../utils/control-request.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import { declareOversizeBody } from "../../utils/oversize.js";
import {
  avif,
  gif,
  html,
  jpeg,
  png,
  pngPadded,
  svg,
  webp,
} from "../../utils/pictures.js";

const MAX_BYTES = 2 * 1024 * 1024;

let server: FreshServer;
beforeAll(async () => {
  server = await bootFreshServer("owner-picture");
  vi.stubEnv("MARFA_API_URL", server.apiUrl);
}, FRESH_SERVER_TIMEOUT_MS);
afterAll(async () => {
  vi.unstubAllEnvs();
  await server?.stop();
}, FRESH_SERVER_TIMEOUT_MS);

const address = () => `${server.apiUrl}/owner/picture`;
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** A body for `fetch`, whatever the file's buffer type. */
const bytesOf = (file: Uint8Array) => new Uint8Array(file);

function putOwner(
  body: Uint8Array | null,
  headers: Record<string, string> = {},
) {
  return fetch(address(), {
    method: "PUT",
    headers: {
      cookie: server.ownerCookie,
      origin: server.apiUrl,
      ...headers,
    },
    body: body === null ? null : bytesOf(body),
  });
}

function putProfile(
  body: Uint8Array | null,
  key: string | null = server.workingKey,
  headers: Record<string, string> = {},
) {
  return fetch(`${server.apiUrl}/profile/picture`, {
    method: "PUT",
    headers: {
      ...(key === null ? {} : { authorization: `Bearer ${key}` }),
      ...headers,
    },
    body: body === null ? null : bytesOf(body),
  });
}

function getAsOwner(headers: Record<string, string> = {}) {
  return fetch(address(), {
    headers: { cookie: server.ownerCookie, ...headers },
  });
}

function getWithKey(key: string) {
  return fetch(address(), { headers: { authorization: `Bearer ${key}` } });
}

function patchOwner(body: unknown) {
  return fetch(`${server.apiUrl}/owner`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      origin: server.apiUrl,
      cookie: server.ownerCookie,
    },
    body: JSON.stringify(body),
  });
}

function patchProfile(body: unknown, key = server.workingKey) {
  return fetch(`${server.apiUrl}/profile`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });
}

async function ownerNow() {
  return (await controlRequest(server.controlSocket, "/owner")).body;
}

/** The bytes the server serves to the owner, or its refusal. */
async function served(): Promise<{
  status: number;
  type: string | null;
  bytes: Buffer;
}> {
  const res = await getAsOwner();
  return {
    status: res.status,
    type: res.headers.get("content-type"),
    bytes: Buffer.from(await res.arrayBuffer()),
  };
}

/**
 * An approved app, made once per run of this file: the consent screen
 * refuses a burst of approvals.
 */
const apps = new Map<string, ReturnType<typeof approvedApp>>();
function app(name: "writes" | "avatar" | "name") {
  const scopes = {
    writes: ["openid", "profile:write"],
    avatar: ["openid", "profile.avatar:read", "offline_access"],
    name: ["openid", "profile.name:read"],
  }[name];
  let made = apps.get(name);
  if (made === undefined) {
    made = approvedApp(server, scopes);
    apps.set(name, made);
  }
  return made;
}

async function keyWith(profile_permissions: Record<string, string>) {
  const made = await controlRequest(server.controlSocket, "/keys", {
    method: "POST",
    body: {
      label: "Picture",
      source: `picture-${Math.random().toString(36).slice(2, 10)}`,
      profile_permissions,
    },
  });
  expect(made.status).toBe(201);
  return made.body.key as string;
}

/** The refusal an answer carries: its status and error code. */
async function refusal(res: Response) {
  const body = (await res.json()) as { error?: { code?: string } };
  return { status: res.status, code: body.error?.code, body };
}

/** Removes the picture, so the case that follows starts with none. */
async function clear() {
  expect((await patchOwner({ avatar: null })).status).toBe(200);
}

/**
 * Sends `parts` as a body with no declared length and returns the answer, or
 * `undefined` when none arrived by the time `waitMs` had passed. The body is
 * left open until the answer is in, so an answer proves the server did not
 * wait for the end.
 */
function sendChunked(
  parts: readonly Uint8Array[],
  waitMs: number,
): Promise<{ status: number; ended: boolean } | undefined> {
  return new Promise((resolve, reject) => {
    const req = request(address(), {
      method: "PUT",
      agent: false,
      headers: {
        cookie: server.ownerCookie,
        origin: server.apiUrl,
        "content-type": "application/octet-stream",
        "transfer-encoding": "chunked",
      },
    });
    let ended = false;
    let answered = false;
    const timer = setTimeout(() => {
      req.destroy();
      resolve(undefined);
    }, waitMs);
    req.on("response", (res) => {
      answered = true;
      clearTimeout(timer);
      res.resume();
      resolve({ status: res.statusCode ?? 0, ended });
      req.destroy();
    });
    req.on("error", (error) => {
      if (!answered) {
        clearTimeout(timer);
        reject(error);
      }
    });
    void (async () => {
      for (const part of parts) {
        if (answered) return;
        await new Promise<void>((done) => {
          req.write(part, () => {
            done();
          });
        });
      }
      // The body is left open: ending it is what an answer must not wait for.
    })();
  });
}

describe("the owner's picture", () => {
  it("stores a picture sent to the owner door and returns the owner", async () => {
    const before = await ownerNow();
    expect(before.avatar).toBeNull();
    const file = png(16, 16);
    const res = await putOwner(file);
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Record<string, unknown>;
    expect(updated).toMatchObject({
      ...before,
      avatar: address(),
    });
    await expectMatchesSchema("PUT", "/owner/picture", 200, updated);
    expect((await ownerNow()).avatar).toBe(address());
    const read = await fetch(`${server.apiUrl}/owner`, {
      headers: { cookie: server.ownerCookie },
    });
    expect((await read.json()).avatar).toBe(address());
    expect(await served()).toMatchObject({ status: 200, bytes: file });
  });

  it("stores a picture sent through the private local command", async () => {
    const file = png(12, 12, 0x20);
    const res = await controlRequest(server.controlSocket, "/owner/picture", {
      method: "PUT",
      body: file,
    });
    expect(res.status).toBe(200);
    expect(res.body.avatar).toBe(address());
    expect((await served()).bytes).toEqual(file);
  });

  it("stores a picture sent to the profile door by a credential that may write the avatar", async () => {
    await clear();
    const file = png(10, 10, 0x40);
    const res = await putProfile(file);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    await expectMatchesSchema("PUT", "/profile/picture", 200, body);
    expect((await served()).bytes).toEqual(file);

    const writer = await keyWith({ avatar: "write" });
    const other = png(11, 11, 0x41);
    expect((await putProfile(other, writer)).status).toBe(200);
    expect((await served()).bytes).toEqual(other);

    const third = png(9, 9, 0x42);
    expect((await putProfile(third, (await app("writes")).token)).status).toBe(
      200,
    );
    expect((await served()).bytes).toEqual(third);
  });

  it("decides the kind from the bytes and not from what the request claims", async () => {
    const cases = [
      // The kind, and a claim that contradicts it.
      { file: png(), type: "image/png", claim: "text/plain", name: "a.txt" },
      { file: jpeg(), type: "image/jpeg", claim: "image/png", name: "a.png" },
      { file: webp(), type: "image/webp", claim: "application/json", name: "" },
    ];
    for (const { file, type, claim, name } of cases) {
      const headers: Record<string, string> = { "content-type": claim };
      if (name !== "")
        headers["content-disposition"] = `attachment; filename="${name}"`;
      expect((await putOwner(file, headers)).status, type).toBe(200);
      const seen = await served();
      expect(seen.type, type).toBe(type);
      expect(seen.bytes, type).toEqual(file);
    }
    // The same through the profile door, with no type at all.
    expect((await putProfile(jpeg(20, 10), server.workingKey)).status).toBe(
      200,
    );
    expect((await served()).type).toBe("image/jpeg");
  });

  it("refuses a body that is not a PNG, JPEG or WebP, whatever the request claims", async () => {
    await clear();
    const kept = png(7, 7);
    expect((await putOwner(kept)).status).toBe(200);
    const notPictures = [
      ["html", html()],
      ["svg", svg()],
      ["gif", gif()],
      ["avif", avif()],
      ["text", Buffer.from("hello, this is not a picture")],
    ] as const;
    for (const [label, file] of notPictures) {
      const claims = {
        "content-type": "image/png",
        "content-disposition": 'attachment; filename="picture.png"',
      };
      for (const send of [
        () => putOwner(file, claims),
        () => putProfile(file, server.workingKey, claims),
      ]) {
        const refused = await refusal(await send());
        expect(refused, label).toMatchObject({
          status: 400,
          code: "validation_error",
        });
        await expectMatchesSchema("PUT", "/owner/picture", 400, refused.body);
      }
    }
    // The previous picture stands, and the same door took a real one.
    expect((await served()).bytes).toEqual(kept);
  });

  it("refuses an empty body and a picture cut short, and keeps the previous one", async () => {
    const kept = png(6, 6);
    expect((await putOwner(kept)).status).toBe(200);
    const empty = await refusal(await putOwner(new Uint8Array()));
    expect(empty).toMatchObject({ status: 400, code: "validation_error" });
    expect(await refusal(await putProfile(new Uint8Array()))).toMatchObject({
      status: 400,
      code: "validation_error",
    });
    expect(await refusal(await putOwner(null))).toMatchObject({
      status: 400,
      code: "validation_error",
    });
    for (const [label, whole] of [
      ["png", png(20, 20)],
      ["jpeg", jpeg(20, 20)],
      ["webp", webp(20, 20)],
    ] as const) {
      // The witness: the whole file is accepted, so the cuts below are
      // refused for being cut and not for being what they are.
      expect((await putOwner(whole)).status, label).toBe(200);
      expect((await putOwner(kept)).status, label).toBe(200);
      for (const cut of [4, 10, 16, 33, whole.length - 1]) {
        if (cut >= whole.length) continue;
        for (const send of [putOwner, putProfile]) {
          const res = await send(whole.subarray(0, cut));
          expect(
            await refusal(res),
            `${label} at ${String(cut)} of ${String(whole.length)}`,
          ).toMatchObject({ status: 400, code: "validation_error" });
        }
      }
    }
    // Files that stop where they should not, or hold more than they declare.
    const longerWebp = Buffer.concat([webp(20, 20), Buffer.alloc(2)]);
    const shorterWebp = Buffer.from(webp(20, 20));
    shorterWebp.writeUInt32LE(shorterWebp.readUInt32LE(4) - 2, 4);
    const whole = jpeg(20, 20);
    for (const [label, file] of [
      [
        "a PNG with a byte after its end",
        Buffer.concat([png(20, 20), Buffer.alloc(1)]),
      ],
      ["a WebP with bytes past its declared size", longerWebp],
      ["a WebP that declares less than the file", shorterWebp],
      ["a JPEG with no end marker", whole.subarray(0, whole.length - 2)],
      ["a JPEG of a lossless frame", jpeg(20, 20, 0xc3)],
      ["a JPEG of an arithmetic frame", jpeg(20, 20, 0xc9)],
    ] as const) {
      expect(await refusal(await putOwner(file)), label).toMatchObject({
        status: 400,
        code: "validation_error",
      });
    }
    // The witness: a progressive frame is taken, so the refusals above were
    // for what they are.
    expect((await putOwner(jpeg(20, 20, 0xc2))).status).toBe(200);
    expect((await putOwner(kept)).status).toBe(200);
    expect((await served()).bytes).toEqual(kept);
  });

  it("accepts 4096 pixels on a side and refuses none and 4097", async () => {
    await clear();
    const makers = { png: (w: number, h: number) => png(w, h), jpeg, webp };
    for (const [label, make] of Object.entries(makers)) {
      expect((await putOwner(make(4096, 1))).status, label).toBe(200);
      expect((await putOwner(make(1, 4096))).status, label).toBe(200);
      for (const [width, height] of [
        [0, 8],
        [8, 0],
        [4097, 1],
        [1, 4097],
      ] as const) {
        // WebP stores its size less one, so zero is not writable there.
        if (label === "webp" && (width === 0 || height === 0)) continue;
        const refused = await refusal(await putOwner(make(width, height)));
        expect(
          refused,
          `${label} ${String(width)}x${String(height)}`,
        ).toMatchObject({ status: 400, code: "validation_error" });
      }
    }
  });

  it("accepts a picture of exactly 2097152 bytes and refuses one byte more", async () => {
    await clear();
    const atLimit = pngPadded(MAX_BYTES);
    expect(atLimit.length).toBe(MAX_BYTES);
    expect((await putOwner(atLimit)).status).toBe(200);
    expect((await served()).bytes.length).toBe(MAX_BYTES);
    const over = pngPadded(MAX_BYTES + 1);
    for (const send of [() => putOwner(over), () => putProfile(over)]) {
      const refused = await refusal(await send());
      expect(refused).toMatchObject({
        status: 413,
        code: "request_too_large",
      });
      await expectMatchesSchema("PUT", "/owner/picture", 413, refused.body);
    }
    // The refused ones left the stored picture as it was.
    expect((await served()).bytes.length).toBe(MAX_BYTES);
  });

  it("refuses an oversize body as soon as it passes the limit, declared or not", async () => {
    const kept = png(5, 5);
    expect((await putOwner(kept)).status).toBe(200);
    // Declared: the server answers on the header, with no body behind it.
    const declared = await declareOversizeBody(address(), {
      method: "PUT",
      headers: { cookie: server.ownerCookie, origin: server.apiUrl },
      bytes: MAX_BYTES + 1,
    });
    expect(declared.status).toBe(413);
    expect(JSON.parse(declared.body).error.code).toBe("request_too_large");
    // Not declared: past the limit the answer comes with the body still open.
    const piece = pngPadded(256 * 1024);
    const parts = Array.from({ length: 10 }, () => piece);
    const answer = await sendChunked(parts, 20_000);
    expect(answer).toEqual({ status: 413, ended: false });
    // The witness: a body under the limit gets no early answer, so the one
    // above was an answer to its size.
    const witness = await sendChunked([png(8, 8)], 1_000);
    expect(witness).toBeUndefined();
    expect((await served()).bytes).toEqual(kept);
  });

  it("keeps the previous picture when an upload is cut off, and replaces it when one finishes", async () => {
    const kept = png(14, 14, 0x11);
    expect((await putOwner(kept)).status).toBe(200);
    // A whole picture, sent under a length that promises more: were the body
    // judged as it stood, the server would take it.
    const next = png(64, 64, 0x22);
    await new Promise<void>((resolve) => {
      const req = request(address(), {
        method: "PUT",
        agent: false,
        headers: {
          cookie: server.ownerCookie,
          origin: server.apiUrl,
          "content-length": String(next.length + 16),
        },
      });
      req.on("error", () => resolve());
      req.on("close", () => resolve());
      req.write(next, () => {
        setTimeout(() => req.destroy(), 100);
      });
    });
    await new Promise((done) => setTimeout(done, 300));
    expect((await served()).bytes).toEqual(kept);
    // The witness: the same picture sent whole replaces the old one.
    expect((await putOwner(next)).status).toBe(200);
    expect((await served()).bytes).toEqual(next);
  });

  it("holds one picture, the last one stored", async () => {
    const files = [
      png(8, 8, 0x01),
      jpeg(9, 9),
      webp(10, 10),
      png(11, 11, 0x02),
    ];
    for (const file of files) expect((await putOwner(file)).status).toBe(200);
    const last = files.at(-1)!;
    const rows = withInstanceDatabase(server.sqlitePath, (db) =>
      (
        db.prepare("SELECT sha256 FROM owner_picture").all() as {
          sha256: string;
        }[]
      ).map((row) => row.sha256),
    );
    expect(rows).toEqual([sha256(last)]);
    expect((await served()).bytes).toEqual(last);
  });

  it("removes the picture through either PATCH door and leaves the other fields as they were", async () => {
    for (const door of ["owner", "profile"] as const) {
      expect((await putOwner(png(8, 8))).status, door).toBe(200);
      const before = await ownerNow();
      expect(before.avatar, door).toBe(address());
      const res =
        door === "owner"
          ? await patchOwner({ avatar: null })
          : await patchProfile({ avatar: null });
      expect(res.status, door).toBe(200);
      if (door === "owner") {
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.avatar).toBeNull();
        await expectMatchesSchema("PATCH", "/owner", 200, body);
      }
      expect(await ownerNow(), door).toEqual({ ...before, avatar: null });
      expect((await getAsOwner()).status, door).toBe(404);
    }
    expect(
      withInstanceDatabase(
        server.sqlitePath,
        (db) =>
          (
            db.prepare("SELECT count(*) AS n FROM owner_picture").get() as {
              n: number;
            }
          ).n,
      ),
    ).toBe(0);
  });

  it("refuses a web address as the avatar and changes nothing", async () => {
    const kept = png(8, 8, 0x33);
    expect((await putOwner(kept)).status).toBe(200);
    const before = await ownerNow();
    for (const avatar of ["https://example.test/portrait.png", address(), ""]) {
      expect((await patchOwner({ avatar })).status, avatar).toBe(400);
      expect((await patchProfile({ avatar })).status, avatar).toBe(400);
      expect(
        (await patchOwner({ name: "Renamed", avatar })).status,
        avatar,
      ).toBe(400);
    }
    expect(await ownerNow()).toEqual(before);
    expect((await served()).bytes).toEqual(kept);
    // The witness: a name change alone is taken and leaves the picture.
    expect((await patchOwner({ name: "Renamed" })).status).toBe(200);
    expect((await served()).bytes).toEqual(kept);
  });

  it("gives an app that may read the avatar the picture's address, and no claim when there is none", async () => {
    const readsPicture = await app("avatar");
    const readsName = await app("name");
    const userinfo = async (token: string) =>
      (await (
        await fetch(`${server.apiUrl}/auth/oauth2/userinfo`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).json()) as Record<string, unknown>;
    const idToken = async () => {
      const refreshed = await fetch(`${server.apiUrl}/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: readsPicture.refreshToken ?? "",
          client_id: readsPicture.clientId,
        }),
      });
      expect(refreshed.status).toBe(200);
      const tokens = (await refreshed.json()) as {
        id_token: string;
        refresh_token?: string;
        access_token: string;
      };
      if (tokens.refresh_token !== undefined)
        readsPicture.refreshToken = tokens.refresh_token;
      return JSON.parse(
        Buffer.from(
          tokens.id_token.split(".")[1] ?? "",
          "base64url",
        ).toString(),
      ) as Record<string, unknown>;
    };

    expect((await putOwner(png(8, 8))).status).toBe(200);
    expect((await userinfo(readsPicture.token)).picture).toBe(address());
    expect((await idToken()).picture).toBe(address());
    // An app that did not ask for the avatar is not given it.
    expect(Object.hasOwn(await userinfo(readsName.token), "picture")).toBe(
      false,
    );

    await clear();
    expect(Object.hasOwn(await userinfo(readsPicture.token), "picture")).toBe(
      false,
    );
    expect(Object.hasOwn(await idToken(), "picture")).toBe(false);
  });

  it("serves the stored bytes under the kind decided from them", async () => {
    for (const [file, type] of [
      [png(13, 13), "image/png"],
      [jpeg(13, 13), "image/jpeg"],
      [webp(13, 13), "image/webp"],
    ] as const) {
      expect((await putOwner(file)).status, type).toBe(200);
      const res = await getAsOwner();
      expect(res.status, type).toBe(200);
      expect(res.headers.get("content-type"), type).toBe(type);
      expect(Buffer.from(await res.arrayBuffer()), type).toEqual(file);
    }
  });

  it("serves the picture with the headers that keep its bytes from running", async () => {
    expect((await putOwner(png(8, 8))).status).toBe(200);
    const asKey = await getWithKey(server.workingKey);
    for (const res of [await getAsOwner(), asKey]) {
      expect(res.status).toBe(200);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-security-policy")).toBe(
        "sandbox; default-src 'none'",
      );
      expect(res.headers.get("content-disposition")).toBe(
        'attachment; filename="picture"',
      );
      expect(res.headers.get("cache-control")).toBe("private, no-cache");
      await res.arrayBuffer();
    }
  });

  it("answers 304 to a validator that still matches, and sends the picture when it does not", async () => {
    const file = png(18, 18, 0x55);
    expect((await putOwner(file)).status).toBe(200);
    const first = await getAsOwner();
    const etag = first.headers.get("etag");
    expect(etag).toBe(`"${sha256(file)}"`);
    await first.arrayBuffer();

    const same = await getAsOwner({ "if-none-match": etag ?? "" });
    expect(same.status).toBe(304);
    expect((await same.arrayBuffer()).byteLength).toBe(0);
    expect(same.headers.get("etag")).toBe(etag);

    const stale = await getAsOwner({ "if-none-match": '"0000"' });
    expect(stale.status).toBe(200);
    expect(Buffer.from(await stale.arrayBuffer())).toEqual(file);

    // After a replacement the old validator no longer matches.
    const next = png(19, 19, 0x56);
    expect((await putOwner(next)).status).toBe(200);
    const after = await getAsOwner({ "if-none-match": etag ?? "" });
    expect(after.status).toBe(200);
    expect(Buffer.from(await after.arrayBuffer())).toEqual(next);
  });

  it("serves the picture only to the owner and to a credential that may read the avatar", async () => {
    expect((await putOwner(png(8, 8))).status).toBe(200);
    // The admitted callers, so the refusals below are about the caller.
    expect((await getAsOwner()).status).toBe(200);
    const reader = await keyWith({ avatar: "read" });
    expect((await getWithKey(reader)).status).toBe(200);
    expect((await getWithKey(server.workingKey)).status).toBe(200);
    expect((await getWithKey((await app("avatar")).token)).status).toBe(200);

    const nameOnly = await keyWith({ name: "write" });
    expect(await refusal(await getWithKey(nameOnly))).toMatchObject({
      status: 403,
      code: "forbidden",
    });
    expect(
      await refusal(await getWithKey((await app("name")).token)),
    ).toMatchObject({
      status: 403,
      code: "forbidden",
    });
    expect(await refusal(await getWithKey(server.managementKey))).toMatchObject(
      { status: 403, code: "forbidden" },
    );
    expect((await fetch(address())).status).toBe(401);
    // A credential that may only read the avatar cannot write it.
    const refused = await refusal(await putProfile(png(8, 8), reader));
    expect(refused).toMatchObject({ status: 403, code: "forbidden" });
  });

  it("answers 404 when there is no picture, and again after it is removed", async () => {
    await clear();
    const none = await refusal(await getAsOwner());
    expect(none).toMatchObject({ status: 404, code: "not_found" });
    await expectMatchesSchema("GET", "/owner/picture", 404, none.body);
    expect((await getWithKey(server.workingKey)).status).toBe(404);
    // The witness: with a picture the same door answers.
    expect((await putOwner(png(8, 8))).status).toBe(200);
    expect((await getAsOwner()).status).toBe(200);
    await clear();
    expect((await getAsOwner()).status).toBe(404);
  });

  it("refuses a picture from a caller the door does not admit, and keeps the previous one", async () => {
    const kept = png(8, 8, 0x77);
    expect((await putOwner(kept)).status).toBe(200);
    const next = png(9, 9, 0x78);

    // The profile door: a credential without avatar write.
    const nameWriter = await keyWith({ name: "write" });
    const reader = await keyWith({ avatar: "read" });
    for (const key of [nameWriter, reader, server.managementKey]) {
      expect(
        await refusal(await putProfile(next, key)),
        key.slice(0, 4),
      ).toMatchObject({ status: 403, code: "forbidden" });
    }
    expect(
      await refusal(await putProfile(next, (await app("name")).token)),
    ).toMatchObject({ status: 403, code: "forbidden" });
    expect((await putProfile(next, null)).status).toBe(401);

    // The owner door: no sign-in, and a key beside the owner's cookie.
    expect(
      (
        await fetch(address(), {
          method: "PUT",
          headers: { origin: server.apiUrl },
          body: bytesOf(next),
        })
      ).status,
    ).toBe(401);
    expect(
      (await putOwner(next, { authorization: `Bearer ${server.workingKey}` }))
        .status,
    ).toBe(403);
    expect((await served()).bytes).toEqual(kept);

    // The witness: the owner a moment after signing in is admitted, and
    // the same owner past five minutes is not.
    expect((await putOwner(next)).status).toBe(200);
    await server.advanceClock(300_001);
    expect(await refusal(await putOwner(kept))).toMatchObject({
      status: 403,
      code: "forbidden",
    });
    expect((await served()).bytes).toEqual(next);
    // The private local command needs no recent sign-in.
    const local = await controlRequest(server.controlSocket, "/owner/picture", {
      method: "PUT",
      body: kept,
    });
    expect(local.status).toBe(200);
  });
});
