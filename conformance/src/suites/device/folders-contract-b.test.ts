import {
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  copyItemEvent,
  refusal,
  copyReplay,
  wireItem,
  wireEdge,
  answers,
} from "../../device/marfa-answers.js";
import { folderHarness, scriptWrites, type FolderHarness } from "./harness.js";

let harness: FolderHarness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});
const row = (n: number) => ({
  item: {
    id: `01a00000-0000-7000-8000-0000000004${String(n).padStart(2, "0")}`,
    version: 1,
    properties: { title: `Note ${String(n)}`, body: "body\n", status: "ready" },
  },
});
const tight = {
  search: { types: ["core.note"] },
  removal_threshold: { files: 2, fraction: 0.25 },
};

async function departing(
  label: string,
  state: "trashed" | "archived" = "trashed",
) {
  const rows = Array.from({ length: 6 }, (_, n) => row(n));
  const made = await folderHarness(label, {
    rows: { "core.note": rows },
    settings: { ...tight, search: { types: ["core.note"], state: ["active"] } },
    events: [
      copyReplay(
        "4",
        rows
          .slice(0, 3)
          .map((r, n) =>
            copyItemEvent(
              String(n + 2),
              state === "trashed" ? "item.deleted" : "item.state_changed",
              wireItem({ ...r.item, state }),
            ),
          ),
      ),
    ],
  });
  scriptWrites(made.server, {
    edges: [
      refusal(403, "edge_permission_denied", "the key cannot place this item"),
    ],
  });
  made.server.copyAnswer(
    "GET",
    /^\/edges\/[^/]+$/,
    refusal(404, "edge_not_found", "the edge is absent"),
  );
  expect((await made.folder.pull()).ok).toBe(true);
  expect((await made.folder.device().catchUp()).ok).toBe(true);
  return made;
}

it("says a pull-side removal waits in push output with both ways to resolve it", async () => {
  harness = await departing("contract-b-pause-text");
  const result = await harness.folder.pushText();
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  expect(result.value).toContain(
    "a large removal waits: 3 file(s) left in place whose items left elsewhere",
  );
  expect(result.value).toContain("folders confirm");
  expect(result.value).toContain("folders restore");
  expect(existsSync(join(harness.dir, "Note 0.md"))).toBe(true);
});

it.each(["trashed", "archived"] as const)(
  "confirms a paused pull removal of %s items",
  async (state) => {
    harness = await departing(`contract-b-confirm-${state}`, state);
    const paused = await harness.folder.pull();
    expect(paused.ok && paused.value.paused).toBe(3);
    expect(existsSync(join(harness.dir, "Note 0.md"))).toBe(true);
    const confirmed = await harness.folder.confirm();
    expect(confirmed.ok && confirmed.value.removed).toBe(3);
    for (const n of [0, 1, 2])
      expect(existsSync(join(harness.dir, `Note ${String(n)}.md`))).toBe(false);
    expect(existsSync(join(harness.dir, "Note 3.md"))).toBe(true);
  },
);

it.each(["trashed", "archived"] as const)(
  "restores a paused pull removal of %s items into a held state",
  async (state) => {
    harness = await departing(`contract-b-restore-${state}`, state);
    const paused = await harness.folder.pull();
    expect(paused.ok && paused.value.paused).toBe(3);
    const held = await harness.folder.status();
    expect(
      held.ok &&
        held.value.files
          .filter((f) => /^Note [012]\.md$/.test(f.path))
          .map((f) => f.flag),
    ).toEqual(["removal", "removal", "removal"]);
    const restored = await harness.folder.restore();
    expect(restored.ok && restored.value.restored).toBe(3);
    const queued = await harness.folder.device().queue();
    expect(
      queued.ok &&
        queued.value.filter(
          (r) =>
            r.kind ===
            (state === "trashed" ? "restore_item" : "transition_item"),
        ),
    ).toHaveLength(3);
    const status = await harness.folder.status();
    expect(status.ok && status.value.paused).toEqual({ disk: 0, pull: 0 });
    for (const n of [0, 1, 2])
      expect(existsSync(join(harness.dir, `Note ${String(n)}.md`))).toBe(true);
  },
);

