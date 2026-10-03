/**
 * `npm publish` reads its argument as a package spec before it reads it as a
 * file. A bare `dir/name.tgz` is GitHub shorthand for the repository `name.tgz`
 * of the user `dir`, so npm tries to clone it over SSH and the publish fails
 * with nothing sent. A tarball has to be named as a path, `./dir/name.tgz`.
 */
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const WORKFLOWS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".github",
  "workflows",
);

interface Workflow {
  jobs?: Record<
    string,
    { if?: unknown; steps?: { name?: string; run?: unknown; uses?: string }[] }
  >;
}

interface Publish {
  file: string;
  tarball: string;
}

function publishedTarballs(): Publish[] {
  const found: Publish[] = [];
  for (const file of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))) {
    const workflow = parse(
      readFileSync(join(WORKFLOWS, file), "utf8"),
    ) as Workflow;
    for (const job of Object.values(workflow.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (typeof step.run !== "string") continue;
        for (const match of step.run.matchAll(
          /npm publish\s+("[^"]*"|'[^']*'|\S+)/g,
        )) {
          found.push({
            file,
            tarball: (match[1] ?? "").replace(/^["']|["']$/g, ""),
          });
        }
      }
    }
  }
  return found;
}

describe("a published tarball is named as a path", () => {
  it("finds the release's publish rather than passing over none", () => {
    expect(publishedTarballs().some(({ file }) => file === "release.yml")).toBe(
      true,
    );
  });

  it("names every tarball from ./ or /, so npm reads a file and not a repository", () => {
    for (const { file, tarball } of publishedTarballs()) {
      expect(`${file}: ${tarball}`).toMatch(/^[^:]+: (\.\/|\/)\S+\.tgz$/);
    }
  });
});

const release = parse(
  readFileSync(join(WORKFLOWS, "release.yml"), "utf8"),
) as Workflow;

const version = "0.0.9";
const releaseArtifacts = [
  `marfa-${version}-darwin-arm64.tar.gz`,
  `withmarfa-client-${version}.tgz`,
  `withmarfa-core-${version}.tgz`,
];

function holdArtifacts(names: string[]): void {
  const guard = release.jobs?.build?.steps?.find((step) =>
    step.name?.startsWith("Hold the artifacts"),
  )?.run;
  expect(typeof guard).toBe("string");
  if (typeof guard !== "string") throw new Error("No release artifact guard");
  const directory = mkdtempSync(join(tmpdir(), "marfa-release-artifacts-"));
  try {
    for (const name of names) writeFileSync(join(directory, name), "artifact");
    execFileSync("bash", ["-e", "-c", guard], {
      cwd: directory,
      env: { ...process.env, VERSION: version },
      stdio: "pipe",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("a release carries the binary and two npm packages", () => {
  it("publishes only on a tag push, so a dispatch builds without publishing", () => {
    expect(release.jobs?.publish?.if).toBe("github.event_name == 'push'");
  });

  it("accepts exactly the three product artifacts", () => {
    expect(() => {
      holdArtifacts(releaseArtifacts);
    }).not.toThrow();
  });

  it("refuses an extra Rust-client artifact", () => {
    expect(() => {
      holdArtifacts([...releaseArtifacts, `marfa-client-${version}.crate`]);
    }).toThrow();
  });

  it("refuses a missing product artifact", () => {
    expect(() => {
      holdArtifacts(releaseArtifacts.slice(1));
    }).toThrow();
  });

  it("publishes npm packages without a separate Rust-client path", () => {
    const publish = release.jobs?.publish?.steps;
    expect(publish).toBeDefined();
    const scripts = publish
      ?.map((step) => (typeof step.run === "string" ? step.run : ""))
      .join("\n");
    expect(scripts).toContain("npm publish");
    expect(scripts).toContain("@withmarfa/core @withmarfa/client");
    expect(scripts).not.toMatch(/crates\.io|cargo publish|outputs\.crate/);
    expect(publish?.map((step) => step.uses)).not.toContain(
      "rust-lang/crates-io-auth-action@v1",
    );
  });
});
