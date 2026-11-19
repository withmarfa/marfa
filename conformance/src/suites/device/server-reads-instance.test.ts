import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SCRIPTED_INSTANCE,
  answers,
  bulkGetOf,
  certifiedRead,
  copyLiveReplay,
  refusal,
  typeCatalog,
  wireItem,
  wireType,
  type WireItemOptions,
} from "../../device/marfa-answers.js";
import { Cli } from "../cli/harness.js";
import { keychainEnv } from "../../utils/keychain.js";
import { ON_MACOS } from "../../utils/platform.js";
import type { Outcome } from "../../device/protocol.js";
import {
  BUILT_FOR,
  type RecordedRequest,
} from "../../device/scripted-server.js";
import {
  KEY,
  folderHarness,
  hashOf,
  requireBinary,
  scriptBlob,
  scriptHydration,
  startHarness,
  type FolderHarness,
  type Harness,
} from "./harness.js";
import {
  EdgeDoor,
  scriptFolderWrites,
  sentEdgeWrites,
} from "./folders.shared.js";

const REPLACED = "00000000-0000-7000-8000-0000000000ff";
const ITEM = "01a00000-0000-7000-8000-00000000000a";
const LINKED = "01a00000-0000-7000-8000-00000000e106";
const OTHER_LINKED = "01a00000-0000-7000-8000-00000000e107";

let harness: Harness | undefined;
let folder: FolderHarness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
  await folder?.stop();
  folder = undefined;
});

function value<T>(outcome: Outcome<T>): T {
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  if (!outcome.ok) throw new Error(outcome.refusal.raw);
  return outcome.value;
}

const ROWS: [string[], unknown] = [
  ["list", ITEM, "steps"],
  { data: [], next_cursor: null },
];
const ROW: [string[], unknown] = [
  ["get", ITEM, "steps", "r1"],
  { id: "r1", values: {}, updated_at: "2026-01-01T00:00:00.000Z" },
];
const TOTALS: [string[], unknown] = [
  ["totals", ITEM, "steps"],
  { row_count: 0, totals: {} },
];

async function refusesAnotherInstance([args, body]: [string[], unknown]) {
  harness = await startHarness("server-reads-table");
  const { server, device } = harness;
  let instance = SCRIPTED_INSTANCE;
  server.copyAnswer("GET", "/", () =>
    answers.root(Number(BUILT_FOR), instance),
  );
  scriptHydration(server, {
    head: "10",
    items: {
      "core.note": [
        { item: { id: ITEM, properties: { title: "held", body: "held" } } },
      ],
    },
    instance: () => instance,
  });
  server.copyAnswer("GET", new RegExp(`^/items/${ITEM}/tables/steps/`), {
    kind: "json",
    status: 200,
    body: body as Record<string, unknown>,
  });
  value(await device.hydrate(["core.note"], "library"));
  const reached = () =>
    server.requests.filter((request) =>
      request.pathname.startsWith(`/items/${ITEM}/tables/`),
    ).length;

  const read = value(await device.tableRead<object>(args));
  expect(read).toMatchObject({ held: false });
  expect(reached()).toBe(1);

  instance = REPLACED;
  const refused = await device.tableRead<object>(args);
  expect(
    refused.ok,
    "a read sent an item id to another instance at the same address",
  ).toBe(false);
  if (!refused.ok) {
    expect(refused.refusal.code).toBe("copy_expired");
    expect(refused.refusal.raw).toContain("instance_changed");
  }
  expect(reached(), "an item id reached the other instance").toBe(1);
  const status = await device.status();
  expect(status.ok ? status.value.hydration : status).toBe("expired");
}

describe("a table read from the server", () => {
  it("sends no item id to another instance its root names at the copy's own address, and expires the copy: rows", () =>
    refusesAnotherInstance(ROWS));
  it("sends no item id to another instance its root names at the copy's own address, and expires the copy: a row", () =>
    refusesAnotherInstance(ROW));
  it("sends no item id to another instance its root names at the copy's own address, and expires the copy: totals", () =>
    refusesAnotherInstance(TOTALS));
});