it("does not count a missing unmatched file as put back when restoring a removal", async () => {
  const rows = Array.from({ length: 6 }, (_, n) => row(n));
  harness = await folderHarness("contract-b-restore-filter", {
    rows: { "core.note": rows },
    settings: {
      ...tight,
      search: { types: ["core.note"], filter: 'properties.status eq "ready"' },
    },
    events: [
      copyReplay("2", [
        copyItemEvent(
          "2",
          "item.updated",
          wireItem({
            ...rows[0]!.item,
            version: 2,
            properties: { ...rows[0]!.item.properties, status: "done" },
          }),
        ),
      ]),
    ],
  });
  expect((await harness.folder.pull()).ok).toBe(true);
  for (const n of [0, 1, 2]) rmSync(join(harness.dir, `Note ${String(n)}.md`));
  const paused = await harness.folder.scan();
  expect(paused.ok && paused.value.paused).toBe(3);
  expect((await harness.folder.device().catchUp()).ok).toBe(true);
  const restored = await harness.folder.restore();
  expect(restored.ok, JSON.stringify(restored)).toBe(true);
  if (!restored.ok) return;
  expect(restored.value.put_back).toBe(2);
  expect(existsSync(join(harness.dir, "Note 0.md"))).toBe(false);
  for (const n of [1, 2])
    expect(
      readFileSync(join(harness.dir, `Note ${String(n)}.md`), "utf8"),
    ).toContain("body");
  const scanned = await harness.folder.scan();
  expect(scanned.ok && scanned.value.missing).toBe(1);
});

