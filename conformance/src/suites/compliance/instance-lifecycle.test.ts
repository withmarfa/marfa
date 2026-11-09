import { controlRequest } from "../../utils/control-request.js";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { request } from "node:http";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  approvedAppToken,
  bootFreshServer,
  bootRefused,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { listened, settingLines } from "../../utils/refused-boot.js";
import { TEST_OWNER } from "../../utils/target.js";
import {
  bootControlServer,
  stopServer,
} from "../../../scripts/marfa-server.js";

/**
 * What an instance does when it starts and when it stops: the instance
 * chapter's `instance/image-*`, `instance/stop-*` and `instance/salt-*` rules,
 * and the settings it refuses at boot.
 *
 * Every body here boots a server of its own, because the subject is the
 * process: how it ends and what it does with a start it will not make. The
 * run's shared server answers none of that.
 */

/** The longest a stop may take, by the contract (`instance/stop-within-eight`). */
const STOP_WITHIN_MS = 8_000;

const NOTE = "core.note";

/** Writes `count` notes and answers their ids. A fresh server's working key
 *  writes under the label it was booted with. */
async function writeNotes(
  server: FreshServer,
  source: string,
  count: number,
  tag = "",
): Promise<string[]> {
  const client = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const note = await client.createItem({
      type: NOTE,
      source,
      properties: { body: `${tag} ${String(i)}` },
    });
    expect(note.status, JSON.stringify(note.error)).toBe(201);
    ids.push(note.data.item.id);
  }
  return ids;
}

