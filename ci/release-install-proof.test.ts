// Exercises the workflow's install proof.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "release", "install-proof.sh");

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}

interface Job {
  needs?: string | string[];
  if?: string;
  "runs-on"?: string;
  "timeout-minutes"?: number;
  permissions?: Record<string, string>;
  strategy?: {
    "fail-fast"?: boolean;
    matrix?: { include?: Record<string, string>[] };
  };
  steps: Step[];
}

const jobs = (
  parse(
    readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8"),
  ) as { jobs: Record<string, Job> }
).jobs;
const proof = jobs["install-proof"];
const script = readFileSync(SCRIPT, "utf8");

const needs = (job: Job | undefined): string[] => [job?.needs ?? []].flat();

describe("the install proof in a release", () => {
  it("finds the job rather than passing over none", () => {
    expect(proof).toBeDefined();
    expect(proof?.steps.length).toBeGreaterThan(0);
  });

  it("runs in a dry run and for a tag alike, after the files are collected", () => {
    expect(proof?.if).toBeUndefined();
    expect(needs(proof)).toEqual(
      expect.arrayContaining(["collect", "version"]),
    );
    expect(needs(jobs.collect)).not.toContain("install-proof");
  });

  it("proves each platform on a clean runner of its own, with the modes that platform has", () => {
    expect(proof?.["runs-on"]).toBe("${{ matrix.runner }}");
    expect(
      proof?.strategy?.matrix?.include?.map(({ platform, runner, modes }) => [
        platform,
        runner,
        modes,
      ]),
    ).toEqual([
      ["darwin-arm64", "macos-26", "native-user"],
      ["linux-x86_64", "ubuntu-latest", "native-root docker"],
      ["linux-aarch64", "ubuntu-24.04-arm", "native-user"],
    ]);
  });

  it("lets every platform report, since each is a proof of its own", () => {
    expect(proof?.strategy?.["fail-fast"]).toBe(false);
  });

  it("installs what the collect job uploaded and no other build", () => {
    const download = proof?.steps.find((step) =>
      step.uses?.startsWith("actions/download-artifact"),
    );
    expect(download?.with?.name).toBe(
      "release-${{ needs.version.outputs.version }}",
    );
    const run = proof?.steps.find((step) =>
      (step.run ?? "").includes("install-proof.sh"),
    );
    expect(run?.run).toContain('"$RUNNER_TEMP/release" "$VERSION"');
    expect(run?.run).toContain('"${modes[@]}"');
  });

  it("publishes nothing and keeps nothing: it reads the repository, uploads no artifact and logs in to no registry", () => {
    expect(proof?.permissions).toEqual({ contents: "read" });
    for (const step of proof?.steps ?? []) {
      expect(step.uses ?? "").not.toMatch(
        /upload-artifact|login-action|build-push-action/,
      );
      expect(step.run ?? "").not.toMatch(
        /npm publish|docker push|gh release|imagetools/,
      );
    }
  });

  it("has a limit of about twice an install, Caddy and a Docker build", () => {
    const limit = proof?.["timeout-minutes"];
    expect(limit).toBeTypeOf("number");
    expect(limit).toBeGreaterThanOrEqual(10);
    expect(limit).toBeLessThanOrEqual(30);
  });

  it("holds the publish job back: an archive that does not install is not a release", () => {
    expect(needs(jobs.publish)).toContain("install-proof");
    expect(jobs.publish?.if).toBe("github.event_name == 'push'");
  });
});

describe("the proof script", () => {
  it("installs through scripts/install.sh from the run's own folder, so the script and its checksum check are proved", () => {
    expect(script).toContain('MARFA_DOWNLOAD_BASE="file://$archives"');
    expect(script).toContain('MARFA_VERSION="$version"');
    expect(script).toContain("MARFA_INSTALL_DIR=");
    expect(script).toContain('"$repo/scripts/install.sh"');
  });

  it("pins Caddy by version and by the SHA-256 of each archive it can run, and checks the download", () => {
    expect(script).toMatch(/^caddy_version=\d+\.\d+\.\d+$/m);
    for (const platform of ["mac_arm64", "linux_amd64", "linux_arm64"]) {
      expect(script).toMatch(
        new RegExp(`^caddy_sha_${platform}=[0-9a-f]{64}$`, "m"),
      );
    }
    expect(script).toContain("does not match its pinned SHA-256");
  });

  it("puts HTTPS in front on a port that needs no privilege, with a certificate authority of Caddy's own that nothing else trusts", () => {
    expect(script).toContain("https_port=${MARFA_PROOF_HTTPS_PORT:-8443}");
    expect(script).toContain("tls internal");
    expect(script).toContain("skip_install_trust");
    expect(script).toContain('--cacert "$ca"');
    expect(script).toContain("without_caddy_authority");
    expect(script).toContain("marfa.test");
    expect(script).toContain("marfa-docker.test");
  });

  it("installs behind a proxy at the https address, claims on the private socket and reads the stored address back", () => {
    expect(script).toContain("--access proxy");
    expect(script).toContain('--address "$address"');
    expect(script).toContain("setup claim --stdin");
    expect(script).toContain(".sign_in_address == $address");
    expect(script).toContain(
      ".running_release == $version and .release == $version",
    );
    expect(script).toContain(".claimed == true");
  });

  it("runs the lifecycle to the end and checks that no service, process or container is left", () => {
    for (const word of [
      "server stop",
      "server start",
      "server uninstall",
      "--delete-data --yes",
      "launchctl print",
      "systemctl --user cat",
      "systemctl cat",
      "docker ps -a",
    ]) {
      expect(script, word).toContain(word);
    }
  });

  it("uses the image it builds from the release's archives and pulls nothing", () => {
    expect(script).toContain("image-context.sh");
    expect(script).toContain('-t "$image:$version"');
    expect(script).not.toMatch(/docker (pull|push)/);
  });

  it("never prints the owner's password", () => {
    expect(script).not.toMatch(/(echo|say|printf '%s\\n')[^\n]*\$password/);
    expect(script).not.toMatch(/--password|-p "\$password/);
  });

  describe("refuses what it cannot prove, before it changes anything", () => {
    const run = (...args: string[]) => {
      const folder = mkdtempSync(join(tmpdir(), "marfa-proof-test-"));
      try {
        return spawnSync("bash", [SCRIPT, folder, ...args], {
          encoding: "utf8",
          env: { PATH: process.env.PATH ?? "", HOME: folder },
        });
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    };

    it("a version that is not major.minor.patch", () => {
      const result = run("0.0.70-rc1", "native-user");
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("is not a version");
    });

    it("a mode it does not have", () => {
      const result = run("0.0.70", "native-everything");
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("cannot be proved on");
    });

    it("a missing mode, with the usage", () => {
      const result = spawnSync("bash", [SCRIPT, "/tmp", "0.0.70"], {
        encoding: "utf8",
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("usage:");
    });

    it("a hosts setting it does not know", () => {
      const folder = mkdtempSync(join(tmpdir(), "marfa-proof-test-"));
      try {
        const result = spawnSync(
          "bash",
          [SCRIPT, folder, "0.0.70", "native-user"],
          {
            encoding: "utf8",
            env: {
              PATH: process.env.PATH ?? "",
              HOME: folder,
              MARFA_PROOF_HOSTS: "both",
            },
          },
        );
        expect(result.status).toBe(1);
        expect(result.stdout).toContain("not edit or resolve");
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    });
  });
});
