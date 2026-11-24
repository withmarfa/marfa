import { spawnSync } from "node:child_process";
import { chmodSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { tempFolder } from "../conformance/src/utils/temp-folder.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = [
  "scripts/check-image.sh",
  "scripts/release/boot-server.sh",
  "scripts/release/install-proof.sh",
];
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
          /docker logs|journalctl|tail -n 40 "\$HOME|tail -40 "\$state\/log"|cat "\$work\/install\.log"|server status .*tail|echo "\$body"/.test(
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

const NOTICE = LOG.split("\n").slice(0, 2).join("\n");

describe("a failure path that prints a log", () => {
  it("boot-server.sh prints the server's log without its setup proof when the server ends early", () => {
    const folder = tempFolder("marfa-boot-proof-");
    const server = join(folder, "marfa-server");
    writeFileSync(server, `#!/bin/sh\ncat <<'END'\n${NOTICE}\nEND\nexit 1\n`);
    chmodSync(server, 0o755);
    const run = spawnSync(
      "bash",
      [join(ROOT, "scripts/release/boot-server.sh"), server],
      {
        encoding: "utf8",
      },
    );
    const output = run.stdout + run.stderr;
    expect(run.status).toBe(1);
    // The witness: the failure printed the log, and only the proof is gone.
    expect(output).toContain("setup code: [redacted]");
    expect(output.includes(CODE), "the output holds the code").toBe(false);
    expect(output.includes("0f9a1b"), "the output holds the ticket").toBe(
      false,
    );
  });

  it("install-proof.sh prints a status it cannot read without its setup proof", () => {
    const script = text("scripts/release/install-proof.sh");
    const functions = ["redact_setup_proof", "holds"].map(
      (name) =>
        new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}$`, "m").exec(script)?.[0],
    );
    expect(functions.every((one) => one !== undefined)).toBe(true);
    const run = spawnSync(
      "bash",
      [
        "-c",
        `${functions.join("\n")}\nfail() { echo "failed: $1"; }\nversion=1 address=a\nholds '.running' 'not running'`,
      ],
      { input: `not json: ${NOTICE}`, encoding: "utf8" },
    );
    expect(run.stdout).toContain("failed: not running");
    expect(run.stdout).toContain("setup code: [redacted]");
    expect(run.stdout.includes(CODE), "the output holds the code").toBe(false);
    expect(run.stdout.includes("0f9a1b"), "the output holds the ticket").toBe(
      false,
    );
  });
});

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: { path?: string };
}

describe("the server logs a workflow uploads", () => {
  const folder = join(ROOT, ".github/workflows");
  for (const file of readdirSync(folder).filter((name) =>
    name.endsWith(".yml"),
  )) {
    const workflow = parse(readFileSync(join(folder, file), "utf8")) as {
      jobs: Record<string, { steps?: Step[] }>;
    };
    for (const [id, job] of Object.entries(workflow.jobs)) {
      const steps = job.steps ?? [];
      steps.forEach((step, at) => {
        if (!step.uses?.startsWith("actions/upload-artifact")) return;
        const paths = (step.with?.path ?? "")
          .split("\n")
          .map((one) => one.trim());
        const raw = paths.filter((path) =>
          /server\.(log|stderr)$|fresh-server-logs/.test(path),
        );
        it(`${file}:${id}:${step.name ?? "unnamed"} uploads no log a server wrote itself`, () => {
          expect(raw).toEqual([]);
        });
        const staged = paths.filter((path) => /\/server-logs\/?$/.test(path));
        if (staged.length === 0) return;
        it(`${file}:${id}:${step.name ?? "unnamed"} uploads the copy the step before it staged`, () => {
          const before = steps[at - 1]?.run ?? "";
          expect(before).toMatch(
            /marfa:stage-logs .*--to "\$RUNNER_TEMP\/server-logs"/,
          );
        });
      });
    }
  }
});
