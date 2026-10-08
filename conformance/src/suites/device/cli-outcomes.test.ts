import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { Cli } from "../cli/harness.js";
import { keychainEnv } from "../../utils/keychain.js";
import { answers, refusal, wireItem } from "../../device/marfa-answers.js";
import { newStore } from "../../device/cli-adapter.js";
import {
  hydratedHarness,
  KEY,
  requireBinary,
  scriptWrites,
  type Harness,
} from "./harness.js";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});
const id = "01a00000-0000-7000-8000-00000000000a";
async function prepared() {
  harness = await hydratedHarness("cli-outcomes", {
    rows: {
      "core.note": [
        {
          item: { id, version: 3, properties: { title: "held", body: "held" } },
        },
      ],
    },
  });
  expect(
    (
      await harness.device.update(id, {
        properties: { title: "edit" },
        version: 3,
      })
    ).ok,
  ).toBe(true);
  return { ...harness, cli: new Cli(requireBinary(), harness.server.url, KEY) };
}

const drainOutcomes = [
  {
    label: "unavailable",
    answer: { kind: "drop" as const },
    exit: 3,
    verdict: null,
  },
  {
    label: "credential stopped",
    answer: answers.unauthorized(),
    exit: 5,
    verdict: "blocked",
  },
] as const;

describe("CLI outcomes preserve the result", () => {
  it.each([
    ["--reader", "queue"],
    ["changes", "--for", "0"],
  ])("reports an absent reading store: %j", async (...args) => {
    const store = newStore("absent-reader");
    const cli = new Cli(requireBinary(), "http://127.0.0.1:1", KEY);
    const result = await cli.run(["--json", "device", "--db", store, ...args]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr).error.code).toBe("no_store");
    expect(existsSync(store)).toBe(false);
    writeFileSync(store, "not SQLite");
    const corrupt = await cli.run(["--json", "device", "--db", store, ...args]);
    expect(corrupt.code).not.toBe(2);
    expect(JSON.parse(corrupt.stderr).error.code).not.toBe("no_store");
  });

  it.each(drainOutcomes)(
    "keeps the complete $label drain report with exit $exit",
    async ({ answer, exit, verdict }) => {
      const h = await prepared();
      const before = await h.device.queue();
      scriptWrites(h.server, { update: [answer] });
      const result = await h.cli.run([
        "--json",
        "device",
        "--db",
        h.device.store,
        "drain",
      ]);
      expect(result.code).toBe(exit);
      expect(result.stderr).toBe("");
      const report = JSON.parse(result.stdout);
      expect(report.verdicts[0].verdict).toBe(verdict);
      expect(report.verdicts[0].refusals).toBe(0);
      expect(exit === 3 ? report.unavailable : report.stopped).toBeTruthy();
      const after = await h.device.queue();
      expect(
        after.ok && before.ok && after.value[0]?.id === before.value[0]?.id,
      ).toBe(true);
    },
  );

  it.each(["/next", null])(
    "preserves a redirected queued write without following %s",
    async (location) => {
      const h = await prepared();
      const before = await h.device.queue();
      scriptWrites(h.server, {
        update: [
          {
            kind: "json",
            status: 307,
            body: {},
            contract: "999999",
            headers: location ? { Location: location } : {},
          },
        ],
      });
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const result = await h.cli.run([
          "--json",
          "device",
          "--db",
          h.device.store,
          "drain",
        ]);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        const error = JSON.parse(result.stderr).error;
        expect(error.code).toBe("redirect");
        expect(error.server.status).toBe(307);
        expect(error.message).toContain(h.server.url);
        expect(error.message).toContain(location ?? "nowhere it named");
        expect(await h.device.queue()).toEqual(before);
      }
      expect(
        h.server.requests.filter((request) => request.pathname === "/next"),
      ).toHaveLength(0);
    },
  );

  it("preserves answered writes before an interrupted later write", async () => {
    const h = await prepared();
    expect(
      (
        await h.device.create({
          type: "core.note",
          properties: { title: "later", body: "later" },
        })
      ).ok,
    ).toBe(true);
    scriptWrites(h.server, {
      update: [
        answers.updated(
          wireItem({
            id,
            version: 4,
            properties: { title: "edit", body: "held" },
          }),
        ),
      ],
      read: [
        answers.updated(
          wireItem({
            id,
            version: 4,
            properties: { title: "edit", body: "held" },
          }),
        ),
      ],
      create: [{ kind: "drop" }],
    });
    const result = await h.cli.run([
      "--json",
      "device",
      "--db",
      h.device.store,
      "drain",
    ]);
    expect(result.code).toBe(3);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout);
    expect(report.answered).toBe(1);
    expect(report.undelivered).toBe(1);
    expect(
      report.verdicts.map((write: { verdict: string | null }) => write.verdict),
    ).toEqual(["accepted", null]);
  });

  it("exits 3 for a pass the server could not finish that left nothing undelivered", async () => {
    const h = await prepared();
    const edited = wireItem({
      id,
      version: 4,
      properties: { title: "edit", body: "held" },
    });
    scriptWrites(h.server, {
      update: [answers.updated(edited)],
      read: [{ kind: "drop" }],
    });
    const result = await h.cli.run([
      "--json",
      "device",
      "--db",
      h.device.store,
      "drain",
    ]);
    expect(result.code, JSON.stringify(result)).toBe(3);
    const report = JSON.parse(result.stdout);
    expect([report.answered, report.undelivered]).toEqual([1, 0]);
    expect(report.unavailable).toBeTruthy();
  });

  it("exits 3 for a write left undelivered by a pass the server finished", async () => {
    harness = await hydratedHarness("cli-outcomes-undelivered", { rows: {} });
    const cli = new Cli(requireBinary(), harness.server.url, KEY);
    const path = `${harness.device.store}.locked`;
    writeFileSync(path, "held and locked for now\n");
    const queued = await harness.device.putBlob(path, "text/plain");
    if (!queued.ok) throw new Error(JSON.stringify(queued));
    const heldAt = `${harness.device.store}.blobs/${(queued.value.blob ?? "").slice("sha256:".length)}`;
    chmodSync(heldAt, 0o000);
    try {
      const result = await cli.run([
        "--json",
        "device",
        "--db",
        harness.device.store,
        "drain",
      ]);
      expect(result.code, JSON.stringify(result)).toBe(3);
      const report = JSON.parse(result.stdout);
      expect([report.undelivered, report.unavailable]).toEqual([1, null]);
    } finally {
      chmodSync(heldAt, 0o644);
    }
  });

  it("reports completed refusals separately and keeps exit zero", async () => {
    const h = await prepared();
    scriptWrites(h.server, {
      update: [answers.validation("validation_error", "The edit is invalid")],
      read: [
        answers.updated(
          wireItem({
            id,
            version: 3,
            properties: { title: "held", body: "held" },
          }),
        ),
      ],
    });
    const result = await h.cli.run(["device", "--db", h.device.store, "drain"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("refused 1 write(s)");
  });
});

