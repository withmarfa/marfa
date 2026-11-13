import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { controlRequest } from "../../utils/control-request.js";
import { Cli, requireBinary } from "./harness.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import { DISK_ONLY } from "../../utils/own-blob-server.js";

let server: FreshServer;
let local: Cli;
// A backup folder, so that an instance with nothing to report has a place to
// put its backups, and the empty list below is the whole of what it checks.
const backups = mkdtempSync(join(tmpdir(), "marfa-cli-attention-"));
beforeAll(async () => {
  server = await bootFreshServer("cli-attention", {
    ...DISK_ONLY,
    MARFA_BACKUP_PATH: backups,
    MARFA_BACKUP_INTERVAL_SECONDS: "31536000",
  });
  vi.stubEnv("MARFA_API_URL", server.apiUrl);
  local = new Cli(
    requireBinary(),
    server.apiUrl,
    undefined,
    server.controlSocket,
  );
}, FRESH_SERVER_TIMEOUT_MS);
afterAll(async () => {
  await server?.stop();
  rmSync(backups, { recursive: true, force: true });
  vi.unstubAllEnvs();
}, FRESH_SERVER_TIMEOUT_MS);

interface Concern {
  kind: string;
  reference: string;
  title: string;
  description: string;
}
interface Inventory {
  data: Concern[];
}
const DAY_MS = 86_400_000;

const mint = (label: string, expiresIn: string) =>
  local.json<{ id: string; key: string }>([
    "keys",
    "create",
    "--label",
    label,
    "--source",
    `attention-${label.toLowerCase().replace(/\W+/g, "-")}`,
    "--type-permission",
    "core.note=write",
    "--expires-in",
    expiresIn,
  ]);

