import {
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  symlinkSync,
  chmodSync,
  statSync,
  realpathSync,
  cpSync,
  mkdtempSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CliFolder } from "../../device/cli-adapter.js";
import { keychainEnv } from "../../utils/keychain.js";
const execute = promisify(execFile);
import { afterEach, describe, expect, it } from "vitest";
import {
  copyItemEvent,
  refusal,
  copyReplay,
  wireItem,
  wireEdge,
  answers,
  typeCatalog,
  wireType,
  itemsPage,
} from "../../device/marfa-answers.js";
import {
  folderHarness,
  scriptWrites,
  scriptBlob,
  hashOf,
  KEY,
  requireBinary,
  type FolderHarness,
} from "./harness.js";

let harness: FolderHarness | undefined;
let second: FolderHarness | undefined;
afterEach(async () => {
  await second?.stop();
  second = undefined;
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

it.each(["CAFÉ.md", "Cafe\u0301.md"])(
  "does not send a placement for an equivalent rename to %s",
  async (name) => {
    harness = await folderHarness("contract-b-case-rename", {
      rows: {
        "core.note": [
          {
            item: {
              ...row(0).item,
              properties: { ...row(0).item.properties, title: "Café" },
            },
          },
        ],
      },
    });
    expect((await harness.folder.pull()).ok).toBe(true);
    const before = await harness.folder.device().queue();
    expect(before.ok).toBe(true);
    renameSync(join(harness.dir, "Café.md"), join(harness.dir, name));
    const scan = await harness.folder.scan();
    expect(scan.ok).toBe(true);
    const after = await harness.folder.device().queue();
    expect(after.ok && after.value.map((r) => r.id)).toEqual(
      before.ok && before.value.map((r) => r.id),
    );
  },
);

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

it("warns at the exact JSON-encoded size boundary including escaped text", async () => {
  const prefix = "---\ntype: user.large_text\n---\n";
  const limit = 943718;
  const plain = (size: number) =>
    prefix + "x".repeat(size - JSON.stringify(prefix).length);
  const escapedCount = Math.floor((limit - JSON.stringify(prefix).length) / 2);
  const escaped =
    prefix +
    '"'.repeat(escapedCount) +
    "x".repeat((limit - JSON.stringify(prefix).length) % 2);
  expect(JSON.stringify(plain(limit - 1)).length).toBe(limit - 1);
  expect(JSON.stringify(plain(limit)).length).toBe(limit);
  expect(JSON.stringify(escaped).length).toBe(limit);
  harness = await folderHarness("contract-b-size-boundary", {
    settings: { search: { types: ["user.large_text"] } },
    catalog: typeCatalog([
      wireType("user.large_text", {
        bodyField: "body",
        fields: {
          title: { type: "string" },
          body: { type: "string", maxLength: 1_000_000 },
        },
      }),
    ]),
  });
  writeFileSync(join(harness.dir, "below.md"), plain(limit - 1));
  writeFileSync(join(harness.dir, "at.md"), plain(limit));
  writeFileSync(join(harness.dir, "escaped.md"), escaped);
  const scanned = await harness.folder.scan();
  expect(scanned.ok && scanned.value.created).toBe(3);
  expect(
    scanned.ok && scanned.value.warnings.map((f) => f.path).sort(),
  ).toEqual(["at.md", "escaped.md"]);
  if (scanned.ok)
    for (const warning of scanned.value.warnings)
      expect(warning.reason).toContain(`${String(limit)} bytes`);
  const status = await harness.folder.status();
  expect(
    status.ok &&
      status.value.files
        .filter((f) => f.warning !== undefined)
        .map((f) => f.path)
        .sort(),
  ).toEqual(["at.md", "escaped.md"]);
});

it("keeps confirmed missing files unsure while another registered folder is unavailable", async () => {
  harness = await folderHarness("contract-b-confirm-unsure", {
    rows: { "core.note": Array.from({ length: 6 }, (_, n) => row(n)) },
    settings: tight,
  });
  second = await folderHarness("contract-b-confirm-peer", {
    sharing: { server: harness.server, key: KEY },
    registry: harness.registry,
    settings: { search: { types: ["core.bookmark"] } },
  });
  expect((await harness.folder.pull()).ok).toBe(true);
  for (const n of [0, 1, 2]) rmSync(join(harness.dir, `Note ${String(n)}.md`));
  const paused = await harness.folder.scan();
  expect(paused.ok && paused.value.paused).toBe(3);
  const away = second.dir + "-away";
  renameSync(second.dir, away);
  try {
    const result = await harness.folder.device().root<{
      deleted: number;
      unsure: Array<{ path: string; reason: string }>;
    }>(["folders", "confirm", harness.dir]);
    expect(result.ok && result.value.deleted).toBe(0);
    expect(result.ok && result.value.unsure.map((f) => f.path).sort()).toEqual([
      "Note 0.md",
      "Note 1.md",
      "Note 2.md",
    ]);
    const queued = await harness.folder.device().queue();
    expect(
      queued.ok && queued.value.filter((r) => r.kind === "delete_item"),
    ).toEqual([]);
  } finally {
    renameSync(away, second.dir);
  }
  const confirmed = await harness.folder.confirm();
  expect(confirmed.ok).toBe(true);
  // Once the folder can be checked, ordinary scans can settle the deletion.
  await new Promise((resolve) => setTimeout(resolve, 6000));
  const rescanned = await harness.folder.scan();
  expect(rescanned.ok && rescanned.value.paused).toBe(3);
  const released = await harness.folder.confirm();
  expect(released.ok && released.value.deleted).toBe(3);
});

it("registers the resolved directory, followed folder and store identity", async () => {
  harness = await folderHarness("contract-b-registry-store");
  const registry = JSON.parse(readFileSync(harness.registry, "utf8")) as {
    folders: Array<{ dir: string; folder: string; store: string }>;
  };
  expect(registry.folders).toHaveLength(1);
  expect(registry.folders[0]).toMatchObject({
    dir: realpathSync(harness.dir),
    folder: harness.settings.id,
    store: expect.any(String),
  });
  expect(registry.folders[0]!.store.length).toBeGreaterThan(0);
});

async function fileHarness(label: string) {
  const bytes = Buffer.from("file bytes");
  const item = {
    id: row(0).item.id,
    type: "core.file",
    version: 1,
    properties: {
      title: "file.bin",
      blob_ref: hashOf(bytes),
      mime_type: "application/octet-stream",
      executable: false,
    },
  };
  const made = await folderHarness(label, {
    settings: { search: { types: ["core.file", "core.note"] } },
    rows: { "core.file": [{ item }], "core.note": [row(1)] },
    events: [
      copyReplay("3", [
        copyItemEvent(
          "2",
          "item.updated",
          wireItem({
            ...item,
            version: 2,
            properties: { ...item.properties, executable: true },
          }),
        ),
        copyItemEvent("3", "item.created", wireItem(row(2).item)),
      ]),
    ],
  });
  scriptBlob(made.server, bytes);
  return made;
}

it("applies execute bits only where each read bit is set", async () => {
  harness = await fileHarness("contract-b-execute-bits");
  expect((await harness.folder.pull()).ok).toBe(true);
  chmodSync(join(harness.dir, "file.bin"), 0o640);
  expect((await harness.folder.scan()).ok).toBe(true);
  expect((await harness.folder.device().catchUp()).ok).toBe(true);
  expect((await harness.folder.pull()).ok).toBe(true);
  expect(statSync(join(harness.dir, "file.bin")).mode & 0o777).toBe(0o750);
});

it("leaves executable permissions alone when its permission probe fails", async () => {
  harness = await fileHarness("contract-b-no-permissions");
  expect((await harness.folder.pull()).ok).toBe(true);
  mkdirSync(join(harness.dir, ".marfa", ".permission-probe"));
  chmodSync(join(harness.dir, "file.bin"), 0o640);
  expect((await harness.folder.scan()).ok).toBe(true);
  expect((await harness.folder.device().catchUp()).ok).toBe(true);
  expect((await harness.folder.pull()).ok).toBe(true);
  expect(statSync(join(harness.dir, "file.bin")).mode & 0o777).toBe(0o640);
  const queued = await harness.folder.device().queue();
  expect(
    queued.ok && queued.value.filter((r) => r.kind === "update_item"),
  ).toEqual([]);
});

async function fault<T>(name: string, action: () => Promise<T>): Promise<T> {
  const previous = process.env.MARFA_TEST_FAULT;
  process.env.MARFA_TEST_FAULT = name;
  try {
    return await action();
  } finally {
    if (previous === undefined) delete process.env.MARFA_TEST_FAULT;
    else process.env.MARFA_TEST_FAULT = previous;
  }
}

describe.runIf(process.platform === "darwin")("quarantine failures", () => {
  it("refuses a new downloaded file when quarantine marking fails and retries it", async () => {
    harness = await fileHarness("contract-b-quarantine-fails");
    const failed = await fault("quarantine-fails", () =>
      harness!.folder.pull(),
    );
    expect(failed.ok && [failed.value.unwritten, failed.value.written]).toEqual(
      [1, 1],
    );
    expect(existsSync(join(harness.dir, "file.bin"))).toBe(false);
    expect(existsSync(join(harness.dir, "Note 1.md"))).toBe(true);
    const recovered = await harness.folder.pull();
    expect(recovered.ok && recovered.value.written).toBe(1);
    expect(readFileSync(join(harness.dir, "file.bin"), "utf8")).toBe(
      "file bytes",
    );
  });

  it("keeps an existing file nonexecutable when quarantine marking fails", async () => {
    harness = await fileHarness("contract-b-quarantine-existing");
    expect((await harness.folder.pull()).ok).toBe(true);
    expect((await harness.folder.scan()).ok).toBe(true);
    expect((await harness.folder.device().catchUp()).ok).toBe(true);
    expect(
      (await fault("quarantine-fails", () => harness!.folder.pull())).ok,
    ).toBe(true);
    expect(statSync(join(harness.dir, "file.bin")).mode & 0o111).toBe(0);
    expect((await harness.folder.pull()).ok).toBe(true);
    expect(statSync(join(harness.dir, "file.bin")).mode & 0o111).toBe(0o111);
  });
});

it("keeps a file's permissions when a permission change is refused and continues pulling", async () => {
  harness = await fileHarness("contract-b-permission-fails");
  expect((await harness.folder.pull()).ok).toBe(true);
  expect((await harness.folder.scan()).ok).toBe(true);
  expect((await harness.folder.device().catchUp()).ok).toBe(true);
  const failed = await fault("permission-change-fails", () =>
    harness!.folder.pull(),
  );
  expect(failed.ok && failed.value.written).toBe(1);
  expect(existsSync(join(harness.dir, "Note 2.md"))).toBe(true);
  expect(statSync(join(harness.dir, "file.bin")).mode & 0o111).toBe(0);
  expect((await harness.folder.pull()).ok).toBe(true);
  expect(statSync(join(harness.dir, "file.bin")).mode & 0o111).toBe(0o111);
});

it("chooses a bound path before path order when names compare equal", async () => {
  harness = await folderHarness("contract-b-case-sensitive");
  const scratch = mkdtempSync(join(tmpdir(), "marfa-case-sensitive-"));
  const mount = join(scratch, "volume");
  mkdirSync(mount);
  let attached = false;
  try {
    if (process.platform === "darwin") {
      const image = join(scratch, "case.sparseimage");
      await execute("hdiutil", [
        "create",
        "-size",
        "256m",
        "-type",
        "SPARSE",
        "-fs",
        "Case-sensitive APFS",
        "-volname",
        "conformance",
        image,
      ]);
      await execute("hdiutil", [
        "attach",
        image,
        "-mountpoint",
        mount,
        "-nobrowse",
        "-noautoopen",
      ]);
      attached = true;
    }
    const dir = join(mount, "notes");
    cpSync(harness.dir, dir, { recursive: true });
    rmSync(harness.dir, { recursive: true });
    harness.dir = dir;
    harness.folder = new CliFolder(dir, {
      binary: requireBinary(),
      url: harness.server.url,
      key: KEY,
      registry: harness.registry,
    });
    writeFileSync(join(dir, "alpha.md"), "already bound\n");
    expect((await harness.folder.scan()).ok).toBe(true);
    writeFileSync(join(dir, "Alpha.md"), "unbound earlier path\n");
    writeFileSync(join(dir, "BETA.md"), "unbound earlier beta\n");
    writeFileSync(join(dir, "beta.md"), "unbound later beta\n");
    expect(statSync(join(dir, "alpha.md")).ino).not.toBe(
      statSync(join(dir, "Alpha.md")).ino,
    );
    const scanned = await harness.folder.scan();
    expect(scanned.ok && scanned.value.created).toBe(1);
    expect(
      scanned.ok && scanned.value.flagged.map((f) => [f.path, f.flag]).sort(),
    ).toEqual([
      ["Alpha.md", "name"],
      ["beta.md", "name"],
    ]);
    renameSync(join(dir, "Alpha.md"), join(dir, "distinct.md"));
    const renamed = await harness.folder.scan();
    expect(renamed.ok && renamed.value.created).toBe(1);
  } finally {
    if (attached) await execute("hdiutil", ["detach", mount]);
    rmSync(scratch, { recursive: true, force: true });
  }
});

it.each(["yes", "no"])(
  "asks before first sync at a terminal and obeys %s",
  async (answer) => {
    harness = await folderHarness("contract-b-terminal", {
      rows: { "core.note": [row(0)] },
      confirm: false,
    });
    const args = [
      requireBinary(),
      "folders",
      "add",
      harness.dir,
      "--folder",
      harness.settings.id,
      "--url",
      harness.server.url,
      "--key",
      KEY,
    ];
    const terminal = String.raw`
import errno, os, pty, select, signal, sys, time
answer = sys.argv[1]
pid, master = pty.fork()
if pid == 0:
    os.execv(sys.argv[2], sys.argv[2:])
output = b""
answered = False
finished = False
try:
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if not select.select([master], [], [], 0.1)[0]:
            continue
        try:
            chunk = os.read(master, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                break
            raise
        if not chunk:
            break
        output += chunk
        sys.stdout.buffer.write(chunk)
        sys.stdout.buffer.flush()
        if not answered and b"Go ahead? [y/N]" in output:
            os.write(master, (answer + "\n").encode())
            answered = True
    else:
        raise RuntimeError("terminal command did not finish")
    _, status = os.waitpid(pid, 0)
    finished = True
    sys.exit(os.waitstatus_to_exitcode(status))
finally:
    if not finished:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    os.close(master)
`;
    const { stdout: output } = await execute(
      "python3",
      ["-c", terminal, answer, ...args],
      {
        env: {
          ...process.env,
          ...keychainEnv(),
          MARFA_FOLDER_REGISTRY: harness.registry,
        },
      },
    );
    expect(output).toContain("Go ahead? [y/N]");
    const status = await harness.folder.status();
    expect(status.ok).toBe(true);
    if (status.ok)
      expect(status.value.first_sync !== undefined).toBe(answer === "no");
  },
);

it("keeps first sync confirmed after a failed landing and after adding the folder again", async () => {
  harness = await folderHarness("contract-b-confirm-persist", {
    rows: { "core.note": [row(0)] },
    confirm: false,
  });
  expect((await harness.folder.confirm()).ok).toBe(true);
  const failed = await fault("sync-failure=Note 0.md", () =>
    harness!.folder.pull(),
  );
  expect(failed.ok && failed.value.unwritten).toBe(1);
  const status = await harness.folder.status();
  expect(status.ok && status.value.first_sync).toBeUndefined();
  const added = await harness.folder.add(harness.settings.id, {
    confirm: false,
  });
  expect(added.ok && added.value.first_sync.waiting).toBe(false);
  const recovered = await harness.folder.pull();
  expect(recovered.ok && recovered.value.written).toBe(1);
});

it("writes an archived embedded file anew without counting it as put back", async () => {
  const bytes = Buffer.from("embedded bytes");
  const host = row(0).item;
  host.properties.body = "![](file.bin)\n";
  const file = {
    id: row(1).item.id,
    type: "core.file",
    version: 1,
    properties: {
      title: "file.bin",
      blob_ref: hashOf(bytes),
      mime_type: "application/octet-stream",
    },
  };
  harness = await folderHarness("contract-b-restore-embed", {
    settings: {
      search: { types: ["core.note"], state: ["active"] },
      removal_threshold: { files: 0, fraction: 0 },
    },
    rows: { "core.note": [{ item: host }], "core.file": [{ item: file }] },
    edges: {
      "attached-to": [
        {
          id: "01a00000-0000-7000-8000-000000008888",
          source_id: file.id,
          target_id: host.id,
          edge_type: "attached-to",
        },
      ],
    },
    events: [
      copyReplay("2", [
        copyItemEvent(
          "2",
          "item.state_changed",
          wireItem({ ...file, state: "archived" }),
        ),
      ]),
    ],
  });
  let archived = false;
  harness.server.copyAnswer("GET", `/items/${file.id}`, () =>
    answers.updated(
      wireItem({ ...file, state: archived ? "archived" : "active" }),
    ),
  );
  scriptBlob(harness.server, bytes);
  expect((await harness.folder.pull()).ok).toBe(true);
  expect(readFileSync(join(harness.dir, "file.bin"))).toEqual(bytes);
  rmSync(join(harness.dir, "file.bin"));
  const paused = await harness.folder.scan();
  expect(paused.ok && paused.value.paused).toBe(1);
  expect((await harness.folder.device().catchUp()).ok).toBe(true);
  archived = true;
  const restored = await harness.folder.restore();
  expect(restored.ok && restored.value.put_back).toBe(0);
  expect(readFileSync(join(harness.dir, "file.bin"))).toEqual(bytes);
  const scan = await harness.folder.scan();
  expect(scan.ok && scan.value.missing).toBe(0);
});

it("matches include names in NFC regardless of case and asks server names in both forms", async () => {
  harness = await folderHarness("contract-b-unicode-list", {
    settings: { search: { types: ["core.note"] }, include: ["CAFÉ.md"] },
  });
  writeFileSync(join(harness.dir, "Cafe\u0301.md"), "unicode note\n");
  writeFileSync(join(harness.dir, "other.md"), "other\n");
  const scan = await harness.folder.scan();
  expect(scan.ok && scan.value.created).toBe(1);
  await harness.stop();
  harness = undefined;
  const looked: string[] = [];
  harness = await folderHarness("contract-b-unicode-lookup", {
    lookup: (text) => {
      looked.push(text);
      return itemsPage([]);
    },
  });
  writeFileSync(join(harness.dir, "source.md"), "[[Café]]\n");
  scriptWrites(harness.server, {
    create: [refusal(413, "request_too_large", "fixture refuses create")],
    read: [refusal(404, "item_not_found", "fixture holds no item")],
  });
  harness.server.copyAnswer(
    "GET",
    /^\/edges\/[^/]+$/,
    refusal(404, "edge_not_found", "no edge"),
  );
  expect((await harness.folder.push()).ok).toBe(true);
  expect(looked).toContain("Café");
  expect(looked).toContain("Cafe\u0301");
});

it.each(["ignore", "dot directory"])(
  "matches Unicode %s patterns with the folder name equivalence",
  async (kind) => {
    harness = await folderHarness("contract-b-unicode-other-lists", {
      settings: {
        search: { types: ["core.note"] },
        include: kind === "ignore" ? ["*"] : [".CAFÉ/**"],
        ignore: kind === "ignore" ? ["CAFÉ.md"] : [],
      },
    });
    if (kind === "ignore") {
      writeFileSync(join(harness.dir, "Cafe\u0301.md"), "excluded\n");
      writeFileSync(join(harness.dir, "witness.md"), "included\n");
    } else {
      mkdirSync(join(harness.dir, ".Cafe\u0301"));
      writeFileSync(
        join(harness.dir, ".Cafe\u0301", "inside.md"),
        "included\n",
      );
      mkdirSync(join(harness.dir, ".other"));
      writeFileSync(join(harness.dir, ".other", "outside.md"), "excluded\n");
    }
    const scan = await harness.folder.scan();
    expect(scan.ok && scan.value.created).toBe(1);
    const status = await harness.folder.status();
    expect(status.ok && status.value.files.map((file) => file.path)).toEqual([
      kind === "ignore" ? "witness.md" : ".Cafe\u0301/inside.md",
    ]);
  },
);

it.runIf(process.platform === "darwin")(
  "leaves file and item executable values alone on an exFAT volume",
  async () => {
    harness = await fileHarness("contract-b-exfat");
    expect((await harness.folder.pull()).ok).toBe(true);
    const scratch = mkdtempSync(join(tmpdir(), "marfa-exfat-"));
    const mount = join(scratch, "volume");
    mkdirSync(mount);
    const image = join(scratch, "volume.sparseimage");
    let attached = false;
    try {
      await execute("hdiutil", [
        "create",
        "-size",
        "256m",
        "-type",
        "SPARSE",
        "-fs",
        "ExFAT",
        "-volname",
        "conformance",
        image,
      ]);
      await execute("hdiutil", [
        "attach",
        image,
        "-mountpoint",
        mount,
        "-nobrowse",
        "-noautoopen",
      ]);
      attached = true;
      const dir = join(mount, "notes");
      cpSync(harness.dir, dir, { recursive: true });
      rmSync(harness.dir, { recursive: true });
      harness.dir = dir;
      harness.folder = new CliFolder(dir, {
        binary: requireBinary(),
        url: harness.server.url,
        key: KEY,
        registry: harness.registry,
      });
      const path = join(dir, "file.bin");
      chmodSync(path, 0o644);
      expect(statSync(path).mode & 0o100).toBe(0o100);
      const originalMode = statSync(path).mode & 0o777;
      const scanned = await harness.folder.scan();
      expect(scanned.ok && scanned.value.updated).toBe(0);
      const item = await harness.folder.device().get(row(0).item.id);
      expect(item.ok && item.value.properties.executable).toBe(false);
      const queued = await harness.folder.device().queue();
      expect(
        queued.ok &&
          queued.value.filter((write) => write.kind === "update_item"),
      ).toEqual([]);
      expect((await harness.folder.pull()).ok).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(originalMode);
      expect(readFileSync(path, "utf8")).toBe("file bytes");
    } finally {
      if (attached) await execute("hdiutil", ["detach", mount]);
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);