describe("a link by id looked up on the server", () => {
  it("sends no item id to another instance its root names at the copy's own address", async () => {
    const titled = (id: string, title: string): WireItemOptions => ({
      id,
      properties: { title, body: `${title}\n` },
    });
    let instance = SCRIPTED_INSTANCE;
    folder = await folderHarness("server-reads-link", {
      items: {
        "core.note": [
          { item: titled("01a00000-0000-7000-8000-00000000e104", "Alpha") },
        ],
      },
      edges: { "parent-of": [], "attached-to": [] },
    });
    const { server, dir } = folder;
    server.copyAnswer("GET", "/", () =>
      answers.root(Number(BUILT_FOR), instance),
    );
    for (const id of [LINKED, OTHER_LINKED])
      server.copyAnswer("GET", `/items/${id}`, () =>
        answers.updated(wireItem({ id, type: "core.bookmark" })),
      );
    scriptFolderWrites(folder, { edges: new EdgeDoor() });
    const put = (name: string, text: string) => {
      mkdirSync(join(dir, name, ".."), { recursive: true });
      writeFileSync(join(dir, name), text);
    };
    const asked = (id: string) =>
      server.requests.filter((request) => request.pathname === `/items/${id}`)
        .length;

    put("One.md", `---\nabout: "[[${LINKED}]]"\n---\none\n`);
    value(await folder.folder.push());
    expect(asked(LINKED)).toBe(1);
    expect(sentEdgeWrites(folder).length).toBe(1);

    instance = REPLACED;
    put("Two.md", `---\nabout: "[[${OTHER_LINKED}]]"\n---\ntwo\n`);
    const refused = await folder.folder.push();
    expect(refused.ok, "a link was looked up at another instance").toBe(false);
    if (!refused.ok) expect(refused.refusal.code).toBe("copy_expired");
    expect(asked(OTHER_LINKED), "an item id reached the other instance").toBe(
      0,
    );
    const status = await folder.folder.device().status();
    expect(status.ok ? status.value.hydration : status).toBe("expired");
  });

  it("sends no second link id to an instance that replaced the first between two lookups", async () => {
    let instance = SCRIPTED_INSTANCE;
    folder = await folderHarness("server-reads-link-between", {
      items: {
        "core.note": [
          {
            item: {
              id: "01a00000-0000-7000-8000-00000000e104",
              properties: { title: "Alpha", body: "Alpha\n" },
            },
          },
        ],
      },
      edges: { "parent-of": [], "attached-to": [] },
    });
    const { server, dir } = folder;
    server.copyAnswer("GET", "/", () =>
      answers.root(Number(BUILT_FOR), instance),
    );
    for (const id of [LINKED, OTHER_LINKED])
      server.copyAnswer("GET", `/items/${id}`, () => {
        instance = REPLACED;
        return answers.updated(wireItem({ id, type: "core.bookmark" }));
      });
    scriptFolderWrites(folder, { edges: new EdgeDoor() });
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "One.md"),
      `---\nabout: "[[${LINKED}]]"\n---\none\n`,
    );
    writeFileSync(
      join(dir, "Two.md"),
      `---\nabout: "[[${OTHER_LINKED}]]"\n---\ntwo\n`,
    );
    const asked = [LINKED, OTHER_LINKED].reduce(
      (sum, id) =>
        sum +
        server.requests.filter((request) => request.pathname === `/items/${id}`)
          .length,
      0,
    );
    expect(asked).toBe(0);

    const refused = await folder.folder.push();
    expect(refused.ok, "a link was looked up at another instance").toBe(false);
    if (!refused.ok) expect(refused.refusal.code).toBe("copy_expired");
    const reached = [LINKED, OTHER_LINKED].map(
      (id) =>
        server.requests.filter((request) => request.pathname === `/items/${id}`)
          .length,
    );
    expect(
      reached.reduce((sum, count) => sum + count, 0),
      "the second id reached the instance that replaced the first",
    ).toBe(1);
    const status = await folder.folder.device().status();
    expect(status.ok ? status.value.hydration : status).toBe("expired");
  });
});

const LEDGER = "01a00000-0000-7000-8000-00000000001e";
const BINNED = "01a00000-0000-7000-8000-00000000001b";
const LEDGER_TYPE = wireType("acme.ledger", {
  tables: { lines: { columns: { amount: { type: "number" } } } },
});
const BYTES = Buffer.from("a file the copy names by its hash");

interface HeldOperation {
  name: string;
  /** Scripts what the operation asks for beyond the hydration. */
  script: (harness: Harness) => void;
  run: (harness: Harness) => Promise<Outcome<unknown>>;
  /** The request that carries what the copy holds. */
  carries: (request: RecordedRequest) => boolean;
}