it("shares private-socket attention, keeps known concerns, and refuses every other credential", async () => {
  expect(await local.json(["attention"])).toEqual({ data: [] });

  const soon = await mint("Ending", "6d");
  const later = await mint("Later", "9d");
  const open = await local.json<Inventory>(["attention"]);
  await expectMatchesSchema("GET", "/attention", 200, open);
  expect(open.data).toEqual([
    expect.objectContaining({ kind: "key", reference: soon.id }),
  ]);
  expect(Object.keys(open.data[0]).sort()).toEqual([
    "description",
    "kind",
    "reference",
    "title",
  ]);

  // A check that cannot answer is one entry naming it, and the others still answer.
  for (const [check, name] of [
    ["health", "Health"],
    ["housekeeping", "Housekeeping"],
    ["connectors", "Connectors"],
    ["folders", "Folders"],
    ["keys", "API keys"],
  ] as const) {
    await server.setFault(`fail:attention=${check}`);
    try {
      const incomplete = await local.json<Inventory>(["attention"]);
      expect(incomplete.data).toContainEqual(
        expect.objectContaining({ kind: "unavailable", reference: name }),
      );
      expect(
        incomplete.data.filter((concern) => concern.kind === "unavailable"),
      ).toHaveLength(1);
      expect(
        incomplete.data.some((concern) => concern.reference === soon.id),
      ).toBe(check !== "keys");
    } finally {
      await server.clearFault();
    }
  }

  // A check that does not answer in time is the same entry.
  await server.setFault("hold:attention=connectors");
  try {
    const slow = await local.json<Inventory>(["attention"]);
    expect(slow.data).toContainEqual(
      expect.objectContaining({ kind: "unavailable", reference: "Connectors" }),
    );
    expect(slow.data).toContainEqual(
      expect.objectContaining({ kind: "key", reference: soon.id }),
    );
  } finally {
    await server.clearFault();
  }

  await server.setFault("free:blobs=0");
  try {
    const impaired = await local.json<Inventory>(["attention"]);
    expect(impaired.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "health", reference: "disk" }),
        expect.objectContaining({ kind: "key", reference: soon.id }),
      ]),
    );
  } finally {
    await server.clearFault();
  }

  const query = await controlRequest(server.controlSocket, "/attention?x=1");
  expect(query.status).toBe(400);

  // Neither a browser session nor a missing credential reaches the public door.
  expect((await fetch(`${server.apiUrl}/attention`)).status).toBe(401);
  const cookie = await fetch(`${server.apiUrl}/attention`, {
    headers: { cookie: server.ownerCookie, origin: server.apiUrl },
  });
  expect(cookie.status).toBe(401);
  for (const credential of [server.workingKey, server.managementKey]) {
    const refused = await new Cli(
      requireBinary(),
      server.apiUrl,
      credential,
    ).refused(["attention"]);
    expect(refused.envelope.error.code).toBe("forbidden");
    expect(refused.envelope.error.server?.details).toEqual({ needs: "local" });
  }

  // A folder with a conflict reported by a current sign-in.
  const writer = new Cli(requireBinary(), server.apiUrl, server.workingKey);
  const folder = await writer.json<{ item: { id: string } }>([
    "folders",
    "create",
    "--title",
    "Sync concern",
  ]);
  const report = await fetch(
    `${server.apiUrl}/folders/${folder.item.id}/status`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${server.workingKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        folder_store_id: "copy",
        sequence: 1,
        last_success_at: null,
        pending_uploads: 0,
        pending_downloads: 0,
        paused_removals: 0,
        first_sync_waiting: false,
        problems: [{ code: "conflict", count: 1 }],
      }),
    },
  );
  expect(report.status).toBe(200);

  // A job whose last run failed.
  await server.setFault("fail:housekeeping:audit-cleanup");
  try {
    const ended = await local.json(["housekeeping", "run", "audit-cleanup"]);
    expect(ended).toMatchObject({ name: "audit-cleanup", outcome: "error" });
  } finally {
    await server.clearFault();
  }

  // A connector that failed its last run, one that reports problems, and one that went quiet.
  const connectorOf = async (label: string) => {
    const minted = await mint(label, "30d");
    const as = new Cli(requireBinary(), server.apiUrl, minted.key);
    const registered = await as.json<{ id: string }>([
      "connectors",
      "register",
      "--name",
      label,
    ]);
    return { as, id: registered.id };
  };
  const failing = await connectorOf("Failing");
  await failing.as.json([
    "connectors",
    "report",
    "--started-at",
    new Date(Date.now() - 60_000).toISOString(),
    "--finished-at",
    new Date().toISOString(),
    "--outcome",
    "failed",
    "--error",
    "the feed answered 500",
  ]);
  const troubled = await connectorOf("Troubled");
  await troubled.as.json([
    "connectors",
    "hold",
    troubled.id,
    "--process",
    "attention",
  ]);
  await troubled.as.json([
    "connectors",
    "state",
    "put",
    troubled.id,
    "--process",
    "attention",
    "--body",
    "{}",
    "--problems",
    '{"feed":"Feed unavailable"}',
  ]);
  const quiet = await connectorOf("Quiet");

  const concerns = await local.json<Inventory>(["attention"]);
  const byReference = new Map(
    concerns.data.map((concern) => [concern.reference, concern]),
  );
  expect(byReference.get(folder.item.id)).toMatchObject({
    kind: "folder",
    title: "Sync concern needs a look",
  });
  expect(byReference.get("audit-cleanup")).toMatchObject({ kind: "job" });
  expect(byReference.get(failing.id)).toMatchObject({
    kind: "connector",
    description: expect.stringContaining("the feed answered 500"),
  });
  expect(byReference.get(troubled.id)).toMatchObject({
    kind: "connector",
    description: expect.stringContaining("1 problem"),
  });
  expect(byReference.has(quiet.id)).toBe(false);
  await expectMatchesSchema("GET", "/attention", 200, concerns);

  // A revoked folder no longer needs a look.
  await writer.json(["folders", "revoke", folder.item.id]);
  const withoutFolder = await local.json<Inventory>(["attention"]);
  expect(withoutFolder.data.map((concern) => concern.reference)).not.toContain(
    folder.item.id,
  );

  // A day and more with nothing heard makes a connector quiet, and moves the week's window.
  await server.advanceClock(2 * DAY_MS);
  const afterwards = await local.json<Inventory>(["attention"]);
  expect(afterwards.data).toContainEqual(
    expect.objectContaining({
      kind: "connector",
      reference: quiet.id,
      description: expect.stringContaining("more than a day"),
    }),
  );
  expect(
    afterwards.data
      .filter((concern) => concern.kind === "key")
      .map((concern) => concern.reference)
      .sort(),
  ).toEqual([soon.id, later.id].sort());

  // Revoked keys no longer need a look.
  await local.json(["keys", "revoke", soon.id]);
  await local.json(["keys", "revoke", later.id]);
  const revoked = await local.json<Inventory>(["attention"]);
  const references = revoked.data.map((concern) => concern.reference);
  expect(references).not.toContain(soon.id);
  expect(references).not.toContain(later.id);
});

it(
  "tells the owner in plain words that no backups are kept, and how to set one",
  async () => {
    const bare = await bootFreshServer("cli-attention-none", DISK_ONLY);
    try {
      const cli = new Cli(
        requireBinary(),
        bare.apiUrl,
        undefined,
        bare.controlSocket,
      );
      const said = await cli.run(["attention"]);
      expect(said.code, said.stderr).toBe(0);
      expect(said.stdout).toContain("backup  No backups are kept");
      for (const part of [
        "MARFA_BACKUP_PATH",
        "S3_BUCKET",
        "marfa server restart",
      ]) {
        expect(said.stdout, part).toContain(part);
      }
      const listed = await cli.json<Inventory>(["attention"]);
      expect(listed.data).toEqual([
        expect.objectContaining({
          kind: "backup",
          reference: "no_backup_destination",
        }),
      ]);
    } finally {
      await bare.stop();
    }
  },
  FRESH_SERVER_TIMEOUT_MS,
);
