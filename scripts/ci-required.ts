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

// What the core's checks read: the Rust workspace, the root API document its
// tests hold the client to, and the workflows that run them.
function coreInput(path: string) {
  return (
    path.startsWith("core/") ||
    path === "openapi.json" ||
    path.startsWith(".github/workflows/") ||
    path === "scripts/ci-required.ts"
  );
}

let required = true;
let core = true;
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
    core = paths.length === 0 || paths.some(coreInput);
  } catch {
    // An unavailable diff must never turn a code change into a skipped check.
    console.log("Could not classify the change; running full CI.");
  }
}
core &&= required;
appendFileSync(
  process.env.GITHUB_OUTPUT ?? "",
  `required=${String(required)}\ncore=${String(core)}\n`,
);
console.log(required ? "Full CI required." : "Documentation/metadata only.");
console.log(core ? "Core checks required." : "The core is untouched.");