const OPERATIONS: HeldOperation[] = [
  {
    name: "a pin",
    script: ({ server }) =>
      server.copyAnswer(
        "GET",
        `/items/${ITEM}`,
        answers.updated(
          wireItem({ id: ITEM, properties: { title: "held", body: "held" } }),
        ),
      ),
    run: ({ device }) => device.pin(ITEM),
    carries: (request) => request.pathname === `/items/${ITEM}`,
  },
  {
    name: "a table hold",
    script: ({ server }) =>
      server.answer(
        "GET",
        `/items/${LEDGER}/tables`,
        certifiedRead(
          {
            kind: "json",
            status: 200,
            body: { data: [{ name: "lines", row_count: 0, bytes: 0 }] },
          },
          BUILT_FOR,
        ),
      ),
    run: ({ device }) => device.holdTable("acme.ledger", "lines"),
    carries: (request) =>
      request.pathname.startsWith(`/items/${LEDGER}/tables`),
  },
  {
    name: "the bin",
    script: () => undefined,
    run: ({ device }) => device.bin(),
    carries: (request) =>
      request.pathname === "/items" && request.query.get("state") === "trashed",
  },
  {
    name: "a catch-up",
    script: () => undefined,
    run: ({ device }) => device.catchUp(),
    carries: (request) =>
      request.pathname === "/events" &&
      request.headers["last-event-id"] !== undefined,
  },
  {
    name: "a file fetched by its hash",
    script: ({ server }) => {
      scriptBlob(server, BYTES);
    },
    run: ({ device }) => device.blob(hashOf(BYTES)),
    carries: (request) => request.pathname === `/blobs/${hashOf(BYTES)}/url`,
  },
];

/** What `operation` sent, and answered, once the copy's address names `instance`. */
async function sentUnder(operation: HeldOperation, replaced: boolean) {
  harness = await startHarness("server-reads-held");
  const { server, device } = harness;
  let instance = SCRIPTED_INSTANCE;
  server.copyAnswer("GET", "/", () =>
    answers.root(Number(BUILT_FOR), instance),
  );
  scriptHydration(server, {
    head: "10",
    catalog: typeCatalog([LEDGER_TYPE]),
    items: {
      "core.note": [
        { item: { id: ITEM, properties: { title: "held", body: "held" } } },
        {
          item: {
            id: BINNED,
            state: "trashed",
            properties: { title: "binned", body: "binned" },
          },
        },
      ],
      "acme.ledger": [
        {
          item: { id: LEDGER, type: "acme.ledger", properties: { title: "l" } },
        },
      ],
    },
    instance: () => instance,
  });
  operation.script(harness);
  value(await device.hydrate(["core.note", "acme.ledger"], "library"));
  const from = server.requests.length;
  if (replaced) instance = REPLACED;
  const outcome = await operation.run(harness);
  const sent = server.requests.slice(from);
  const status = await device.status();
  await harness.stop();
  harness = undefined;
  return {
    outcome,
    sent,
    hydration: status.ok ? status.value.hydration : status,
  };
}

async function refusesHeldToAnother(name: string) {
  const operation = OPERATIONS.find((each) => each.name === name)!;
  const witness = await sentUnder(operation, false);
  expect(witness.outcome.ok, JSON.stringify(witness.outcome)).toBe(true);
  expect(
    witness.sent.some(operation.carries),
    "the operation sent nothing for its own instance, so the check below proves nothing",
  ).toBe(true);
  expect(witness.hydration).not.toBe("expired");

  const replaced = await sentUnder(operation, true);
  expect(replaced.outcome.ok, "the operation went on at another instance").toBe(
    false,
  );
  if (!replaced.outcome.ok) {
    expect(replaced.outcome.refusal.code).toBe("copy_expired");
    expect(replaced.outcome.refusal.raw).toContain("instance_changed");
  }
  expect(
    replaced.sent.map((request) => `${request.method} ${request.pathname}`),
    "a request other than the root reached the other instance",
  ).toEqual(replaced.sent.map(() => "GET /"));
  expect(replaced.sent.length).toBeGreaterThan(0);
  expect(replaced.hydration).toBe("expired");
}