describe("the exit status of a stop", () => {
  let server: FreshServer;

  beforeAll(async () => {
    server = await bootFreshServer("lifecycle-exit");
  }, FRESH_SERVER_TIMEOUT_MS);

  it.each(["SIGTERM", "SIGINT"] as const)(
    "exits with status 0 within eight seconds when stopped on %s",
    async (signal) => {
      await writeNotes(server, "lifecycle-exit", 3, signal);

      const stopped = await server.restart({ signal });

      expect(stopped).toMatchObject({ code: 0, signal: null });
      expect(stopped.ms).toBeLessThan(STOP_WITHIN_MS);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "exits with status 0 within eight seconds when stopped with an event stream open",
    async () => {
      const response = await fetch(`${server.apiUrl}/events`, {
        headers: { Authorization: `Bearer ${server.workingKey}` },
      });
      expect(response.status).toBe(200);
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let text = "";
      // The stream was live, so the stop had something to end.
      while (!text.includes("event: stream_live")) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        text += decoder.decode(chunk.value, { stream: true });
      }

      const stopped = await server.restart();
      await reader.cancel().catch(() => undefined);

      expect(stopped).toMatchObject({ code: 0, signal: null });
      expect(stopped.ms).toBeLessThan(STOP_WITHIN_MS);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "exits with status 1, not 0, when a request in flight is still open at the end of the stop's wait",
    async () => {
      // A body that never ends: the request is in flight at the signal and
      // does not finish, so the server cannot close within its own bound.
      const open = request(`${server.apiUrl}/items`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${server.workingKey}`,
          "Content-Type": "application/json",
          "Transfer-Encoding": "chunked",
          Expect: "100-continue",
        },
      });
      open.on("error", () => undefined);
      // The server writes `100 Continue` as it hands the request to the
      // application, so the request is in flight once this arrives.
      await new Promise<void>((resolve, reject) => {
        open.once("continue", resolve);
        open.once("error", reject);
        open.flushHeaders();
      });
      open.write('{"type":"core.note",');

      const stopped = await server.restart();
      open.destroy();

      expect(stopped).toMatchObject({ code: 1, signal: null });
      expect(stopped.ms).toBeLessThan(STOP_WITHIN_MS);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("starting on an image a crash leaves", () => {
  let server: FreshServer;

  beforeAll(async () => {
    server = await bootFreshServer("lifecycle-crash");
  }, FRESH_SERVER_TIMEOUT_MS);

  it(
    "answers every write acknowledged before the process was killed, and every blob they name",
    async () => {
      const client = new MarfaClient({
        baseUrl: server.apiUrl,
        apiKey: server.workingKey,
      });
      const acknowledged: { id: string; hash: string; bytes: Uint8Array }[] =
        [];
      let running = true;
      // Written until the process is gone, so the kill lands mid-write.
      const writer = (async () => {
        while (running) {
          const bytes = randomBytes(2_000 + acknowledged.length);
          const upload = await client.uploadBlob(
            bytes,
            "application/octet-stream",
          );
          if (!upload.ok) return;
          const note = await client.createItem({
            type: NOTE,
            source: "lifecycle-crash",
            properties: { body: `![bytes](${upload.data.hash})` },
          });
          if (!note.ok) return;
          acknowledged.push({
            id: note.data.item.id,
            hash: upload.data.hash,
            bytes,
          });
        }
      })();
      while (acknowledged.length < 30) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const killed = await server.restart({ signal: "SIGKILL" });
      running = false;
      await writer;
      // The witness that this was a crash and not a stop: no status.
      expect(killed).toMatchObject({ code: null, signal: "SIGKILL" });

      expect((await fetch(`${server.apiUrl}/health`)).status).toBe(200);
      const restored = new MarfaClient({
        baseUrl: server.apiUrl,
        apiKey: server.workingKey,
      });
      expect(acknowledged.length).toBeGreaterThanOrEqual(30);
      for (const written of acknowledged) {
        expect((await restored.getItem(written.id)).status).toBe(200);
        const blob = await restored.downloadBlob(written.hash);
        expect(blob.ok).toBe(true);
        if (blob.ok) {
          expect(
            Buffer.from(blob.data).equals(Buffer.from(written.bytes)),
          ).toBe(true);
        }
      }
      const next = await restored.createItem({
        type: NOTE,
        source: "lifecycle-crash",
        properties: { body: "written after the restore" },
      });
      expect(next.status).toBe(201);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});

describe("starting on a data directory with another MARFA_KEY_SALT", () => {
  const OTHER_SALT = "another-salt-".padEnd(40, "x");
  let server: FreshServer;
  let appToken: string;

  beforeAll(async () => {
    server = await bootFreshServer("lifecycle-salt");
    appToken = await approvedAppToken(server);
  }, FRESH_SERVER_TIMEOUT_MS);

  /** What a door answers a credential: the status and the error's code. */
  async function ask(
    path: string,
    credential?: string,
    init: RequestInit = {},
  ): Promise<{ status: number; code?: string }> {
    const response = await fetch(`${server.apiUrl}${path}`, {
      ...init,
      headers: {
        ...(credential === undefined
          ? {}
          : { Authorization: `Bearer ${credential}` }),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    const body = (await response.json().catch(() => ({}))) as {
      error?: { code?: string };
    };
    return { status: response.status, code: body.error?.code };
  }

  it(
    "refuses the working key, the management key and an app's access token with 401 unauthorized, and accepts all three again under the original salt",
    async () => {
      const doors = [
        {
          who: "working key",
          path: "/items?limit=1",
          credential: () => server.workingKey,
        },
        {
          who: "management key",
          path: "/keys",
          credential: () => server.managementKey,
        },
        {
          who: "app token",
          path: "/items?limit=1",
          credential: () => appToken,
        },
      ];
      // The witness: each credential opens its door under the salt it was
      // minted under.
      for (const door of doors) {
        expect(await ask(door.path, door.credential()), door.who).toMatchObject(
          { status: 200 },
        );
      }

      await server.restart({ env: { MARFA_KEY_SALT: OTHER_SALT } });
      for (const door of doors) {
        expect(await ask(door.path, door.credential()), door.who).toEqual({
          status: 401,
          code: "unauthorized",
        });
      }

      await server.restart();
      for (const door of doors) {
        expect(await ask(door.path, door.credential()), door.who).toMatchObject(
          { status: 200 },
        );
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "keeps the completed claim and offers no setup code or unauthenticated key mint under another MARFA_KEY_SALT",
    async () => {
      const announcements = async (): Promise<number> =>
        (await server.output()).split(
          "Claim this Marfa at /setup with setup code:",
        ).length - 1;
      // The initial unclaimed boot announced setup proof; the claimed restart does not.
      expect(await announcements()).toBe(1);

      await server.restart({ env: { MARFA_KEY_SALT: OTHER_SALT } });
      const minted = await ask("/keys", undefined, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "recovery", source: "recovery" }),
      });

      expect(await announcements()).toBe(1);
      expect(
        (await controlRequest(server.controlSocket, "/_control/setup/status"))
          .body.claimed,
      ).toBe(true);
      expect(
        (
          await controlRequest(server.controlSocket, "/_control/setup/code", {
            method: "POST",
            body: {},
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await controlRequest(server.controlSocket, "/_control/setup/claim", {
            method: "POST",
            body: TEST_OWNER,
          })
        ).status,
      ).toBe(409);
      expect(minted).toEqual({ status: 401, code: "unauthorized" });
    },
    FRESH_SERVER_TIMEOUT_MS,
  );
});

it(
  "recovers the existing owner in control-only mode while the public port is taken",
  async () => {
    const server = await bootFreshServer("lifecycle-control-recovery");
    const owner = await controlRequest(server.controlSocket, "/owner");
    expect(owner.status).toBe(200);
    await stopServer({ state: server.stateDir });
    const held = await holdPort();
    try {
      const local = await bootControlServer({
        state: server.stateDir,
        port: held.port,
      });
      const recovered = await controlRequest(
        local.controlSocket,
        "/_control/owner/recover",
        {
          method: "POST",
          body: { password: "new control-only recovery password" },
        },
      );
      expect(recovered.status).toBe(200);
      expect(
        (await controlRequest(local.controlSocket, "/owner")).body,
      ).toEqual(owner.body);
      const signIn = (password: string) =>
        controlRequest(local.controlSocket, "/auth/sign-in/email", {
          method: "POST",
          body: { email: TEST_OWNER.email, password },
        });
      expect((await signIn(TEST_OWNER.password)).status).toBe(401);
      expect((await signIn("new control-only recovery password")).status).toBe(
        200,
      );
      const audits = await controlRequest(
        local.controlSocket,
        "/audit?action=owner.password.recovered",
      );
      expect(audits.status).toBe(200);
      expect(audits.body.data).toHaveLength(1);
    } finally {
      held.server.close();
      await server.stop();
    }
  },
  FRESH_SERVER_TIMEOUT_MS,
);

it(
  "exits with status 1, not 78, when the port it was given is already taken",
  async () => {
    const held = await holdPort();
    const root = mkdtempSync(join(realpathSync(tmpdir()), "marfa-port-taken-"));
    const socket = join(root, "control.sock");
    try {
      const refused = await bootRefused("lifecycle-port-taken", {
        extraEnv: {
          MARFA_PORT: String(held.port),
          MARFA_CONTROL_SOCKET: socket,
        },
      });
      try {
        expect(refused).toMatchObject({ code: 1, signal: null });
        expect(listened(refused)).toBe(false);
        expect(refused.output).toContain("EADDRINUSE");
        expect(existsSync(socket)).toBe(false);
      } finally {
        await refused.stop();
      }
    } finally {
      held.server.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  FRESH_SERVER_TIMEOUT_MS,
);

/** A port something of this process's is listening on. */
function holdPort(): Promise<{ port: number; server: Server }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        port: typeof address === "object" && address ? address.port : 0,
        server,
      });
    });
  });
}

/** Boots with `env`, expects it refused over settings, and answers the
 *  settings' lines after removing the state. */
async function refusedOverSettings(
  env: Record<string, string>,
): Promise<string[]> {
  const refused = await bootRefused("lifecycle-settings", {
    extraEnv: env,
  });
  try {
    // Exit status 1, as for any failure to start that is not a refused database
    // (`instance/upgrade-exit-1`), before anything was opened or listened on.
    expect(refused).toMatchObject({ code: 1, signal: null });
    expect(refused.after).toEqual({
      db: "absent",
      wal: "absent",
      shm: "absent",
    });
    expect(listened(refused)).toBe(false);
    return settingLines(refused);
  } finally {
    await refused.stop();
  }
}

describe("starting with a setting outside its rule", () => {
  // One step outside each rule, for a kind of rule apiece.
  const OUTSIDE: [string, string, string, string][] = [
    [
      "MARFA_CONNECTOR_HOLD_MS",
      "a count below its minimum",
      "999",
      'MARFA_CONNECTOR_HOLD_MS must be a whole number, from 1000 to 3600000 (got "999")',
    ],
    [
      "MARFA_AUDIT_RETENTION_DAYS",
      "a count above its maximum",
      "36501",
      'MARFA_AUDIT_RETENTION_DAYS must be a whole number, from 0 to 36500 (got "36501")',
    ],
    [
      "MARFA_EVENT_LOG_RETENTION_HOURS",
      "not a number",
      "soon",
      'MARFA_EVENT_LOG_RETENTION_HOURS must be a whole number, from 0 to 876000 (got "soon")',
    ],
    [
      "MARFA_ENRICHMENT_ENABLED",
      "not a boolean",
      "maybe",
      'MARFA_ENRICHMENT_ENABLED must be true or false (also 1/0, yes/no, on/off) (got "maybe")',
    ],
    [
      "OTEL_RESOURCE_ATTRIBUTES",
      "a list with a pair that has no value",
      "team",
      'OTEL_RESOURCE_ATTRIBUTES must be comma-separated key=value pairs with percent-encoded values (got "team")',
    ],
    [
      "S3_ENDPOINT",
      "not a URL",
      "nope",
      // An address can carry a credential, so the refusal gives no value.
      "S3_ENDPOINT must be an absolute http or https URL",
    ],
  ];

  // The witness for every refusal below: the largest or smallest value each
  // rule takes, and the cross-field rules at their equal edge, start.
  it(
    "starts with each of those settings one step inside its rule and each cross-field rule at its edge",
    async () => {
      const server = await bootFreshServer("lifecycle-settings-edge", {
        MARFA_CONNECTOR_HOLD_MS: "1000",
        MARFA_AUDIT_RETENTION_DAYS: "36500",
        MARFA_EVENT_LOG_RETENTION_HOURS: "0",
        MARFA_ENRICHMENT_ENABLED: "OFF",
        S3_ENDPOINT: "https://objects.example.test",
        OTEL_RESOURCE_ATTRIBUTES: "team=a%20b",
        // With no bucket the endpoint is parsed and never reached, whatever
        // object store the run's environment names.
        S3_BUCKET: "",
        MARFA_VERSION_RECENT_DAYS: "40",
        MARFA_VERSION_DAILY_SNAPSHOT_DAYS: "40",
        MARFA_VERSION_WEEKLY_SNAPSHOT_DAYS: "40",
        MARFA_AUTH_SECRET: "x".repeat(32),
      });

      try {
        expect((await fetch(`${server.apiUrl}/health`)).status).toBe(200);
      } finally {
        await server.stop();
      }
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it.each(OUTSIDE)(
    "refuses to start with status 1, naming %s and no other setting, when it is %s",
    async (name, _kind, value, line) => {
      expect(await refusedOverSettings({ [name]: value })).toEqual([line]);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "names every setting that is outside its rule in one refusal",
    async () => {
      const lines = await refusedOverSettings(
        Object.fromEntries(OUTSIDE.map(([name, , value]) => [name, value])),
      );

      expect([...lines].sort()).toEqual(
        OUTSIDE.map(([, , , line]) => line).sort(),
      );
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "refuses a secret with whitespace around it without printing it, where it prints the value of a setting that is not one",
    async () => {
      const secret = "padded-secret-value";

      const lines = await refusedOverSettings({
        S3_SECRET_ACCESS_KEY: ` ${secret} `,
        MARFA_CONNECTOR_HOLD_MS: "999",
      });

      expect([...lines].sort()).toEqual(
        [
          'MARFA_CONNECTOR_HOLD_MS must be a whole number, from 1000 to 3600000 (got "999")',
          "S3_SECRET_ACCESS_KEY has whitespace around it, which would be part of the secret; remove it",
        ].sort(),
      );
      expect(lines.join("\n")).not.toContain(secret);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "refuses a MARFA_AUTH_SECRET of 31 characters, without printing it",
    async () => {
      const secret = "y".repeat(31);

      const lines = await refusedOverSettings({ MARFA_AUTH_SECRET: secret });

      expect(lines).toEqual([
        "MARFA_AUTH_SECRET must be at least 32 characters; generate one with `openssl rand -hex 32`",
      ]);
      expect(lines.join("\n")).not.toContain(secret);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  const disagreeing: [string, Record<string, string>, string][] = [
    [
      "MARFA_VERSION_DAILY_SNAPSHOT_DAYS",
      {
        MARFA_VERSION_RECENT_DAYS: "40",
        MARFA_VERSION_DAILY_SNAPSHOT_DAYS: "39",
      },
      'MARFA_VERSION_DAILY_SNAPSHOT_DAYS must be at least MARFA_VERSION_RECENT_DAYS (got "39")',
    ],
    [
      "MARFA_VERSION_WEEKLY_SNAPSHOT_DAYS",
      {
        MARFA_VERSION_DAILY_SNAPSHOT_DAYS: "100",
        MARFA_VERSION_WEEKLY_SNAPSHOT_DAYS: "99",
      },
      'MARFA_VERSION_WEEKLY_SNAPSHOT_DAYS must be at least MARFA_VERSION_DAILY_SNAPSHOT_DAYS (got "99")',
    ],
  ];

  it.each(disagreeing)(
    "refuses to start with status 1, naming %s, when each setting is inside its own rule and the two disagree",
    async (_name, env, line) => {
      expect(await refusedOverSettings(env)).toEqual([line]);
    },
    FRESH_SERVER_TIMEOUT_MS,
  );

  it(
    "names only the setting outside its rule, and holds back the cross-field rule until every setting parses",
    async () => {
      const [, disagreement, disagreementLine] = disagreeing[0]!;
      const [name, , value, line] = OUTSIDE[0]!;

      // The witness: the disagreement is reported when it is the only fault.
      expect(await refusedOverSettings(disagreement)).toEqual([
        disagreementLine,
      ]);

      // A setting outside its rule that the comparison does not read.
      expect(
        await refusedOverSettings({ ...disagreement, [name]: value }),
      ).toEqual([line]);

      // One of the two settings the comparison reads.
      expect(
        await refusedOverSettings({
          ...disagreement,
          MARFA_VERSION_RECENT_DAYS: "soon",
        }),
      ).toEqual([
        'MARFA_VERSION_RECENT_DAYS must be a whole number, from 0 to 36500 (got "soon")',
      ]);
    },
    2 * FRESH_SERVER_TIMEOUT_MS,
  );
});
