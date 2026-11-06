import { afterEach, describe, expect, it } from "vitest";
import {
  answers,
  typeCatalog,
  wireType,
} from "../../device/marfa-answers.js";
import type { FolderDoor } from "../../device/folder-door.js";
import type { DrainReport } from "../../device/protocol.js";
import {
  CONTRACT_HEADER,
  type Answer,
  type RecordedRequest,
} from "../../device/scripted-server.js";
import { folderHarness, type FolderHarness } from "./harness.js";
import { put, scriptFolderWrites } from "./folders.shared.js";

/**
 * "A write past the request limit that meets no answer."
 *
 * A server closes the connection on a body over its cap, which can destroy
 * its `413`, and a link that drops does the same to a body the server would
 * take. A device cannot tell the two apart and claims no refusal it did not
 * hear. These fixtures drive both: the write stays queued under its key, the
 * writes beside it go, and it is set aside only as any write is.
 */

const LARGE = "user.large_text";
const CUT_OFF: Answer = { kind: "drop" };
// Each quote is sent as two bytes, so this body is past 1048576 bytes.
const LONG = '"'.repeat(600_000);

let folder: FolderHarness | undefined;

afterEach(async () => {
  await folder?.stop();
  folder = undefined;
  delete process.env.MARFA_TEST_FAULT;
});

/** See `clockAt` in `stuck-write.test.ts`. */
function clockAt(minutes: number): void {
  process.env.MARFA_TEST_FAULT = `clock-offset=${Math.round(minutes * 60_000)}`;
}

function titleOf(request: RecordedRequest): string {
  return (
    (JSON.parse(request.body) as { properties?: { title?: string } }).properties
      ?.title ?? ""
  );
}

function creates(request: RecordedRequest): boolean {
  return request.method === "POST" && request.pathname === "/items";
}

/** A folder where `cut(title)` decides which creates lose their connection,
 *  and `landed` whether the server wrote them first. */
async function cutting(
  name: string,
  cut: (title: string) => boolean,
  landed = false,
): Promise<FolderHarness> {
  folder = await folderHarness(name, {
    settings: { query: { types: ["core.note", LARGE] } },
    catalog: typeCatalog([
      wireType(LARGE, {
        bodyField: "body",
        fields: { title: { type: "string" }, body: { type: "string" } },
      }),
    ]),
  });
  let door: FolderDoor | undefined;
  scriptFolderWrites(folder, {
    door: (made) => {
      door = made;
    },
    creating: (answer, request) => {
      if (!cut(titleOf(request))) return answer;
      if (!landed) door?.rows.delete((JSON.parse(request.body) as { id: string }).id);
      return CUT_OFF;
    },
  });
  return folder;
}

function putLong(own: FolderHarness, title: string): void {
  put(own, `${title}.md`, `---\ntype: ${LARGE}\ntitle: ${title}\n---\n${LONG}\n`);
}

function putShort(own: FolderHarness, title: string): void {
  put(own, `${title}.md`, `---\ntitle: ${title}\n---\ntext\n`);
}

async function push(own: FolderHarness): Promise<DrainReport> {
  const pushed = await own.folder.push();
  expect(pushed.ok, JSON.stringify(pushed).slice(0, 400)).toBe(true);
  if (!pushed.ok) throw new Error("unreachable: the assertion above threw");
  return pushed.value.drain;
}

async function queue(own: FolderHarness) {
  const queued = await own.folder.device().queue();
  expect(queued.ok).toBe(true);
  if (!queued.ok) throw new Error("unreachable: the assertion above threw");
  return queued.value;
}

async function fileStatus(own: FolderHarness, path: string) {
  const status = await own.folder.status();
  expect(status.ok).toBe(true);
  if (!status.ok) throw new Error("unreachable: the assertion above threw");
  return status.value.files.find((file) => file.path === path);
}

function sent(own: FolderHarness, title: string): RecordedRequest[] {
  return own.server.requests.filter(
    (request) => creates(request) && titleOf(request) === title,
  );
}

/** Three pushes close together and one six minutes on, the first that can
 *  make a write a suspect (`queue-and-verdicts/stuck-write-suspect`). */
async function reachSuspect(own: FolderHarness): Promise<DrainReport> {
  clockAt(0);
  for (let pass = 0; pass < 3; pass += 1) await push(own);
  clockAt(6);
  return push(own);
}