it.each([
  { total: 12, missing: 10, paused: 0 },
  { total: 12, missing: 11, paused: 11 },
  { total: 44, missing: 11, paused: 0 },
  { total: 44, missing: 12, paused: 12 },
])(
  "pauses only past both default removal thresholds ($missing of $total)",
  async ({ total, missing, paused }) => {
    harness = await folderHarness("contract-b-threshold", {
      rows: { "core.note": Array.from({ length: total }, (_, n) => row(n)) },
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    for (let n = 0; n < missing; n += 1)
      rmSync(join(harness.dir, `Note ${String(n)}.md`));
    const scanned = await harness.folder.scan();
    expect(scanned.ok && scanned.value.paused).toBe(paused);
    const status = await harness.folder.status();
    expect(status.ok && status.value.paused).toEqual({ disk: paused, pull: 0 });
  },
);

it("reads status from disk and the held copy without contacting the server", async () => {
  harness = await folderHarness("contract-b-status-local", {
    rows: { "core.note": [row(0)] },
  });
  expect((await harness.folder.pull()).ok).toBe(true);
  const before = harness.server.requests.length;
  writeFileSync(join(harness.dir, "unbound.bin"), "unbound bytes");
  const status = await harness.folder.status();
  expect(
    status.ok &&
      status.value.files.find((f) => f.path === "unbound.bin")?.status,
  ).toBe("outside");
  expect(harness.server.requests).toHaveLength(before);
});

it("refuses restore while first sync waits and confirms without a server request", async () => {
  harness = await folderHarness("contract-b-first-confirm", {
    rows: { "core.note": [row(0)] },
    confirm: false,
  });
  const before = harness.server.requests.length;
  const restore = await harness.folder.restore();
  expect(restore.ok).toBe(false);
  if (!restore.ok) expect(restore.refusal.raw).toContain("first_sync_waiting");
  expect((await harness.folder.confirm()).ok).toBe(true);
  expect(harness.server.requests).toHaveLength(before);
  const status = await harness.folder.status();
  expect(status.ok && status.value.first_sync).toBeUndefined();
});

it("keeps every built-in machine, temporary and secret name outside admission", async () => {
  const machine = [
    ".DS_Store",
    "Thumbs.db",
    "._note",
    ".Spotlight-V100",
    ".Trashes",
    "Icon\r",
    "desktop.ini",
  ];
  const temporary = [
    "note.swp",
    "note~",
    ".#note",
    "#note#",
    "~$note",
    "note.tmp",
    ".~lock.note#",
    "note___jb_tmp___",
    "note___jb_old___",
    "note.crdownload",
    "note.crswap",
    "note.part",
    "note.download",
  ];
  const secrets = [
    ".env",
    ".env.example",
    "server.pem",
    "Deck.key",
    "cert.p12",
    "cert.pfx",
    "id_rsa.pub",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    ".netrc",
    ".npmrc",
    ".pypirc",
    ".pgpass",
    ".git-credentials",
    "credentials",
    "appcredentials.json",
    "credentials.db",
  ];
  harness = await folderHarness("contract-b-builtins", {
    settings: {
      search: { types: ["core.note", "core.file"] },
      include: ["*", ...machine, ...temporary, ...secrets],
      ignore: secrets.map((name) => `!${name}`),
    },
  });
  for (const name of [...machine, ...temporary, ...secrets])
    writeFileSync(join(harness.dir, name), "private fixture bytes");
  writeFileSync(join(harness.dir, "allowed.md"), "a note\n");
  const scan = await harness.folder.scan();
  expect(scan.ok && scan.value.created).toBe(1);
  expect(scan.ok && [...scan.value.secrets].sort()).toEqual(
    [...secrets].sort(),
  );
  const queue = await harness.folder.device().queue();
  expect(
    queue.ok && queue.value.filter((r) => r.kind === "create_item"),
  ).toHaveLength(1);
});

it("reports every built-in package extension without scanning its contents", async () => {
  harness = await folderHarness("contract-b-packages");
  const packages = [
    "app",
    "bundle",
    "pages",
    "numbers",
    "key",
    "photoslibrary",
    "xcodeproj",
    "rtfd",
  ].map((ext) => `Thing.${ext.toUpperCase()}`);
  for (const name of packages) {
    mkdirSync(join(harness.dir, name));
    writeFileSync(join(harness.dir, name, "inside.md"), "inside\n");
  }
  writeFileSync(join(harness.dir, "outside.md"), "outside\n");
  const scan = await harness.folder.scan();
  expect(scan.ok && scan.value.created).toBe(1);
  expect(
    scan.ok && scan.value.directories.map((d) => [d.path, d.flag]).sort(),
  ).toEqual(packages.map((p) => [p, "package"]).sort());
});

it("does not send a placement for a rename changing only case", async () => {
  harness = await folderHarness("contract-b-case-rename", {
    rows: { "core.note": [row(0)] },
  });
  expect((await harness.folder.pull()).ok).toBe(true);
  const before = await harness.folder.device().queue();
  expect(before.ok).toBe(true);
  renameSync(join(harness.dir, "Note 0.md"), join(harness.dir, "note 0.md"));
  const scan = await harness.folder.scan();
  expect(scan.ok).toBe(true);
  const after = await harness.folder.device().queue();
  expect(after.ok && after.value.map((r) => r.id)).toEqual(
    before.ok && before.value.map((r) => r.id),
  );
});

it("does not scan a symlinked file or directory even when included", async () => {
  harness = await folderHarness("contract-b-links", {
    files: { "source.md": "source\n" },
  });
  symlinkSync(join(harness.dir, "source.md"), join(harness.dir, "alias.md"));
  mkdirSync(join(harness.dir, "actual"));
  writeFileSync(join(harness.dir, "actual", "real.md"), "real\n");
  symlinkSync(join(harness.dir, "actual"), join(harness.dir, "linked"));
  const scan = await harness.folder.scan();
  expect(scan.ok && scan.value.created).toBe(2);
  const status = await harness.folder.status();
  expect(status.ok && status.value.files.map((f) => f.path).sort()).toEqual([
    "actual/real.md",
    "source.md",
  ]);
});

it("reports purged paused files without promising that restore can recover their items", async () => {
  const rows = Array.from({ length: 6 }, (_, n) => row(n));
  harness = await folderHarness("contract-b-purged-pause", {
    rows: { "core.note": rows },
    settings: tight,
    events: [
      copyReplay(
        "4",
        rows
          .slice(0, 3)
          .map((r, n) =>
            copyItemEvent(
              String(n + 2),
              "item.purged",
              wireItem({ ...r.item, state: "trashed" }),
            ),
          ),
      ),
    ],
  });
  expect((await harness.folder.pull()).ok).toBe(true);
  expect((await harness.folder.device().catchUp()).ok).toBe(true);
  const paused = await harness.folder.pull();
  expect(paused.ok && paused.value.paused).toBe(3);
  const status = await harness.folder.status();
  expect(status.ok).toBe(true);
  if (!status.ok) return;
  const gone = status.value.files.filter((f) =>
    /^Note [012]\.md$/.test(f.path),
  );
  expect(gone).toHaveLength(3);
  for (const file of gone) {
    expect(file.flag).toBe("removal");
    expect(file.reason).toContain("purged");
    expect(file.reason).not.toContain("brings its item back");
  }
  const restored = await harness.folder.restore();
  expect(restored.ok && restored.value.restored).toBe(0);
  expect(existsSync(join(harness.dir, "Note 0.md"))).toBe(true);
  const confirmed = await harness.folder.confirm();
  expect(confirmed.ok && confirmed.value.removed).toBe(3);
  expect(existsSync(join(harness.dir, "Note 0.md"))).toBe(false);
});

it("applies include negation, ignore precedence and case-normalized patterns", async () => {
  harness = await folderHarness("contract-b-list-composition", {
    settings: {
      search: { types: ["core.note"] },
      include: ["*.MD", "!excluded.md", ".hidden.md"],
      ignore: ["ignored.md"],
    },
  });
  for (const name of ["allowed.md", "excluded.md", "IGNORED.md", ".hidden.md"])
    writeFileSync(join(harness.dir, name), "note\n");
  const scan = await harness.folder.scan();
  expect(scan.ok && scan.value.created).toBe(2);
  const status = await harness.folder.status();
  expect(status.ok && status.value.files.map((f) => f.path).sort()).toEqual([
    ".hidden.md",
    "allowed.md",
  ]);
});

it("reports a bound file as unreached when settings exclude it", async () => {
  harness = await folderHarness("contract-b-unreached-status", {
    rows: { "core.note": [row(0)] },
  });
  expect((await harness.folder.pull()).ok).toBe(true);
  const settingsPath = join(harness.dir, ".marfa", "folder.yaml");
  // The stored server settings are read by a fresh hydration, not inferred
  // from an unsent edit of the local settings file.
  harness.settings.settings = {
    search: { types: ["core.note"] },
    ignore: ["*.md"],
  };
  harness.settings.version += 1;
  expect((await harness.folder.hydrate()).ok).toBe(true);
  const status = await harness.folder.status();
  expect(
    status.ok && status.value.files.find((f) => f.path === "Note 0.md")?.status,
  ).toBe("unreached");
  expect(existsSync(settingsPath)).toBe(true);
});

it("refuses a pull during first sync and uses the directory as it stands after confirmation", async () => {
  harness = await folderHarness("contract-b-first-current", {
    hydrate: false,
    rows: { "core.note": [row(0)] },
    files: { "old.md": "old\n" },
    confirm: false,
  });
  const pulled = await harness.folder.pull();
  expect(!pulled.ok && pulled.refusal.raw).toContain("first_sync_waiting");
  writeFileSync(join(harness.dir, "later.md"), "later\n");
  expect((await harness.folder.confirm()).ok).toBe(true);
  const scanned = await harness.folder.scan();
  expect(scanned.ok && scanned.value.created).toBe(1);
  const status = await harness.folder.status();
  expect(
    status.ok && status.value.files.find((f) => f.path === "later.md")?.waits,
  ).toContain("create");
});

it("does not confirm a paused deletion for a file put back since the pause", async () => {
  harness = await folderHarness("contract-b-confirm-returned", {
    rows: { "core.note": Array.from({ length: 6 }, (_, n) => row(n)) },
    settings: tight,
  });
  expect((await harness.folder.pull()).ok).toBe(true);
  const original = readFileSync(join(harness.dir, "Note 0.md"));
  for (const n of [0, 1, 2]) rmSync(join(harness.dir, `Note ${String(n)}.md`));
  const paused = await harness.folder.scan();
  expect(paused.ok && paused.value.paused).toBe(3);
  writeFileSync(join(harness.dir, "Note 0.md"), original);
  const confirmed = await harness.folder.confirm();
  expect(confirmed.ok && confirmed.value.deleted).toBe(2);
  const queued = await harness.folder.device().queue();
  expect(
    queued.ok &&
      queued.value
        .filter((r) => r.kind === "delete_item")
        .map((r) => r.item_id)
        .sort(),
  ).toEqual([row(1).item.id, row(2).item.id]);
  expect(readFileSync(join(harness.dir, "Note 0.md"))).toEqual(original);
});

it.each(["include", "ignore"] as const)(
  "refuses an invalid %s pattern before admission",
  async (list) => {
    await expect(
      folderHarness(`contract-b-invalid-${list}`, {
        settings: { search: { types: ["core.note"] }, [list]: ["a{b"] },
      }),
    ).rejects.toThrow(/pattern|glob/i);
  },
);

it("refuses every parent component in a placement even when it climbs back inside", async () => {
  const rows = [row(0), row(1)];
  harness = await folderHarness("contract-b-parent-path", {
    rows: { "core.note": rows },
    hydrate: false,
  });
  Object.assign(rows[0]!.item, {
    edges: {
      "in-folder": {
        data: [
          wireEdge({
            id: "01a00000-0000-7000-8000-000000004444",
            source_id: rows[0]!.item.id,
            target_id: harness.settings.id,
            edge_type: "in-folder",
            properties: { path: "Elsewhere/../inside.md" },
          }),
        ],
        next_cursor: null,
      },
    },
  });
  expect((await harness.folder.hydrate()).ok).toBe(true);
  const pulled = await harness.folder.pull();
  expect(pulled.ok && [pulled.value.outside, pulled.value.written]).toEqual([
    1, 1,
  ]);
  expect(existsSync(join(harness.dir, "inside.md"))).toBe(false);
  expect(existsSync(join(harness.dir, "Note 1.md"))).toBe(true);
});

it.each(["create", "edit"] as const)(
  "preserves a document after a request-too-large %s refusal",
  async (kind) => {
    harness = await folderHarness(`contract-b-size-refusal-${kind}`, {
      rows: { "core.note": kind === "edit" ? [row(0)] : [] },
    });
    if (kind === "edit") expect((await harness.folder.pull()).ok).toBe(true);
    const path = join(harness.dir, kind === "edit" ? "Note 0.md" : "new.md");
    const before =
      kind === "edit" ? readFileSync(path, "utf8") : "new document\n";
    const bytes = before + "changed\n";
    writeFileSync(path, bytes);
    scriptWrites(harness.server, {
      create: [refusal(413, "request_too_large", "request body too large")],
      update: [refusal(413, "request_too_large", "request body too large")],
      read: [
        kind === "edit"
          ? answers.updated(wireItem(row(0).item))
          : refusal(404, "item_not_found", "no item"),
      ],
      edges: [refusal(403, "edge_permission_denied", "no placement")],
    });
    harness.server.copyAnswer(
      "GET",
      /^\/edges\/[^/]+$/,
      refusal(404, "edge_not_found", "no edge"),
    );
    const pushed = await harness.folder.push();
    expect(pushed.ok, JSON.stringify(pushed)).toBe(true);
    expect(
      pushed.ok &&
        pushed.value.drain.verdicts.some(
          (v) => v.verdict === "refused" && v.reason === "request_too_large",
        ),
    ).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(bytes);
    const status = await harness.folder.status();
    expect(
      status.ok &&
        status.value.files.find(
          (f) => f.path === (kind === "edit" ? "Note 0.md" : "new.md"),
        )?.flag,
    ).toBe(kind === "edit" ? "refused" : "lost");
  },
);
