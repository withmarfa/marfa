/**
 * Every door that reads or changes an existing key row, held to the caller's
 * reach through one function.
 *
 * **A census, for the reason the mint census exists.** The mint was clamped
 * to the minter's reach and revoke, update and list were not: each door was
 * written on its own, and nothing about one being right said anything about
 * the next. So the property is asserted of the whole surface, two ways.
 *
 * The first leg reads the source. Every call into the key store in this
 * package is either in `auth/key-reach.ts`, which measures the caller's reach
 * before it lists, reads, changes or revokes a row, or is named below with
 * why it is not a door acting for a caller. A handler that calls
 * `storage.keys.get` itself fails here, and so does a new method on the store
 * that nobody has classified.
 *
 * The second leg drives the doors. Every route the app serves under `/keys`
 * either has a row below asserting a key beyond the caller's reach is refused
 * and one within it is not, or is named as a door that addresses no existing
 * key by id.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import type { CreateKeyInput } from "@withmarfa/shared";

const SRC = join(import.meta.dirname, "..");
const REACH_MODULE = "auth/key-reach.ts";

/** Store methods that read or change an existing key row, or list rows. */
const ROW_ACCESS = new Set(["get", "list", "update", "revoke"]);

/** Store methods that do not, each with why. */
const NOT_ROW_ACCESS: Record<string, string> = {
  create: "a mint, held to its ceiling by credential-mint-doors.test.ts",
  validate: "the bearer check reading the presented credential itself",
  updateLastUsed: "the bearer check stamping the presented credential itself",
  count: "a number, which names no key",
  deleteRevokedKeysOlderThan: "retention removing rows no credential holds",
};

/**
 * Calls of a row-access method outside `auth/key-reach.ts`, as
 * `file › enclosing function › method`, each with why it acts for no caller.
 * Pinned exactly, so a second call in the same function has to be added here
 * on purpose.
 */
const NOT_A_DOOR: Record<string, string> = {
  "routes/keys.ts › refuseOwnSourceClaimedElsewhere › list":
    "asks whether any live key claims a source, and answers with a refusal naming only that source",
  "routes/keys.ts › withBootstrapRelease › list":
    "asks whether bootstrap minted anything before giving the claim back",
  "auth/grant-lifecycle.ts › keysMintedByApp › list":
    "the keys one app minted, swept with its grant; a key an app mints is held to that app's grant, so revoking them reaches no further than revoking the grant, which is what grants.manage is",
  "auth/grant-lifecycle.ts › revokeProjectedGrant › revoke":
    "the same sweep, revoking the keys keysMintedByApp found",
  "bulk-actions/credential.ts › resolveJobCredential › get":
    "the worker re-reading the credential that queued a job, as the bearer check does",
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      out.push(path);
    }
  }
  return out;
}

/** The nearest top-level function or class above `index` in `text`. */
function enclosing(text: string, index: number): string {
  const before = text.slice(0, index).split("\n");
  for (let i = before.length - 1; i >= 0; i--) {
    const m =
      /^(?:export )?(?:async )?function (\w+)/.exec(before[i] ?? "") ??
      /^(?:export )?class (\w+)/.exec(before[i] ?? "");
    if (m) return m[1] ?? "(unnamed)";
  }
  return "(module scope)";
}

interface Call {
  file: string;
  fn: string;
  method: string;
}

