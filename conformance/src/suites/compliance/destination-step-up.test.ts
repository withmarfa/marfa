import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { controlRequest } from "../../utils/control-request.js";
import {
  approvedAppToken,
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import { tempFolder } from "../../utils/temp-folder.js";

// The clock changes here, so this file owns its server.
let server: FreshServer;
let key: string;
const folder = tempFolder("marfa-destination-step-up-");
const MINUTE = 60 * 1000;
const SECRET = "object_store_secret_access_key";
const CHALLENGE =
  'Bearer error="insufficient_user_authentication", max_age="300"';

/** Each setting that says where files and backups go, with a value it can take. */
const DESTINATION: readonly (readonly [string, string | boolean])[] = [
  ["backup_path", folder],
  ["object_store_bucket", "a-bucket"],
  ["object_store_endpoint", "http://127.0.0.1:9"],
  ["object_store_region", "eu-west-2"],
  ["object_store_path_style", false],
  ["object_store_prefix", "elsewhere"],
];

beforeAll(async () => {
  server = await bootFreshServer("destination-step-up", {
    MARFA_OBJECT_STORE_BUCKET: "",
    MARFA_OBJECT_STORE_ENDPOINT: "",
    MARFA_OBJECT_STORE_ACCESS_KEY_ID: "",
    MARFA_OBJECT_STORE_SECRET_ACCESS_KEY: "",
    MARFA_BACKUP_INTERVAL_SECONDS: "0",
  });
  const minted = await local("POST", "/keys", {
    label: "destination step-up key",
    source: `destination-step-up-${randomUUID()}`,
    permissions: ["config.manage"],
  });
  expect(minted.status, JSON.stringify(minted.body)).toBe(201);
  key = minted.body.key as string;
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
  rmSync(folder, { recursive: true, force: true });
}, FRESH_SERVER_TIMEOUT_MS);

interface Answer {
  status: number;
  challenge: string | null;
  body: Record<string, any>;
}

async function call(
  credential: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Answer> {
  const response = await fetch(`${server.apiUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${credential}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    challenge: response.headers.get("www-authenticate"),
    body: (text === "" ? {} : JSON.parse(text)) as Record<string, any>,
  };
}

function local(method: string, path: string, body?: unknown) {
  return controlRequest(server.controlSocket, path, { method, body });
}

async function stored(): Promise<Record<string, unknown>> {
  const read = await local("GET", "/config");
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  return read.body;
}

async function setLocally(changes: Record<string, unknown>): Promise<void> {
  const set = await local("PATCH", "/config", changes);
  expect(set.status, JSON.stringify(set.body)).toBe(200);
}

function without(
  body: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  const { [name]: _, ...rest } = body;
  return rest;
}

function expectKeyRefused(answer: Answer, name: string): void {
  expect(answer.status, `${name} ${JSON.stringify(answer.body)}`).toBe(403);
  expect(answer.challenge, name).toBeNull();
  expect(answer.body.error.code, name).toBe("app_sign_in_required");
}

function expectChallenged(answer: Answer, name: string): void {
  expect(answer.status, `${name} ${JSON.stringify(answer.body)}`).toBe(401);
  expect(answer.challenge, name).toBe(CHALLENGE);
  expect(answer.body.error.code, name).toBe("insufficient_user_authentication");
  expect(answer.body.error.details, name).toEqual({ max_age: 300 });
}

async function secretSet(): Promise<boolean> {
  const listed = await local("GET", "/config/settings");
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  const row = (listed.body.data as { key: string; set: boolean }[]).find(
    (line) => line.key === SECRET,
  );
  expect(row, `${SECRET} is listed`).toBeDefined();
  const named = ((await stored()).secrets_set ?? []) as string[];
  expect(named.includes(SECRET)).toBe(row!.set);
  return row!.set;
}

describe("a key holding config.manage", () => {
  it("is refused a change to backup_path or an object_store_ setting that says where files go, by PATCH, PUT, null or a PUT that leaves it out, with 403 app_sign_in_required, and changes nothing", async () => {
    // The witness: the key changes a setting that says nothing of where files go.
    const kept = await call(key, "PATCH", "/config", {
      trash_retention_days: 45,
    });
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect((await stored()).trash_retention_days).toBe(45);

    for (const [name, value] of DESTINATION) {
      await setLocally({ [name]: null });
      expectKeyRefused(
        await call(key, "PATCH", "/config", { [name]: value }),
        `PATCH ${name}`,
      );
      expectKeyRefused(
        await call(key, "PUT", "/config", {
          ...(await stored()),
          [name]: value,
        }),
        `PUT ${name}`,
      );
      expect(await stored(), name).not.toHaveProperty(name);

      await setLocally({ [name]: value });
      expectKeyRefused(
        await call(key, "PATCH", "/config", { [name]: null }),
        `null ${name}`,
      );
      expectKeyRefused(
        await call(key, "PUT", "/config", without(await stored(), name)),
        `PUT without ${name}`,
      );
      expect((await stored())[name], name).toEqual(value);
      await setLocally({ [name]: null });
    }
  });

  it("restates the backup_path and object_store_ settings it reads back, by PATCH and by PUT", async () => {
    for (const [name, value] of DESTINATION) {
      await setLocally({ [name]: value });
      const patched = await call(key, "PATCH", "/config", { [name]: value });
      expect(patched.status, `${name} ${JSON.stringify(patched.body)}`).toBe(
        200,
      );
      const put = await call(key, "PUT", "/config", await stored());
      expect(put.status, `${name} ${JSON.stringify(put.body)}`).toBe(200);
      expect((await stored())[name], name).toEqual(value);
      await setLocally({ [name]: null });
    }
  });
});

describe("an app's token holding config.manage", () => {
  it("changes where files and backups go when its owner signed in within five minutes, and is challenged with 401 insufficient_user_authentication and max_age once that was longer ago, changing nothing", async () => {
    const token = await approvedAppToken(server, ["config.manage"]);
    for (const [name, value] of DESTINATION) {
      await setLocally({ [name]: null });
      const set = await call(token, "PATCH", "/config", { [name]: value });
      expect(set.status, `${name} ${JSON.stringify(set.body)}`).toBe(200);
      expect((await stored())[name], name).toEqual(value);
      const cleared = await call(token, "PATCH", "/config", { [name]: null });
      expect(cleared.status, `${name} ${JSON.stringify(cleared.body)}`).toBe(
        200,
      );
    }

    await server.advanceClock(6 * MINUTE);
    const before = await stored();
    for (const [name, value] of DESTINATION) {
      const answer = await call(token, "PATCH", "/config", { [name]: value });
      expectChallenged(answer, name);
      await expectMatchesSchema("PATCH", "/config", 401, answer.body);
    }
    expect(await stored()).toEqual(before);
    // The witness: the same token still changes a setting that says nothing of where files go.
    const kept = await call(token, "PATCH", "/config", {
      trash_retention_days: 30,
    });
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
  });
});

describe("the private socket", () => {
  it("changes where files and backups go with no sign-in", async () => {
    await server.advanceClock(6 * MINUTE);
    for (const [name, value] of DESTINATION) {
      await setLocally({ [name]: value });
      expect((await stored())[name], name).toEqual(value);
      await setLocally({ [name]: null });
      expect(await stored(), name).not.toHaveProperty(name);
    }
  });
});

describe("the object store's secret", () => {
  it("is removed by a write that changes object_store_bucket or object_store_endpoint without setting it, and kept through any other change", async () => {
    const store = {
      object_store_bucket: "a-bucket",
      object_store_endpoint: "http://127.0.0.1:9",
      object_store_access_key_id: "an-access-key",
    };
    await setLocally({
      ...store,
      backup_path: null,
      [SECRET]: `first-${randomUUID()}`,
    });
    expect(await secretSet()).toBe(true);

    // The witness: changes that leave the bucket and endpoint as they are keep it.
    for (const changes of [
      { object_store_region: "eu-west-2" },
      { object_store_prefix: "elsewhere" },
      { object_store_path_style: false },
      { object_store_access_key_id: "another-access-key" },
      { object_store_endpoint: "http://127.0.0.1:9/" },
    ]) {
      await setLocally(changes);
      expect(await secretSet(), JSON.stringify(changes)).toBe(true);
    }
    const whole = await call(
      await approvedAppToken(server, ["config.manage"]),
      "PUT",
      "/config",
      await stored(),
    );
    expect(whole.status, JSON.stringify(whole.body)).toBe(200);
    expect(await secretSet()).toBe(true);

    await setLocally({ object_store_endpoint: "http://127.0.0.1:10" });
    expect(await secretSet()).toBe(false);
    expect((await stored()).object_store_access_key_id).toBe(
      "another-access-key",
    );

    await setLocally({
      object_store_endpoint: "http://127.0.0.1:9",
      [SECRET]: `second-${randomUUID()}`,
    });
    expect(await secretSet()).toBe(true);
    await setLocally({ object_store_bucket: "b-bucket" });
    expect(await secretSet()).toBe(false);

    await setLocally({ [SECRET]: `third-${randomUUID()}` });
    const left = await local(
      "PUT",
      "/config",
      without(await stored(), "object_store_endpoint"),
    );
    expect(left.status, JSON.stringify(left.body)).toBe(200);
    expect(await stored()).not.toHaveProperty("object_store_endpoint");
    expect(await secretSet()).toBe(false);
  });
});
