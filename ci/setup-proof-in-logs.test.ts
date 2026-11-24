import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = ["scripts/check-image.sh", "scripts/release/install-proof.sh"];
const CODE = "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE";
const LOG = [
  `Claim this Marfa at /setup with setup code: ${CODE}. Or open this link, which works once, for 5 minutes: https://marfa.example/setup#handoff=0f9a1b`,
  `Recover this Marfa's owner at /setup with recovery code: ${CODE}. It works once, for 60 minutes.`,
  "Marfa server listening on port 1",
].join("\n");

const text = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("the logs a failing check prints", () => {
  for (const path of SCRIPTS) {
    const script = text(path);

    it(`${path} defines a filter that removes the setup proof and its link`, () => {
      const filter = /^redact_setup_proof\(\) \{[\s\S]*?^\}$/m.exec(
        script,
      )?.[0];
      expect(filter).toBeDefined();
      const run = spawnSync("bash", ["-c", `${filter!}\nredact_setup_proof`], {
        input: LOG,
        encoding: "utf8",
      });
      expect(run.status).toBe(0);
      expect(run.stdout).not.toContain(CODE);
      expect(run.stdout).not.toContain("0f9a1b");
      expect(run.stdout).toContain("setup code: [redacted]");
      expect(run.stdout).toContain("recovery code: [redacted]");
      expect(run.stdout).toContain("handoff=[redacted]");
      expect(run.stdout).toContain("Marfa server listening on port 1");
    });

    it(`${path} prints no server log or install output but through it`, () => {
      const printing = script
        .split("\n")
        .filter((line) =>
          /docker logs|journalctl|tail -n 40 "\$HOME|cat "\$work\/install\.log"|server status .*tail/.test(
            line,
          ),
        )
        // The refusal check only reads the log for a phrase.
        .filter((line) => !line.includes("grep -q"));
      for (const line of printing)
        expect(line, line).toContain("redact_setup_proof");
    });
  }
});