describe("a write past the request limit that meets no answer", () => {
  it("goes on past a long write while the server answers a read, and leaves it queued with no verdict", async () => {
    const own = await cutting("cut-off-goes-on", (title) => title === "Long");
    putLong(own, "Long");
    putShort(own, "Short");

    const report = await push(own);

    expect(sent(own, "Short"), "the pass ended at the long write").toHaveLength(
      1,
    );
    expect(report.undelivered).toBe(1);
    expect(report.unavailable).toContain(
      "may be over the server's request size",
    );
    expect(JSON.stringify(report)).not.toContain("request_too_large");
    const rows = await queue(own);
    expect(
      rows
        .filter((row) => row.kind === "create_item" && row.verdict === null)
        .map((row) => [row.refusals, row.environmental_streak]),
    ).toEqual([[0, 1]]);
  });

  it("ends the pass at a long write when the read after it is not answered, and sets nothing aside", async () => {
    let down = false;
    const own = await cutting("cut-off-dead-link", (title) => {
      if (title !== "Long") return down;
      if (reaching) down = true;
      return true;
    });
    let reaching = false;
    putLong(own, "Long");
    clockAt(0);
    for (let pass = 0; pass < 3; pass += 1) await push(own);
    putShort(own, "Short");
    // The link goes as the long write is sent: from there no read is
    // answered, so nothing shows the write to be the one that fails.
    reaching = true;
    own.server.answer("GET", "/", () =>
      down ? CUT_OFF : answers.root(Number(own.server.contract)),
    );
    clockAt(6);

    const report = await push(own);

    expect(sent(own, "Short")).toHaveLength(0);
    expect(JSON.stringify(report)).not.toContain("failing_alone");
    expect(
      (await queue(own)).filter((row) => row.reason === "failing_alone"),
    ).toEqual([]);
  });

  it("sets a long write aside with nothing else queued, once a read answers and it is cut off again", async () => {
    const own = await cutting("cut-off-alone", (title) => title === "Long");
    putLong(own, "Long");

    const report = await reachSuspect(own);

    expect(
      report.verdicts.map((entry) => [entry.verdict, entry.reason]),
    ).toContainEqual(["blocked", "failing_alone"]);
    expect(report.unavailable).toBeNull();
    expect(report.undelivered).toBe(0);
    // One send in each of three drains, and two in the fourth.
    expect(sent(own, "Long")).toHaveLength(5);

    const file = await fileStatus(own, "Long.md");
    expect(file && [file.status, file.flag]).toEqual(["held", "not_sent"]);
    expect(file?.reason).toContain("may be over the server's request size");

    await push(own);
    expect(sent(own, "Long"), "a write set aside was sent again").toHaveLength(
      5,
    );
  });

  it("sets each of several long writes aside on its own read, with no write to test it", async () => {
    const own = await cutting("cut-off-several", (title) =>
      title.startsWith("Long"),
    );
    putLong(own, "Long one");
    putLong(own, "Long two");

    const report = await reachSuspect(own);

    expect(
      report.verdicts
        .filter((entry) => entry.reason === "failing_alone")
        .map((entry) => entry.verdict),
    ).toEqual(["blocked", "blocked"]);
  });

  it("settles a long write as the server answers it when it is sent again after the read", async () => {
    let sends = 0;
    const own = await cutting("cut-off-resent", (title) => {
      if (title !== "Long") return false;
      sends += 1;
      return sends <= 4;
    });
    putLong(own, "Long");

    const report = await reachSuspect(own);

    expect(sent(own, "Long")).toHaveLength(5);
    expect(
      report.verdicts.filter((entry) => entry.kind === "create_item"),
    ).toEqual([expect.objectContaining({ verdict: "accepted" })]);
    expect(
      new Set(
        sent(own, "Long").map((request) => request.headers["idempotency-key"]),
      ).size,
      "a send again changed the key a committed write is confirmed by",
    ).toBe(1);
  });

  it("confirms a long write the server committed by sending it again under its key, with no edit to the file", async () => {
    let lost = true;
    const own = await cutting(
      "cut-off-committed",
      (title) => title === "Long" && lost,
      true,
    );
    putLong(own, "Long");

    const first = await push(own);
    expect(first.undelivered).toBe(1);

    lost = false;
    const second = await push(own);

    expect(
      second.verdicts.filter((entry) => entry.kind === "create_item"),
    ).toEqual([expect.objectContaining({ verdict: "accepted" })]);
    expect(second.unavailable).toBeNull();
    expect((await fileStatus(own, "Long.md"))?.status).toBe("in_step");
    expect(
      new Set(
        sent(own, "Long").map((request) => request.headers["idempotency-key"]),
      ).size,
    ).toBe(1);
  });

  it("sends a file as it now is when it changes after its long write was set aside", async () => {
    const own = await cutting("cut-off-changed", (title) => title === "Long");
    putLong(own, "Long");
    await reachSuspect(own);
    expect((await fileStatus(own, "Long.md"))?.status).toBe("held");

    put(own, "Long.md", `---\ntype: ${LARGE}\ntitle: Now short\n---\nshort\n`);
    const report = await push(own);

    expect(sent(own, "Now short")).toHaveLength(1);
    expect(sent(own, "Long")).toHaveLength(5);
    expect(report.unavailable).toBeNull();
    expect((await fileStatus(own, "Long.md"))?.status).toBe("in_step");
    expect(
      (await queue(own)).filter((row) => row.reason === "failing_alone"),
    ).toEqual([]);
  });

  it("sends a file as it now is when it changes while its long write still waits", async () => {
    const own = await cutting("cut-off-changed-early", (title) => title === "Long");
    putLong(own, "Long");
    await push(own);

    put(own, "Long.md", `---\ntype: ${LARGE}\ntitle: Now short\n---\nshort\n`);
    await push(own);

    expect(sent(own, "Now short")).toHaveLength(1);
    expect(sent(own, "Long")).toHaveLength(1);
    expect((await fileStatus(own, "Long.md"))?.status).toBe("in_step");
  });

  it("keeps the item a long write committed when the file changes, and sends the change as an edit", async () => {
    const own = await cutting(
      "cut-off-changed-held",
      (title) => title === "Long",
      true,
    );
    putLong(own, "Long");
    await push(own);
    const item = (await fileStatus(own, "Long.md"))?.item_id;

    put(own, "Long.md", `---\ntype: ${LARGE}\ntitle: Long\n---\nshort\n`);
    await push(own);

    expect(sent(own, "Long")).toHaveLength(1);
    expect(
      own.server.requests.filter(
        (request) =>
          request.method === "PATCH" && request.pathname === `/items/${item}`,
      ),
    ).toHaveLength(1);
    expect((await fileStatus(own, "Long.md"))?.item_id).toBe(item);
  });

  it("reports a file that did not go in what a push says and in its status", async () => {
    const own = await cutting("cut-off-said", (title) => title === "Long");
    putLong(own, "Long");

    const pushed = await own.folder.push();
    expect(pushed.ok).toBe(true);
    if (!pushed.ok) throw new Error("unreachable: the assertion above threw");
    const flagged = pushed.value.scan.flagged.find(
      (file) => file.path === "Long.md",
    );
    expect(flagged?.flag).toBe("not_sent");
    expect(flagged?.reason).toContain("may be over the server's request size");
    const file = await fileStatus(own, "Long.md");
    expect(file && [file.status, file.flag]).toEqual(["waiting", "not_sent"]);
    expect(file?.reason).toBe(flagged?.reason);

    // The witness: a file that went is flagged by neither.
    putShort(own, "Short");
    const later = await own.folder.push();
    expect(
      later.ok && later.value.scan.flagged.map((entry) => entry.path),
    ).toEqual(["Long.md"]);
    expect((await fileStatus(own, "Short.md"))?.flag).toBeUndefined();
  });

  it("takes a 413 whose body cannot be read as the refusal it is", async () => {
    folder = await folderHarness("cut-off-413-unread", {
      settings: { query: { types: ["core.note", LARGE] } },
      catalog: typeCatalog([
        wireType(LARGE, {
          bodyField: "body",
          fields: { title: { type: "string" }, body: { type: "string" } },
        }),
      ]),
    });
    const own = folder;
    scriptFolderWrites(own, {
      creating: (answer, request) =>
        titleOf(request) === "Long"
          ? {
              kind: "bytes",
              status: 413,
              body: Buffer.from('{"error":{"code":"request_too_large"}}'),
              cut: 3,
              headers: { [CONTRACT_HEADER]: String(own.server.contract) },
            }
          : answer,
    });
    putLong(own, "Long");

    const report = await push(own);

    expect(
      report.verdicts
        .filter((entry) => entry.kind === "create_item")
        .map((entry) => [entry.verdict, entry.reason]),
    ).toEqual([["refused", "request_too_large"]]);
    expect(sent(own, "Long")).toHaveLength(1);
  });

  it("ends the pass at a write within the limit that loses its connection, as for any failure of the link", async () => {
    const own = await cutting("cut-off-short", (title) => title === "A short");
    putShort(own, "A short");
    putShort(own, "B short");

    const report = await push(own);

    expect(sent(own, "A short")).toHaveLength(1);
    expect(sent(own, "B short")).toHaveLength(0);
    expect(report.undelivered).toBe(2);
    expect(report.unavailable).not.toContain("request size");
  });
});
