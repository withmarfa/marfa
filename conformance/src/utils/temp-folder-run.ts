import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  removeTempFolders,
  RUN_LIST_VARIABLE,
  tempFolder,
  unlockAndRemove,
} from "./temp-folder.js";

/**
 * The run's check that nothing it made is left. Every test process lists the
 * run folder it makes in a file named in `MARFA_TEST_RUN_LIST`; at the end,
 * every folder listed must be gone, and no disk image of the run may be
 * attached. A leftover is removed, so the next run starts clean, and fails the
 * run, so the test that missed it is found. Every project that makes folders
 * lists it first in its `globalSetup`, which makes it the last to tear down.
 */
export default function listRunFolders(): () => void {
  const list = join(tempFolder("marfa-run-list-"), "folders");
  writeFileSync(list, "");
  process.env[RUN_LIST_VARIABLE] = list;
  return () => {
    delete process.env[RUN_LIST_VARIABLE];
    const listed = readFileSync(list, "utf8").split("\n").filter(Boolean);
    const problems: string[] = [];
    for (const folder of listed.filter((one) => existsSync(one))) {
      problems.push(`left behind: ${folder}`);
      unlockAndRemove(folder);
    }
    if (process.platform === "darwin") {
      const attached = spawnSync("hdiutil", ["info"], { encoding: "utf8" })
        .stdout.split("\n")
        .filter(
          (line) =>
            line.startsWith("image-path") &&
            listed.some((folder) => line.includes(folder)),
        );
      for (const line of attached) problems.push(`still attached: ${line}`);
    }
    try {
      removeTempFolders();
    } catch (error) {
      problems.push(String(error));
    }
    if (problems.length > 0) {
      throw new Error(
        `the run left what it made behind:\n${problems.join("\n")}`,
      );
    }
  };
}