function keyStoreCalls(): Call[] {
  const out: Call[] = [];
  for (const path of sourceFiles(SRC)) {
    const file = relative(SRC, path);
    const text = readFileSync(path, "utf8");
    // A member named `keys`, so a local array of keys is not the store, and
    // across line breaks, because Prettier may put the method on the next line.
    for (const m of text.matchAll(/\.\s*keys\s*\.\s*(\w+)\s*\(/g)) {
      const line = text.slice(text.lastIndexOf("\n", m.index) + 1).trimStart();
      if (line.startsWith("//") || line.startsWith("*")) continue;
      out.push({ file, fn: enclosing(text, m.index), method: m[1] ?? "" });
    }
  }
  return out;
}

describe("every call into the key store is classified", () => {
  const calls = keyStoreCalls();

  it("finds the store at all, so an empty scan cannot pass", () => {
    expect(calls.filter((c) => c.file === REACH_MODULE).length).toBe(4);
    expect(calls.length).toBeGreaterThan(10);
  });

  it("classifies every method the store has", () => {
    const iface = readFileSync(join(SRC, "storage/interface.ts"), "utf8");
    const start = iface.indexOf("export interface KeyStore {");
    const body = iface.slice(start, iface.indexOf("\n}\n", start));
    const methods = [...body.matchAll(/^ {2}(\w+)\(/gm)].map((m) => m[1] ?? "");
    expect(methods.length).toBeGreaterThan(5);
    for (const method of methods) {
      expect(
        ROW_ACCESS.has(method) || method in NOT_ROW_ACCESS,
        `KeyStore.${method} is neither row access nor named as not`,
      ).toBe(true);
    }
  });

  it("reaches a key row only through the reach module, or for a named reason", () => {
    const unclassified: string[] = [];
    const outside: string[] = [];
    for (const call of calls) {
      if (!ROW_ACCESS.has(call.method)) {
        if (!(call.method in NOT_ROW_ACCESS)) {
          unclassified.push(`${call.file} › ${call.method}`);
        }
        continue;
      }
      if (call.file === REACH_MODULE) continue;
      outside.push(`${call.file} › ${call.fn} › ${call.method}`);
    }
    expect(unclassified).toEqual([]);
    expect(outside.sort()).toEqual(Object.keys(NOT_A_DOOR).sort());
  });

  it("is not handed the store under another name", () => {
    // An alias would take every call through it out of the scan above.
    for (const path of sourceFiles(SRC)) {
      const text = readFileSync(path, "utf8");
      expect(
        /storage\s*\.\s*keys\b(?!\s*\.)/.exec(text),
        relative(SRC, path),
      ).toBeNull();
      expect(
        /\{[^}]*\bkeys\b[^}]*\}\s*=\s*[\w.]*storage\b/.exec(text),
        relative(SRC, path),
      ).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// The doors themselves
// ---------------------------------------------------------------------------

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

async function storeKey(
  input: Partial<CreateKeyInput>,
): Promise<{ id: string; raw: string }> {
  const suffix = Math.random().toString(36).slice(2, 12);
  const raw = `marfa_k1_census_${suffix}`;
  const stored = await ctx.storage.keys.create(
    {
      label: `census-${suffix}`,
      source: `census-${suffix}`,
      type_permissions: {},
      default_tier: "library",
      is_operator: false,
      ...input,
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
  );
  return { id: stored.id, raw };
}

/** A key that may mint and reads notes, and a key within and beyond it. */
async function cast() {
  const minter = await storeKey({
    permissions: ["keys.mint"],
    type_permissions: { "core.note": "read" },
  });
  const within = await storeKey({ type_permissions: { "core.note": "read" } });
  const beyond = await storeKey({ type_permissions: { "*": "write" } });
  return { minter, within, beyond };
}

interface Door {
  route: string;
  /** Asserts a key beyond the caller refused, and one within it reached. */
  holds: () => Promise<void>;
}

const DOORS: Door[] = [
  {
    route: "GET /keys",
    holds: async () => {
      const { minter, within, beyond } = await cast();
      const res = await request(ctx.app, "GET", "/keys", { key: minter.raw });
      expect(res.status).toBe(200);
      const ids = ((await res.json()) as { data: { id: string }[] }).data.map(
        (k) => k.id,
      );
      expect(ids).toContain(within.id);
      expect(ids).not.toContain(beyond.id);
    },
  },
  {
    route: "PATCH /keys/:id",
    holds: async () => {
      const { minter, within, beyond } = await cast();
      const refused = await request(ctx.app, "PATCH", `/keys/${beyond.id}`, {
        key: minter.raw,
        body: { label: "x" },
      });
      expect(refused.status).toBe(404);
      const reached = await request(ctx.app, "PATCH", `/keys/${within.id}`, {
        key: minter.raw,
        body: { label: "x" },
      });
      expect(reached.status).toBe(200);
    },
  },
  {
    route: "DELETE /keys/:id",
    holds: async () => {
      const { minter, within, beyond } = await cast();
      const refused = await request(ctx.app, "DELETE", `/keys/${beyond.id}`, {
        key: minter.raw,
      });
      expect(refused.status).toBe(404);
      const reached = await request(ctx.app, "DELETE", `/keys/${within.id}`, {
        key: minter.raw,
      });
      expect(reached.status).toBe(200);
    },
  },
];

/** Routes under `/keys` that address no existing key, each with why. */
const NO_EXISTING_KEY: Record<string, string> = {
  "POST /keys": "a mint, held to its ceiling by credential-mint-doors.test.ts",
  "GET /keys/current": "the presented credential reading itself",
};

describe.each(DOORS)("$route", (door) => {
  it("refuses a key beyond the caller's reach and reaches one within it", async () => {
    await door.holds();
  });
});

describe("every route under /keys is accounted for", () => {
  it("has a door row or a stated reason, and no stale entry", () => {
    const served = new Set(
      ctx.app.routes
        .filter((r) =>
          ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(r.method),
        )
        .filter((r) => r.path === "/keys" || r.path.startsWith("/keys/"))
        .map((r) => `${r.method} ${r.path}`),
    );
    const classified = new Set([
      ...DOORS.map((d) => d.route),
      ...Object.keys(NO_EXISTING_KEY),
    ]);
    expect([...served].sort()).toEqual([...classified].sort());
  });
});
