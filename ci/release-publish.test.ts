/**
 * `npm publish` reads its argument as a package spec before it reads it as a
 * file. A bare `dir/name.tgz` is GitHub shorthand for the repository `name.tgz`
 * of the user `dir`, so npm tries to clone it over SSH and the publish fails
 * with nothing sent. A tarball has to be named as a path, `./dir/name.tgz`.
 */
import { readdirSync, readFileSync } from "node:fs";
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
  jobs?: Record<string, { steps?: { run?: unknown }[] }>;
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
