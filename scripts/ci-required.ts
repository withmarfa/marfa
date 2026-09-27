import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

// Keep this allowlist narrow: Markdown under packages or conformance can be
// test input or contract material, and unknown paths must run the full suite.
function documentationOnly(path: string) {
  return (
    /^[^/]+\.md$/.test(path) ||
    path === "LICENSE" ||
    path === ".github/CODEOWNERS"
  );
}

let required = true;
if (process.env.GITHUB_EVENT_NAME === "pull_request") {
  try {
    const event = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"),
    ) as { pull_request: { base: { sha: string }; head: { sha: string } } };
    const base = event.pull_request.base.sha;
    const head = event.pull_request.head.sha;
    if (!/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(head)) {
      throw new Error("Missing commit IDs");
    }
    // Disable rename detection so moving code into a documentation path still
    // includes the deletion of its original path. NULs preserve unusual names.
    const paths = execFileSync(
      "git",
      ["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`, "--"],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    )
      .split("\0")
      .filter(Boolean);
    required = paths.length === 0 || !paths.every(documentationOnly);
  } catch {
    // An unavailable diff must never turn a code change into a skipped check.
    console.log("Could not classify the change; running full CI.");
  }
}
appendFileSync(
  process.env.GITHUB_OUTPUT ?? "",
  `required=${String(required)}\n`,
);
console.log(required ? "Full CI required." : "Documentation/metadata only.");