describe("an operation that sends what the copy holds", () => {
  it("sends no item id to another instance its root names at the copy's own address, and expires the copy instance_changed: a pin", () =>
    refusesHeldToAnother("a pin"));
  it("sends no item id to another instance its root names at the copy's own address, and expires the copy instance_changed: a table hold", () =>
    refusesHeldToAnother("a table hold"));
  it("reads no other instance's bin as the copy's own, and expires the copy instance_changed", () =>
    refusesHeldToAnother("the bin"));
  it("sends no cursor to another instance its root names at the copy's own address, and expires the copy instance_changed: a catch-up", () =>
    refusesHeldToAnother("a catch-up"));
  it("sends no file hash to another instance its root names at the copy's own address, and expires the copy instance_changed", () =>
    refusesHeldToAnother("a file fetched by its hash"));
});

/** What a follow owing a look at `read_only` sent, the root naming another
 *  instance from the moment its stream opened where `replaced`. */
async function lookedUnder(replaced: boolean) {
  harness = await startHarness("server-reads-look");
  const { server, device } = harness;
  let streamed = false;
  let following = false;
  server.copyAnswer("GET", "/", () =>
    answers.root(
      Number(BUILT_FOR),
      replaced && streamed ? REPLACED : SCRIPTED_INSTANCE,
    ),
  );
  scriptHydration(server, {
    head: "10",
    items: {
      "core.note": [{ item: { id: ITEM, source: "connector.calendar" } }],
    },
    replay: (cursor) => {
      if (following) streamed = true;
      return copyLiveReplay(cursor, []);
    },
  });
  server.answer("POST", "/items/bulk-get", () =>
    bulkGetOf(
      [
        certifiedRead(
          answers.updated(
            wireItem({
              id: ITEM,
              source: "connector.calendar",
              read_only: true,
            }),
          ),
          BUILT_FOR,
        ),
      ],
      { withReach: true, system: false },
    ),
  );
  value(await device.hydrate(["core.note"], "library"));
  // The copy last looked at read_only well over the interval ago.
  const store = new DatabaseSync(device.store);
  try {
    store
      .prepare("UPDATE meta SET value = '0' WHERE key = 'read_only_read_at'")
      .run();
  } finally {
    store.close();
  }
  following = true;
  const outcome = await device.follow(3);
  const looks = server.requests.filter(
    (request) =>
      request.method === "POST" && request.pathname === "/items/bulk-get",
  ).length;
  const status = await device.status();
  return {
    outcome,
    streamed,
    looks,
    hydration: status.ok ? status.value.hydration : status,
  };
}

describe("a look at read_only while a stream is held", () => {
  it("reads the root again and sends no item id to another instance that took the copy's address while the stream was held", async () => {
    const witness = await lookedUnder(false);
    expect(witness.outcome.ok, JSON.stringify(witness.outcome)).toBe(true);
    expect(
      witness.looks,
      "the follow looked at nothing for its own instance, so the check below proves nothing",
    ).toBeGreaterThan(0);
    await harness?.stop();
    harness = undefined;

    const replaced = await lookedUnder(true);
    expect(replaced.streamed, "the follow never held a stream").toBe(true);
    expect(replaced.outcome.ok, "the look went on at another instance").toBe(
      false,
    );
    if (!replaced.outcome.ok) {
      expect(replaced.outcome.refusal.code).toBe("copy_expired");
      expect(replaced.outcome.refusal.raw).toContain("instance_changed");
    }
    expect(replaced.looks, "an item id reached the other instance").toBe(0);
    expect(replaced.hydration).toBe("expired");
  });
});

const EXPIRED = refusal(401, "unauthorized", "expired");
const SECOND = "01a00000-0000-7000-8000-00000000000b";

/** A call whose request the server refuses once for an expired credential. */
interface Renewed {
  /** The call, after `device --db <store>`. */
  args: string[];
  /** Whether the copy is hydrated before the call. */
  held: boolean;
  /** Scripts the refused request, and anything the hydration needs. */
  script: (server: Harness["server"]) => void;
  /** The request refused, then sent again. */
  repeats: (request: RecordedRequest) => boolean;
}

const RENEWED: Record<string, Renewed> = {
  "a table read": {
    args: ["rows", "list", ITEM, "steps"],
    held: true,
    script: (server) =>
      server.copyAnswer("GET", `/items/${ITEM}/tables/steps/rows`, EXPIRED, {
        kind: "json",
        status: 200,
        body: { data: [], next_cursor: null },
      }),
    repeats: (request) =>
      request.pathname === `/items/${ITEM}/tables/steps/rows`,
  },
  "a pin": {
    args: ["pin", ITEM],
    held: true,
    script: (server) =>
      server.copyAnswer(
        "GET",
        `/items/${ITEM}`,
        EXPIRED,
        answers.updated(
          wireItem({ id: ITEM, properties: { title: "held", body: "held" } }),
        ),
      ),
    repeats: (request) => request.pathname === `/items/${ITEM}`,
  },
  "a hydration": {
    args: ["hydrate", "--type", "core.note", "--tier", "library"],
    held: false,
    script: () => undefined,
    repeats: (request) =>
      request.pathname === "/items" && request.query.get("cursor") === "1",
  },
};

