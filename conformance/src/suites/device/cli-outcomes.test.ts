import { existsSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { Cli } from "../cli/harness.js";
import { answers, wireItem } from "../../device/marfa-answers.js";
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
