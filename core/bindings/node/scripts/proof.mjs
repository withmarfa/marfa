// @ts-check
// Three phases, run in order with the server stopped between the first and
// the last: `hydrate` pulls a slice, `write` queues writes while nothing can
// be sent, and `drain` sends them once the server is back.
import { MarfaCore, Tier } from "../index.js";

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

/** @param {MarfaCore} core */
function printQueue(core) {
  for (const write of core.queue()) {
    console.log(`  ${write.kind}  ${write.itemId ?? "-"}  ${describe(write.verdict)}  refusals ${write.refusals}`);
  }
}

const core = MarfaCore.open(path, url, key);
if (phase === "hydrate") {
  const hydrated = await core.hydrate(["core.note"], Tier.Feed);
  console.log(`hydrated ${hydrated.items} item(s) at feed; cursor ${hydrated.cursor}; handle ${core.heldHandle()}`);
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
  core.updateItem(firstId, { properties: { title: "Node first, edited" }, baseVersion: held.version });
  core.addTag(firstId, "favourite");
  core.createEdge({ sourceId: firstId, targetId: second.itemId, edgeType: "references" });
  const third = core.createItem({
    type: "core.note",
    properties: { title: "Node third", body: "deleted before it was sent" },
    tier: Tier.Feed,
  });
  core.deleteItem(third.itemId ?? "");
  core.createItem({ type: "system.device", properties: { name: "not the device's to write" } });
  console.log("queued, nothing answered:");
  printQueue(core);
  const offline = await core.drain();
  console.log(
    `drain with the server away: sent ${offline.sent}, answered ${offline.verdicts.filter((v) => v.verdict).length}`,
  );
  const local = core.search("node", { type: "core.note", tags: ["favourite"] }, 10);
  console.log(`local search for favourites: ${local.map((hit) => title(hit.item)).join(", ")}`);
} else if (phase === "drain") {
  const report = await core.drain();
  console.log(`drain: sent ${report.sent}, held ${report.held}`);
  for (const entry of report.verdicts) {
    console.log(`  ${entry.kind}  ${entry.itemId ?? "-"}  ${describe(entry.verdict)}`);
  }
  const notes = core.list({ type: "core.note", tier: Tier.Feed });
  console.log(`notes now: ${notes.map((note) => `${title(note)} v${note.version} [${note.tags.join(",")}]`).join("; ")}`);
  console.log(`cleared ${core.forgetAnswered()} answered write(s); ${core.queue().length} left`);
} else {
  console.error("name a phase: hydrate, write or drain");
  process.exit(2);
}
