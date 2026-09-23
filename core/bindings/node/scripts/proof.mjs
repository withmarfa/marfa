// @ts-check
// Three phases, run in order with the server stopped between the first and
// the last: `hydrate` pulls a slice, `write` queues writes while nothing can
// be sent, and `drain` sends them once the server is back.
import { readFileSync, writeFileSync } from "node:fs";
import { MarfaCore, Tier, WriteKind } from "../index.js";

const { MARFA_API_URL: url, MARFA_API_KEY: key, MARFA_DB: path } = process.env;
if (!url || !key || !path) {
  console.error("set MARFA_API_URL, MARFA_API_KEY and MARFA_DB");
  process.exit(2);
}
const phase = process.argv[2] ?? "";

/** @param {import("../index.js").Verdict | null | undefined} verdict */
function describe(verdict) {
  if (!verdict) return "unanswered";
  switch (verdict.verdict) {
    case "merged":
      return `merged ${verdict.fields.join(",")}`;
    case "conflicted":
      return `conflicted, sibling ${verdict.siblingId}`;
    case "refused":
      return `refused: ${verdict.reason}`;
    case "blocked":
      return `blocked: ${verdict.reason}`;
    default:
      return verdict.verdict;
  }
}

/** @param {import("../index.js").Item} item */
const title = (item) => String(item.properties.title ?? "(untitled)");

/**
 * Prints a failed expectation and fails the run, so the proof is a check
 * rather than a transcript someone has to read.
 * @param {boolean} held
 * @param {string} expectation
 */
function expect(held, expectation) {
  if (held) return;
  console.error(`proof failed: ${expectation}`);
  process.exitCode = 1;
}

/** @param {MarfaCore} core */
function printQueue(core) {
  for (const write of core.queue()) {
    console.log(
      `  ${write.kind}  ${write.itemId ?? "-"}  ${describe(write.verdict)}  refusals ${write.refusals}`,
    );
  }
}

const core = MarfaCore.open(path, url, key);
if (phase === "hydrate") {
  const hydrated = await core.hydrate(["core.note"], Tier.Feed);
  console.log(
    `hydrated ${hydrated.items} item(s) at feed; cursor ${hydrated.cursor}; handle ${core.heldHandle()}`,
  );
} else if (phase === "write") {
  const first = core.createItem({
    type: "core.note",
    properties: { title: "Node first", body: "written with the server away" },
    tier: Tier.Feed,
  });
  const second = core.createItem({
    type: "core.note",
    properties: { title: "Node second", body: "the other end of a link" },
    tier: Tier.Feed,
  });
  const firstId = first.itemId ?? "";
  const held = core.get(firstId);
  if (!held || !second.itemId) throw new Error("a queued create named no item");
  core.updateItem(firstId, {
    properties: { title: "Node first, edited" },
    baseVersion: held.version,
  });
  core.addTag(firstId, "favorite");
  core.createEdge({
    sourceId: firstId,
    targetId: second.itemId,
    edgeType: "references",
  });
  const third = core.createItem({
    type: "core.note",
    properties: { title: "Node third", body: "deleted before it was sent" },
    tier: Tier.Feed,
  });
  core.deleteItem(third.itemId ?? "");
  const attachment = `${path}.attachment.txt`;
  writeFileSync(attachment, "bytes attached with the server away\n");
  const attached = await core.attach(firstId, attachment);
  expect(
    attached.item.dependsOn.includes(attached.upload.id),
    "the attached file item does not wait on its upload",
  );
  core.createItem({
    type: "system.device",
    properties: { name: "not the device's to write" },
  });
  console.log("queued, nothing answered:");
  printQueue(core);
  const offline = await core.drain();
  const answered = offline.verdicts.filter((v) => v.verdict).length;
  console.log(
    `drain with the server away: sent ${offline.sent}, answered ${answered}`,
  );
  expect(answered === 0, "a drain with the server away answered a write");
  expect(
    core.queue().every((write) => write.refusals === 0),
    "a drain with the server away counted a refusal against a write",
  );
  const local = core.search(
    "node",
    { type: "core.note", tags: ["favorite"] },
    10,
  );
  const found = local.map((hit) => title(hit.item));
  console.log(`local search for favorites: ${found.join(", ")}`);
  expect(
    found.length === 1 && found[0] === "Node first, edited",
    "a local search for the tagged edit did not find exactly it",
  );
} else if (phase === "drain") {
  const report = await core.drain();
  console.log(`drain: sent ${report.sent}, held ${report.held}`);
  for (const entry of report.verdicts) {
    console.log(
      `  ${entry.kind}  ${entry.itemId ?? "-"}  ${describe(entry.verdict)}`,
    );
  }
  const outcomes = report.verdicts.map((entry) => describe(entry.verdict));
  expect(
    outcomes.filter((outcome) => outcome === "refused: type_not_permitted")
      .length === 1,
    "the system.device create was not refused type_not_permitted",
  );
  expect(
    outcomes
      .filter((outcome) => outcome !== "refused: type_not_permitted")
      .every((outcome) => outcome === "accepted"),
    "a write other than the system.device create was not accepted",
  );
  const notes = core.list({ type: "core.note", tier: Tier.Feed });
  console.log(
    `notes now: ${notes.map((note) => `${title(note)} v${note.version} [${note.tags.join(",")}]`).join("; ")}`,
  );
  const edited = notes.find((note) => title(note) === "Node first, edited");
  expect(edited?.version === 2, "the edit was not answered at version 2");
  expect(edited?.tags.includes("favorite") === true, "the edit lost its tag");
  expect(
    !notes.some((note) => title(note) === "Node third"),
    "the note deleted offline is still listed",
  );
  // The bytes, fetched into a store that has never held them, through the
  // link the server gives.
  const upload = report.verdicts.find((entry) => entry.kind === WriteKind.UploadBlob);
  const hash = core.queue().find((write) => write.id === upload?.id)?.blob;
  expect(hash !== undefined, "no upload was drained");
  const fresh = MarfaCore.open(`${path}.fresh`, url, key);
  const fetched = await fresh.blob(hash ?? "");
  console.log(`fetched ${hash} into a fresh store`);
  expect(
    readFileSync(fetched, "utf8") === "bytes attached with the server away\n",
    "the bytes fetched are not the bytes attached",
  );
  const cleared = core.forgetAnswered();
  console.log(
    `cleared ${cleared} answered write(s); ${core.queue().length} left`,
  );
  expect(core.queue().length === 0, "answered writes were left in the queue");
} else if (phase === "follow") {
  // Held open while the binary makes a note on the server; the change
  // arrives here, and a reader on the same store is told the copy saved.
  const reader = MarfaCore.openReader(path);
  const before = reader.dataVersion();
  /** @type {import("../index.js").Change[]} */
  const changes = [];
  const subscription = core.follow(
    (change) => changes.push(change),
    (error) => {
      if (error) console.error(`follow ended: ${error}`);
    },
  );
  const made = () =>
    changes.find((change) => {
      const item = change.itemId ? core.get(change.itemId) : null;
      return item?.properties.title === "Made by the binary";
    });
  const deadline = Date.now() + 30_000;
  while (!made() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  subscription.stop();
  const change = made();
  console.log(`followed: ${change ? `${change.event} ${change.itemId} at ${change.cursor}` : "nothing"}`);
  expect(change?.event === "item.created", "the note the binary made did not arrive through follow");
  expect(reader.dataVersion() !== before, "a reader on the same store was not told the copy saved");
} else {
  console.error("name a phase: hydrate, write, drain or follow");
  process.exit(2);
}
