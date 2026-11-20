import { chmodSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HeldCommand } from "../../device/cli-adapter.js";
import { tempFolder } from "../../utils/temp-folder.js";
import { folderHarness, type FolderHarness } from "./harness.js";
import {
  lastReport,
  put,
  read,
  scriptFolderWrites,
  sentCreates,
  sentTitles,
  sentUpdates,
} from "./folders.shared.js";

/**
 * A watch that cannot watch part of a directory says so, looks at just that
 * part on an interval shorter than a full pass, and stops saying so once it
 * can watch the part.
 *
 * A debug build lets a fixture refuse the registration of the directories
 * whose names end the lines of a file (`watch-refuse`), standing for the
 * system's limit on watches, and set the interval (`unwatched-every`, in
 * milliseconds).
 */

const WAIT = { timeout: 30_000, interval: 100 };
const UNWATCHED = "unwatched-dir";
const SHORT = 400;
const LONG = 3_600_000;

let harness: FolderHarness | undefined;
const held: HeldCommand[] = [];

afterEach(async () => {
  for (const command of held.splice(0)) await command.stop();
  await harness?.stop();
  harness = undefined;
});

/** A folder with a directory the watch will be refused. */
async function folderWithUnwatched(
  label: string,
): Promise<{ made: FolderHarness; refusal: string }> {
  const made = await folderHarness(label);
  scriptFolderWrites(made);
  const refusal = join(tempFolder("marfa-refuse-"), "names");
  writeFileSync(refusal, `${UNWATCHED}\n`);
  put(made, "Watched.md", "---\ntitle: Watched\n---\nwatched\n");
  put(
    made,
    `${UNWATCHED}/below/Inside.md`,
    "---\ntitle: Inside\n---\ninside\n",
  );
  expect((await made.folder.push()).ok).toBe(true);
  return { made, refusal };
}

function watchWith(
  made: FolderHarness,
  refusal: string,
  every: number,
): HeldCommand {
  const watching = made.folder.hold(["folders", "watch", made.dir], {
    MARFA_TEST_FAULT: `watch-refuse=${refusal},unwatched-every=${every}`,
  });
  held.push(watching);
  return watching;
}

function problemCodes(made: FolderHarness): string[] {
  return lastReport(made).problems.map((problem) => problem.code);
}

describe("a watch that cannot watch part of a directory", () => {
  it("reports each directory it cannot watch, says so in the folder's status, and stops once it can watch them", async () => {
    const { made, refusal } = await folderWithUnwatched("unwatched-report");
    harness = made;
    // The witness: a watch with nothing refused reports no unwatched part.
    const clear = made.folder.watch();
    held.push(clear);
    await vi.waitFor(() => expect(clear.stderr).toContain("watching"), WAIT);
    await clear.stop();
    held.pop();
    expect(problemCodes(made)).not.toContain("unwatched");
    const quiet = await made.folder.status();
    expect(quiet.ok && quiet.value.unwatched).toBe(0);

    const watching = watchWith(made, refusal, SHORT);
    await vi.waitFor(
      () =>
        expect(lastReport(made).problems, watching.stderr).toContainEqual({
          code: "unwatched",
          count: 2,
        }),
      WAIT,
    );
    const status = await made.folder.status();
    expect(status.ok && status.value.unwatched).toBe(2);
    const text = await made.folder.statusText();
    expect(text.ok && text.value).toContain("cannot be watched");

    rmSync(refusal);
    await vi.waitFor(
      () =>
        expect(problemCodes(made), watching.stderr).not.toContain("unwatched"),
      WAIT,
    );
    const after = await made.folder.status();
    expect(after.ok && after.value.unwatched).toBe(0);
    const words = await made.folder.statusText();
    expect(words.ok && words.value).not.toContain("cannot be watched");
  });

  it("finds a change in a directory it cannot watch at its own interval, reading none of the files it can watch", async () => {
    const { made, refusal } = await folderWithUnwatched("unwatched-poll");
    harness = made;
    const watching = watchWith(made, refusal, SHORT);
    await vi.waitFor(
      () => expect(problemCodes(made), watching.stderr).toContain("unwatched"),
      WAIT,
    );

    // A change in a watched file that leaves its size and time as they were
    // is one only a full pass reads.
    const kept = join(made.dir, "Watched.md");
    const staged = join(tempFolder("marfa-time-"), "Watched.md");
    writeFileSync(
      staged,
      read(made, "Watched.md").replace("watched", "WATCHED"),
    );
    chmodSync(staged, statSync(kept).mode);
    execFileSync("touch", ["-r", kept, staged]);
    execFileSync("cp", ["-p", staged, kept]);
    const updates = sentUpdates(made).length;
    put(
      made,
      `${UNWATCHED}/below/Late.md`,
      "---\ntitle: Late\n---\nwritten where no event comes\n",
    );
    await vi.waitFor(
      () => expect(sentTitles(made), watching.stderr).toContain("Late"),
      WAIT,
    );
    expect(
      sentUpdates(made).length,
      "the look at the unwatched part read a file of the watched part",
    ).toBe(updates);
    await watching.stop();
    held.pop();

    // The witness: the watched file did change, and a full pass reads it.
    expect((await made.folder.push()).ok).toBe(true);
    expect(sentUpdates(made).length).toBeGreaterThan(updates);
    expect(sentCreates(made).length).toBeGreaterThan(0);
  });

  it("finds a change in a directory it cannot watch beneath which lie more files than a pass names", async () => {
    const { made, refusal } = await folderWithUnwatched("unwatched-many");
    harness = made;
    for (let at = 0; at < 300; at += 1) {
      put(
        made,
        `${UNWATCHED}/many/Note ${at}.md`,
        `---\ntitle: Note ${at}\n---\nnote ${at}\n`,
      );
    }
    expect((await made.folder.push()).ok).toBe(true);
    const watching = watchWith(made, refusal, SHORT);
    await vi.waitFor(
      () => expect(problemCodes(made), watching.stderr).toContain("unwatched"),
      WAIT,
    );
    put(
      made,
      `${UNWATCHED}/many/Late.md`,
      "---\ntitle: Late\n---\nwritten where no event comes\n",
    );
    await vi.waitFor(
      () => expect(sentTitles(made), watching.stderr).toContain("Late"),
      WAIT,
    );
    expect(watching.running(), watching.stderr).toBe(true);
  });

  it("does not look at a directory it cannot watch before its interval while nothing else changes", async () => {
    const { made, refusal } = await folderWithUnwatched("unwatched-interval");
    harness = made;
    const watching = watchWith(made, refusal, LONG);
    await vi.waitFor(
      () => expect(problemCodes(made), watching.stderr).toContain("unwatched"),
      WAIT,
    );
    const sent = sentTitles(made).length;
    put(
      made,
      `${UNWATCHED}/below/Late.md`,
      "---\ntitle: Late\n---\nwritten where no event comes\n",
    );
    // The witness is the test above, where the same change is found once
    // the interval is short: here no event names it and no look is due.
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    expect(
      sentTitles(made).slice(sent),
      "a watch looked at the directory it cannot watch before its interval",
    ).toEqual([]);
    expect(watching.running(), watching.stderr).toBe(true);
  });
});
