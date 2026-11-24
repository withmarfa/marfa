import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stageLogs } from "./stage-logs.js";
import { tempFolder } from "./temp-folder.js";

const CODE = "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE";
const NOTICE = `{"message":"Claim this Marfa at /setup with setup code: ${CODE}. Or open this link, which works once, for 5 minutes: http://127.0.0.1:1/setup#handoff=0f9a1b"}`;

describe("stageLogs", () => {
  it("copies each log of a state directory without the setup proof, and nothing else", () => {
    const state = tempFolder("marfa-stage-state-");
    const to = tempFolder("marfa-stage-to-");
    mkdirSync(join(state, "fresh-server-logs", "nested"), { recursive: true });
    writeFileSync(join(state, "server.log"), `${NOTICE}\nlistening\n`);
    writeFileSync(join(state, "server.stderr"), `warning ${NOTICE}\n`);
    writeFileSync(join(state, "fresh-server-logs", "one.log"), NOTICE);
    writeFileSync(
      join(state, "fresh-server-logs", "nested", "two.log"),
      NOTICE,
    );
    writeFileSync(join(state, "marfa.db"), `not a log ${CODE}`);

    // The witness: every source holds the proof.
    for (const source of ["server.log", "server.stderr"]) {
      expect(readFileSync(join(state, source), "utf8")).toContain(CODE);
    }
    const written = stageLogs(state, to).sort();

    expect(written).toEqual([
      "fresh-server-logs/nested/two.log",
      "fresh-server-logs/one.log",
      "server.log",
      "server.stderr",
    ]);
    expect(readdirSync(to).sort()).toEqual([
      "fresh-server-logs",
      "server.log",
      "server.stderr",
    ]);
    for (const name of written) {
      const copy = readFileSync(join(to, name), "utf8");
      expect(copy.includes(CODE), `${name} still holds the code`).toBe(false);
      expect(copy.includes("0f9a1b"), `${name} still holds the ticket`).toBe(
        false,
      );
      expect(copy).toContain("[redacted]");
    }
    expect(readFileSync(join(to, "server.log"), "utf8")).toContain("listening");
  });

  it("stages nothing from a state directory that has no log", () => {
    expect(
      stageLogs(tempFolder("marfa-stage-empty-"), tempFolder("marfa-stage-")),
    ).toEqual([]);
  });
});
