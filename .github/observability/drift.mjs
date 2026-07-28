/**
 * Deploy drift: what is actually running, versus what is supposed to be.
 *
 * Each server surface reports the build it is serving via `/health`. Three
 * comparisons matter, and they are not equally severe:
 *
 *   1. **Staging older than production.** Always wrong. Staging exists to see
 *      a build before production does; an inversion means the gate was
 *      bypassed and nothing verified the running production build.
 *   2. **Environments diverged.** Two environments on unrelated commits means
 *      neither is a rehearsal for the other.
 *   3. **Behind the default branch.** Normal — undeployed work is the usual
 *      state of a repository. Reported as context, never alerted on, because
 *      an alert that fires whenever someone hasn't deployed today is an alert
 *      that gets ignored.
 *
 * Ancestry is resolved through the repository comparison API rather than a
 * local clone, so the checkout can stay shallow.
 */

const DEFAULT_BRANCH = "main";

async function githubApi(path, token) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `GET ${path} returned ${String(response.status)}: ${detail.slice(0, 200)}`,
    );
  }
  return response.json();
}

/**
 * `status` is one of identical / ahead / behind / diverged, described from
 * the perspective of `head` relative to `base`.
 */
async function compare(repo, base, head, token) {
  return githubApi(
    `/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    token,
  );
}

async function commitDate(repo, sha, token) {
  const commit = await githubApi(
    `/repos/${repo}/commits/${encodeURIComponent(sha)}`,
    token,
  );
  const iso = commit.commit?.committer?.date ?? commit.commit?.author?.date;
  return iso ? new Date(iso) : null;
}

function daysBetween(then, now) {
  return Math.floor((now.getTime() - then.getTime()) / 86_400_000);
}

/**
 * @param probeResults results from `checkLiveness`, carrying the SHA each
 *   server surface reported.
 */
export async function checkDeployDrift({ repo, token, probeResults, now }) {
  const findings = [];
  const environments = [];

  const servers = probeResults.filter((r) => r.surface.kind === "server");

  for (const result of servers) {
    const entry = {
      id: result.surface.id,
      label: result.surface.label,
      environment: result.surface.environment,
      sha: result.sha,
      behindMain: null,
      ageDays: null,
    };

    // A reachable server that does not report a build SHA cannot be checked
    // for drift at all, which is its own gap worth surfacing.
    if (result.ok && !result.sha) {
      findings.push({
        severity: "red",
        area: "deploy-drift",
        title: `${result.surface.label} reports no build SHA`,
        detail:
          "Deploy drift cannot be verified for an environment that does not " +
          "expose the build it is running.",
      });
    }

    if (entry.sha) {
      try {
        const comparison = await compare(
          repo,
          DEFAULT_BRANCH,
          entry.sha,
          token,
        );
        entry.behindMain = comparison.behind_by ?? null;
        entry.aheadOfMain = comparison.ahead_by ?? null;
      } catch (error) {
        entry.compareError =
          error instanceof Error ? error.message : String(error);
      }

      try {
        const date = await commitDate(repo, entry.sha, token);
        entry.deployedCommitDate = date ? date.toISOString() : null;
        entry.ageDays = date ? daysBetween(date, now) : null;
      } catch {
        entry.deployedCommitDate = null;
      }
    }

    environments.push(entry);
  }

  const staging = environments.find((e) => e.environment === "staging");
  const prod = environments.find((e) => e.environment === "prod");

  if (staging?.sha && prod?.sha && staging.sha !== prod.sha) {
    try {
      // base = production, head = staging. "behind" means staging is running
      // an ancestor of production: the inversion.
      const comparison = await compare(repo, prod.sha, staging.sha, token);
      const status = String(comparison.status);

      if (status === "behind") {
        findings.push({
          severity: "red",
          area: "deploy-drift",
          title: "Staging is running an older build than production",
          detail:
            `Staging is on \`${staging.sha}\`, production on \`${prod.sha}\` — ` +
            `staging is ${String(comparison.behind_by)} commit(s) behind production. ` +
            "Production is running code staging has never exercised.",
        });
      } else if (status === "diverged") {
        findings.push({
          severity: "red",
          area: "deploy-drift",
          title: "Staging and production have diverged",
          detail:
            `Staging is on \`${staging.sha}\`, production on \`${prod.sha}\`; ` +
            "neither is an ancestor of the other, so staging is not a " +
            "rehearsal for what production is running.",
        });
      }
      // "ahead" is the intended direction and needs no finding.
    } catch (error) {
      findings.push({
        severity: "warn",
        area: "deploy-drift",
        title: "Could not compare staging and production builds",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { findings, environments };
}