// This fixture uses a macOS keychain file for the renewable credential.
describe("a request repeated after a credential renewal", ON_MACOS, () => {
  async function repeated(name: string, replacedAtRenewal: boolean) {
    const renewed = RENEWED[name]!;
    harness = await startHarness("server-reads-renewal");
    const { server, device } = harness;
    let instance = SCRIPTED_INSTANCE;
    server.copyAnswer("GET", "/", () =>
      answers.root(Number(BUILT_FOR), instance),
    );
    let pageRefused = false;
    scriptHydration(server, {
      head: "10",
      items: {
        "core.note": [
          { item: { id: ITEM, properties: { title: "held", body: "held" } } },
          {
            item: { id: SECOND, properties: { title: "next", body: "next" } },
          },
        ],
      },
      // One item a page, so a hydration's second page follows its head.
      pageSize: 1,
      drop: () => {
        if (renewed.held || pageRefused) return false;
        pageRefused = true;
        return EXPIRED;
      },
      instance: () => instance,
    });
    if (renewed.held) value(await device.hydrate(["core.note"], "library"));
    renewed.script(server);
    server.answer("POST", "/token", () => {
      if (replacedAtRenewal) instance = REPLACED;
      return {
        kind: "json",
        status: 200,
        body: {
          access_token: "renewed-fixture",
          refresh_token: "next-fixture",
          expires_in: 3600,
          scope: "*:read",
        },
      };
    });
    const keychain = keychainEnv().MARFA_KEYCHAIN!;
    execFileSync("security", [
      "add-generic-password",
      "-A",
      "-s",
      "marfa",
      "-a",
      server.url,
      "-w",
      JSON.stringify({
        kind: "token",
        access_token: "marfa_at_fixture",
        refresh_token: "marfa_rt_fixture",
        expires_at: null,
        client_id: "fixture",
        scope: "*:read",
        token_endpoint: `${server.url}/token`,
        revocation_endpoint: null,
      }),
      keychain,
    ]);
    try {
      const result = await new Cli(requireBinary(), server.url, KEY)
        .as(undefined)
        .run(["--json", "device", "--db", device.store, ...renewed.args]);
      const reached = server.requests.filter(renewed.repeats);
      const renewal = server.requests.findIndex(
        (request) => request.pathname === "/token",
      );
      expect(
        server.requests.filter((request) => request.pathname === "/token"),
        "the binary did not renew the token the server refused",
      ).toHaveLength(1);
      const afterRenewal = server.requests
        .slice(renewal + 1)
        .map((request) => `${request.method} ${request.pathname}`);
      return { result, reached, afterRenewal };
    } finally {
      try {
        execFileSync(
          "security",
          [
            "delete-generic-password",
            "-s",
            "marfa",
            "-a",
            server.url,
            keychain,
          ],
          { stdio: "ignore" },
        );
      } catch {
        // A renewal the server refused has already let the token go.
      }
    }
  }

  async function confirmsAgain(name: string) {
    const witness = await repeated(name, false);
    expect(witness.result.code, witness.result.stderr).toBe(0);
    expect(
      witness.reached,
      "the request was not repeated, so the check below proves nothing",
    ).toHaveLength(2);
    await harness?.stop();
    harness = undefined;

    const replaced = await repeated(name, true);
    expect(replaced.result.code).not.toBe(0);
    expect(replaced.result.stderr).toContain("copy_expired");
    expect(replaced.result.stderr).toContain("instance_changed");
    expect(
      replaced.reached,
      "the request was repeated at the instance that replaced the first",
    ).toHaveLength(1);
    expect(
      replaced.afterRenewal,
      "a request other than the root reached the instance that replaced the first",
    ).toEqual(["GET /"]);
  }

  it("confirms the instance again before it repeats a table read after a credential renewal", () =>
    confirmsAgain("a table read"));
  it("confirms the instance again before it repeats a pin after a credential renewal", () =>
    confirmsAgain("a pin"));
  it("confirms the instance again before a hydration sends its next request after a credential renewal", () =>
    confirmsAgain("a hydration"));
});
