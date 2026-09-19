import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MarfaCore } = require("../index.js");

const url = process.env.MARFA_API_URL;
const key = process.env.MARFA_API_KEY;
if (!url || !key) {
  console.error("set MARFA_API_URL and MARFA_API_KEY");
  process.exit(2);
}
const path = process.env.MARFA_DB ?? join(mkdtempSync(join(tmpdir(), "marfa-core-node-")), "core.sqlite");
const query = process.argv[2] ?? "lighthouse";

const title = (item) => item.properties.title ?? item.properties.body ?? "";

const core = MarfaCore.open(path, url, key);
const hydrated = await core.hydrate(["core.note", "core.file"], "library");
console.log(`hydrated ${hydrated.items} item(s) in ${hydrated.pages} page(s); cursor ${hydrated.cursor}`);

console.log("notes:");
for (const note of core.list({ type: "core.note", limit: 5 })) {
  console.log(`  ${note.id}  ${note.occurred_at}  ${title(note)}`);
}

console.log(`search "${query}":`);
for (const hit of core.search(query, {}, 5)) {
  console.log(`  ${hit.score.toFixed(3)}  ${hit.item.type}  ${title(hit.item)}`);
}

const caught = await core.catchUp();
console.log(`catch-up applied ${caught.applied}, skipped ${caught.skipped}; cursor ${caught.cursor}`);

const status = core.status();
console.log(`status: ${status.items} item(s), slice ${status.sliceTypes.join(",")}, hydration ${status.hydration}`);
