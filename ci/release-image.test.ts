/**
 * A release publishes the server image, and nothing about it can leave a
 * version half out. The image is built and booted on a runner of each
 * platform before a tag is spent; a dry run builds and boots the same image
 * and pushes nothing; and the image reaches the registry, and is checked
 * there, before the GitHub release is made public.
 */
import { readFileSync } from "node:fs";
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

interface Step {
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}

interface Job {
  needs?: string | string[];
  if?: string;
  permissions?: Record<string, string>;
  strategy?: { matrix?: { include?: Record<string, string>[] } };
  steps?: Step[];
}

const release = parse(readFileSync(join(WORKFLOWS, "release.yml"), "utf8")) as {
  jobs: Record<string, Job>;
};
const image = release.jobs.image;
const publish = release.jobs.publish;
const imageSteps = image?.steps ?? [];
const publishSteps = publish?.steps ?? [];

const PUSH = "github.event_name == 'push'";

function needs(job: Job | undefined): string[] {
  const named = job?.needs ?? [];
  return Array.isArray(named) ? named : [named];
}

function indexOfStep(steps: Step[], start: string): number {
  const found = steps.findIndex((step) => step.name?.startsWith(start));
  expect(found, `a step named "${start}"`).toBeGreaterThanOrEqual(0);
  return found;
}

describe("the server image in a release", () => {
  it("finds the image job rather than passing over none", () => {
    expect(image).toBeDefined();
    expect(imageSteps.length).toBeGreaterThan(0);
  });

  it("builds each platform on a runner of that platform", () => {
    const matrix = image?.strategy?.matrix?.include ?? [];
    const runners = matrix.map(
      (entry) => `${entry.platform ?? ""} on ${entry.runner ?? ""}`,
    );
    expect(runners).toEqual([
      "linux/amd64 on ubuntu-latest",
      "linux/arm64 on ubuntu-24.04-arm",
    ]);
  });

  it("waits for the version to be read and held to the tag grammar", () => {
    expect(needs(image)).toContain("build");
  });

  it("boots what it built before it pushes anything", () => {
    const built = imageSteps.find((step) =>
      step.uses?.startsWith("docker/build-push-action@"),
    );
    expect(built).toBeDefined();
    expect(built?.with?.load).toBe(true);
    expect(built?.with?.push).toBeUndefined();
    expect(built?.if).toBeUndefined();
    const boot = indexOfStep(imageSteps, "Boot it");
    expect(boot).toBeGreaterThan(imageSteps.indexOf(built!));
    expect(imageSteps[boot]?.run).toContain("scripts/check-image.sh");
  });

  it("logs in and pushes only for a tag, so a dry run pushes nothing", () => {
    const login = imageSteps.filter((step) =>
      step.uses?.startsWith("docker/login-action@"),
    );
    const pushes = imageSteps.filter((step) =>
      JSON.stringify(step.with ?? {}).includes("push=true"),
    );
    // Witness: both kinds of step exist, so the loop below holds something.
    expect(login).toHaveLength(1);
    expect(pushes).toHaveLength(1);
    for (const step of [...login, ...pushes]) {
      expect(step.if, step.name).toBe(PUSH);
    }
    const boot = indexOfStep(imageSteps, "Boot it");
    for (const step of [...login, ...pushes]) {
      expect(imageSteps.indexOf(step)).toBeGreaterThan(boot);
    }
  });

  it("gives the registry token to the image job and the publish job only", () => {
    expect(image?.permissions?.packages).toBe("write");
    expect(publish?.permissions?.packages).toBe("write");
    for (const [name, job] of Object.entries(release.jobs)) {
      if (name === "image" || name === "publish") continue;
      expect(job.permissions?.packages, name).toBeUndefined();
    }
  });

  it("holds the publish job back until every platform's image is pushed", () => {
    expect(needs(publish)).toContain("image");
    expect(publish?.if).toBe(PUSH);
  });

  it("tags the image and checks it as the public sees it before the release is public", () => {
    const tag = indexOfStep(publishSteps, "Tag the server image");
    const verify = indexOfStep(
      publishSteps,
      "Check the published server image",
    );
    const open = indexOfStep(publishSteps, "Make the GitHub release public");
    const draft = indexOfStep(publishSteps, "Draft the GitHub release");
    expect(draft).toBeLessThan(tag);
    expect(tag).toBeLessThan(verify);
    expect(verify).toBeLessThan(open);
    // Signed out, so a package that is still private fails here.
    expect(publishSteps[verify]?.run).toMatch(
      /docker logout ghcr\.io[\s\S]*docker pull/,
    );
    expect(publishSteps[verify]?.run).toContain("scripts/check-image.sh");
  });

  it("pins Docker's actions by commit", () => {
    const docker = [...imageSteps, ...publishSteps].filter((step) =>
      step.uses?.startsWith("docker/"),
    );
    expect(docker.length).toBeGreaterThan(0);
    for (const step of docker) {
      expect(step.uses, step.name).toMatch(/^docker\/[\w-]+@[0-9a-f]{40}$/);
    }
  });
});