/**
 * A drain under a token the binary renews when the server refuses it `401`.
 * The token is kept in the run's own keychain file, which exists only where
 * there are keychain files.
 */
describe.runIf(process.platform === "darwin")("a renewal a drain meets", () => {
  async function renewing(tokenAnswer: ReturnType<typeof refusal>) {
    const h = await prepared();
    const later = await h.device.create({
      type: "core.note",
      properties: { title: "later", body: "preserve this" },
    });
    expect(later.ok).toBe(true);
    const before = await h.device.queue();
    if (!before.ok) throw new Error("queue refused");
    const edited = wireItem({
      id,
      version: 4,
      properties: { title: "edit", body: "held" },
    });
    scriptWrites(h.server, {
      update: [answers.updated(edited)],
      read: [answers.updated(edited)],
      create: [answers.unauthorized()],
    });
    h.server.answer("POST", "/token", tokenAnswer);
    const keychain = keychainEnv().MARFA_KEYCHAIN!;
    execFileSync("security", [
      "add-generic-password",
      "-A",
      "-s",
      "marfa",
      "-a",
      h.server.url,
      "-w",
      JSON.stringify({
        kind: "token",
        access_token: "marfa_at_fixture",
        refresh_token: "marfa_rt_fixture",
        expires_at: null,
        client_id: "fixture",
        scope: "*:read",
        token_endpoint: `${h.server.url}/token`,
        revocation_endpoint: null,
      }),
      keychain,
    ]);
    try {
      const result = await h.cli
        .as(undefined)
        .run(["--json", "device", "--db", h.device.store, "drain"]);
      expect(
        h.server.requests.filter((request) => request.pathname === "/token"),
        "the binary did not try to renew the token the server refused",
      ).toHaveLength(1);
      return { h, before: before.value, result };
    } finally {
      try {
        execFileSync(
          "security",
          [
            "delete-generic-password",
            "-s",
            "marfa",
            "-a",
            h.server.url,
            keychain,
          ],
          { stdio: "ignore" },
        );
      } catch {
        // A renewal the server refused has already let the token go.
      }
    }
  }

  it("ends the drain on a renewal that ends locally, keeping the answers before it and the write it met", async () => {
    const { h, before, result } = await renewing(
      answers.validation("invalid_grant", "fixture ended"),
    );
    expect(result.code, JSON.stringify(result)).toBe(5);
    expect(result.stdout).toBe("");
    const envelope = JSON.parse(result.stderr);
    expect(envelope.error.code).toBe("signed_out");
    expect(envelope.error.server).toBeNull();
    const after = await h.device.queue();
    if (!after.ok) throw new Error("queue refused");
    expect(after.value[0]?.verdict).toBe("accepted");
    expect(after.value[0]?.answered_at).toBeTruthy();
    expect(
      after.value[1],
      "the write the renewal met was given a verdict, counted or changed",
    ).toEqual(before[1]);
    expect([after.value[1]?.verdict, after.value[1]?.refusals]).toEqual([
      null,
      0,
    ]);
    const first = await h.device.get(id);
    expect(first.ok && first.value.version).toBe(4);
  });

  it("takes a renewal the network stopped as an environmental failure, counting nothing", async () => {
    const { h, before, result } = await renewing(
      refusal(503, "unavailable", "The token endpoint is down"),
    );
    expect(result.code, JSON.stringify(result)).toBe(3);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout);
    expect(report.unavailable).toBeTruthy();
    expect(report.stopped).toBeNull();
    expect([report.answered, report.undelivered]).toEqual([1, 1]);
    const after = await h.device.queue();
    if (!after.ok) throw new Error("queue refused");
    expect(after.value[0]?.verdict).toBe("accepted");
    expect(
      after.value[1],
      "the write a renewal the network stopped met was given a verdict, counted or changed",
    ).toEqual(before[1]);
  });
});
