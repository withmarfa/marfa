import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  approvedAppToken,
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";
import { TEST_OWNER } from "../../utils/target.js";

/**
 * A key's `expires_at`: named on a mint, changed by an update, and held to
 * the lifetime of the key that acts. The server these run against is one of
 * the file's own, so a key can be moved past its expiry in the database to
 * see what a passed expiry does without waiting for one.
 */
let server: FreshServer;
let management: MarfaClient;
let owner: MarfaClient;

const SOON = "2999-01-01T00:00:00.000Z";
const LATER = "2999-06-01T00:00:00.000Z";
const LATEST = "2999-12-01T00:00:00.000Z";
const PAST = "2001-01-01T00:00:00.000Z";

beforeAll(async () => {
  server = await bootFreshServer("key-expiry");
  management = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.managementKey,
  });
  owner = new MarfaClient({
    baseUrl: server.apiUrl,
    ownerCookie: server.ownerCookie,
    ownerCredentials: TEST_OWNER,
  });
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

let sequence = 0;
function unique(label: string): string {
  sequence += 1;
  return `${label}-${String(sequence)}`;
}

async function mint(
  label: string,
  expiresAt?: string,
  client: MarfaClient = management,
): Promise<{ id: string; key: string; expires_at?: string | null }> {
  const name = unique(label);
  const minted = await client.createKey({
    label: name,
    source: name,
    permissions: ["audit.read"],
    ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
  });
  expect(minted.status, JSON.stringify(minted.error)).toBe(201);
  return minted.data;
}

/** A key that may mint, which expires when `expiresAt` says. */
async function mintingKey(expiresAt: string): Promise<MarfaClient> {
  const name = unique("minter");
  const minted = await management.createKey({
    label: name,
    source: name,
    permissions: ["keys.mint", "audit.read"],
    expires_at: expiresAt,
  });
  expect(minted.status, JSON.stringify(minted.error)).toBe(201);
  return new MarfaClient({ baseUrl: server.apiUrl, apiKey: minted.data.key });
}

async function expiryOf(id: string): Promise<string | null | undefined> {
  const listed = await management.listKeys();
  return listed.data.data.find((key) => key.id === id)?.expires_at;
}

function stampExpiry(id: string, at: string): void {
  withInstanceDatabase(server.sqlitePath, (db) => {
    const stamped = db
      .prepare("UPDATE api_keys SET expires_at = ? WHERE id = ?")
      .run(at, id);
    expect(stamped.changes).toBe(1);
  });
}

describe("a key past its expires_at", () => {
  it("is refused 401, left out of the listing, and answered 404 api_key_not_found to an update or a revoke", async () => {
    const expiring = await mint("expiring");
    const lasting = await mint("lasting");
    const bearer = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: expiring.key,
    });
    // The witness: before its expiry the key works and is listed.
    expect((await bearer.getCurrentKey()).status).toBe(200);
    expect((await management.listKeys()).data.data.map((k) => k.id)).toContain(
      expiring.id,
    );

    stampExpiry(expiring.id, "2001-01-01T00:00:00.000Z");

    const refused = await bearer.getCurrentKey();
    expect(refused.status).toBe(401);
    expect(refused.error?.error.code).toBe("unauthorized");
    const listed = (await management.listKeys()).data.data.map((k) => k.id);
    expect(listed).not.toContain(expiring.id);
    expect(listed).toContain(lasting.id);

    const updated = await management.updateKey(expiring.id, { label: "x" });
    expect(updated.status).toBe(404);
    expect(updated.error?.error.code).toBe("api_key_not_found");
    const revoked = await management.revokeKey(expiring.id);
    expect(revoked.status).toBe(404);
    expect(revoked.error?.error.code).toBe("api_key_not_found");
    const unchanged = withInstanceDatabase(server.sqlitePath, (db) =>
      db
        .prepare("SELECT label, revoked_at FROM api_keys WHERE id = ?")
        .get(expiring.id),
    ) as { label: string; revoked_at: string | null };
    expect(unchanged.revoked_at).toBeNull();
    expect(unchanged.label).toMatch(/^expiring-/);

    // The witness that the refusals are the expiry's: the other key changes.
    expect(
      (await management.updateKey(lasting.id, { label: "lasting-renamed" }))
        .status,
    ).toBe(200);
  });

  it("is refused 401 once the expiry it was minted with comes", async () => {
    const soon = new Date(Date.now() + 8_000).toISOString();
    const minted = await mint("brief", soon);
    const bearer = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: minted.key,
    });
    // The witness: the key works until its expiry.
    expect((await bearer.getCurrentKey()).status).toBe(200);

    const deadline = Date.now() + 30_000;
    let status = 200;
    while (status === 200 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      status = (await bearer.getCurrentKey()).status;
    }
    expect(status).toBe(401);
  });

  it("gives up its own source to the next mint, and holds it until then", async () => {
    const source = unique("lapsing-source");
    const lapsing = await management.createKey({
      label: source,
      source,
      permissions: ["audit.read"],
      expires_at: SOON,
    });
    expect(lapsing.status).toBe(201);
    const next = () =>
      management.createKey({
        label: `${source}-next`,
        source,
        permissions: ["audit.read"],
      });

    // The witness: while the key stands, the source is its own.
    const held = await next();
    expect(held.status).toBe(409);
    expect(held.error?.error.code).toBe("conflict");

    stampExpiry(lapsing.data.id, PAST);
    // The witness: the lapse alone revokes nothing.
    const before = await management.listAudit({
      action: "key.revoke",
      resource_id: lapsing.data.id,
    });
    expect(before.data.data).toHaveLength(0);
    const taken = await next();
    expect(taken.status).toBe(201);
    expect(taken.data.source).toBe(source);
    // The source is the new key's now, so a third mint is refused.
    expect((await next()).status).toBe(409);

    // The mint revoked the lapsed key, and the log says so.
    const revoked = await management.listAudit({
      action: "key.revoke",
      resource_id: lapsing.data.id,
    });
    expect(revoked.status).toBe(200);
    expect(revoked.data.data).toHaveLength(1);
    expect(revoked.data.data[0]?.resource_id).toBe(lapsing.data.id);
  });

  it("answers 404 api_key_not_found to an update that would clear its expiry, and stays past it", async () => {
    const expiring = await mint("expired-clear", SOON);
    stampExpiry(expiring.id, PAST);
    const cleared = await management.updateKey(expiring.id, {
      expires_at: null,
    });
    expect(cleared.status).toBe(404);
    expect(cleared.error?.error.code).toBe("api_key_not_found");
    const stored = withInstanceDatabase(server.sqlitePath, (db) =>
      db
        .prepare("SELECT expires_at FROM api_keys WHERE id = ?")
        .get(expiring.id),
    ) as { expires_at: string };
    expect(stored.expires_at).toBe(PAST);
  });
});

describe("a key minted with an expiry", () => {
  it("is minted with the expiry named, and answers it in UTC on the mint, the listing and its own read", async () => {
    const minted = await mint("named", "2999-01-01T02:00:00+02:00");
    expect(minted.expires_at).toBe(SOON);

    const bearer = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: minted.key,
    });
    const current = await bearer.getCurrentKey();
    expect(current.status).toBe(200);
    expect(current.data.expires_at).toBe(SOON);
    expect(await expiryOf(minted.id)).toBe(SOON);
  });

  it("is minted with a null expiry where the caller has none and the body names none", async () => {
    const minted = await mint("unnamed");
    expect(minted.expires_at).toBeNull();
    const bearer = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: minted.key,
    });
    expect((await bearer.getCurrentKey()).data.expires_at).toBeNull();
    expect(await expiryOf(minted.id)).toBeNull();
  });

  it("reads an expires_at with no zone as UTC", async () => {
    const minted = await mint("zoneless", "2999-01-01T00:00:00");
    expect(minted.expires_at).toBe(SOON);
  });

  it.each([
    ["is not a timestamp", "tomorrow"],
    ["is a date with no time", "2999-01-01"],
    ["has a UTC year of 10000", "9999-12-31T23:59:59-01:00"],
    ["is not ahead of now", PAST],
  ])(
    "refuses an expires_at that %s, naming the field, on a mint and on an update",
    async (_name, bad) => {
      const name = unique("refused");
      const refused = await management.createKey({
        label: name,
        source: name,
        permissions: ["audit.read"],
        expires_at: bad,
      });
      expect(refused.status).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
      expect(refused.error?.error.details?.field).toBe("expires_at");
      // The witness: the same mint without the expiry is taken, so the
      // refusal was the expiry's and nothing was minted behind it.
      const taken = await management.createKey({
        label: name,
        source: name,
        permissions: ["audit.read"],
      });
      expect(taken.status).toBe(201);

      const kept = await mint("refused-update", SOON);
      const update = await management.updateKey(kept.id, { expires_at: bad });
      expect(update.status).toBe(400);
      expect(update.error?.error.code).toBe("validation_error");
      expect(update.error?.error.details?.field).toBe("expires_at");
      expect(await expiryOf(kept.id)).toBe(SOON);
    },
  );
});

describe("changing a key's expiry", () => {
  it("replaces it, clears it with null, and leaves it as it was where the update names none", async () => {
    const key = await mint("changing");
    expect(key.expires_at).toBeNull();

    const given = await owner.updateKey(key.id, { expires_at: SOON });
    expect(given.status).toBe(200);
    expect(given.data.expires_at).toBe(SOON);

    const renamed = await owner.updateKey(key.id, { label: "renamed" });
    expect(renamed.data.expires_at).toBe(SOON);
    expect(await expiryOf(key.id)).toBe(SOON);

    const replaced = await owner.updateKey(key.id, { expires_at: LATER });
    expect(replaced.data.expires_at).toBe(LATER);

    const cleared = await owner.updateKey(key.id, { expires_at: null });
    expect(cleared.status).toBe(200);
    expect(cleared.data.expires_at).toBeNull();
    expect(await expiryOf(key.id)).toBeNull();
  });
});

describe("a key that expires", () => {
  it("mints a key that expires when its own does where the body names none, and no later where it names one", async () => {
    const minter = await mintingKey(LATER);
    const inherited = await mint("inherited", undefined, minter);
    expect(inherited.expires_at).toBe(LATER);

    const earlier = await mint("earlier", SOON, minter);
    expect(earlier.expires_at).toBe(SOON);
    const same = await mint("same", LATER, minter);
    expect(same.expires_at).toBe(LATER);

    const name = unique("later");
    const refused = await minter.createKey({
      label: name,
      source: name,
      permissions: ["audit.read"],
      expires_at: LATEST,
    });
    expect(refused.status).toBe(403);
    expect(refused.error?.error.code).toBe("forbidden");
  });

  it("neither lengthens nor clears the expiry of a key, its own included, and leaves the key as it was", async () => {
    const minter = await mintingKey(LATER);
    const made = await mint("held-short", SOON, minter);

    // The witness: it shortens another key, and its own.
    const shorter = await minter.updateKey(made.id, {
      expires_at: "2999-03-01T00:00:00.000Z",
    });
    expect(shorter.status).toBe(200);

    for (const bad of [LATEST, null]) {
      const refused = await minter.updateKey(made.id, { expires_at: bad });
      expect(refused.status, String(bad)).toBe(403);
      expect(refused.error?.error.code).toBe("forbidden");
    }
    expect(await expiryOf(made.id)).toBe("2999-03-01T00:00:00.000Z");

    const itself = (await minter.getCurrentKey()).data.id;
    for (const bad of [LATEST, null]) {
      const refused = await minter.updateKey(itself, { expires_at: bad });
      expect(refused.status, `its own ${String(bad)}`).toBe(403);
    }
    expect(await expiryOf(itself)).toBe(LATER);
  });
});

describe("a key changed through keys.manage", () => {
  it("is given an expiry or has it shortened, and is refused a later expiry or none", async () => {
    const open = await mint("managed");
    const given = await management.updateKey(open.id, { expires_at: LATER });
    expect(given.status).toBe(200);
    const shorter = await management.updateKey(open.id, { expires_at: SOON });
    expect(shorter.status).toBe(200);

    for (const bad of [LATER, null]) {
      const refused = await management.updateKey(open.id, {
        expires_at: bad,
      });
      expect(refused.status, String(bad)).toBe(403);
      expect(refused.error?.error.code).toBe("forbidden");
    }
    expect(await expiryOf(open.id)).toBe(SOON);
  });
});

describe("the owner and an expiry", () => {
  it("lengthens or clears the expiry of a key that no app made", async () => {
    const key = await mint("owner-lengthened", SOON);
    const later = await owner.updateKey(key.id, { expires_at: LATER });
    expect(later.status).toBe(200);
    expect(later.data.expires_at).toBe(LATER);
    const cleared = await owner.updateKey(key.id, { expires_at: null });
    expect(cleared.status).toBe(200);
    expect(cleared.data.expires_at).toBeNull();
  });
});

describe("a key an app made", () => {
  it(
    "is shortened and never lengthened or cleared, whoever the caller is",
    async () => {
      // An app's key is minted through a sign-in, which needs an owner, and
      // an instance has one: the story needs a server of its own.
      const own = await bootFreshServer("key-expiry-app");
      try {
        const app = new MarfaClient({
          baseUrl: own.apiUrl,
          apiKey: await approvedAppToken(own),
        });
        const person = new MarfaClient({
          baseUrl: own.apiUrl,
          ownerCookie: own.ownerCookie,
          ownerCredentials: TEST_OWNER,
        });

        const made = await app.createKey({
          label: "app-made",
          source: "app-made",
          expires_at: LATER,
        });
        expect(
          made.status,
          "the app could not mint a key with an expiry, so there is no key an app made to hold to the rule",
        ).toBe(201);
        expect(made.data.oauth_client_id).toBeDefined();
        expect(made.data.expires_at).toBe(LATER);

        // The witness. The owner lengthens a key it made itself, so the
        // refusals below are the key's and not the caller's.
        const plain = await person.createKey({
          label: "plain",
          source: "plain",
          expires_at: SOON,
        });
        expect(plain.status).toBe(201);
        const lengthened = await person.updateKey(plain.data.id, {
          expires_at: LATER,
        });
        expect(
          lengthened.status,
          "the owner could not lengthen a key it made, so the refusals below may be every update",
        ).toBe(200);

        for (const bad of [LATEST, null]) {
          const refused = await person.updateKey(made.data.id, {
            expires_at: bad,
          });
          expect(refused.status, String(bad)).toBe(403);
          expect(refused.error?.error.code).toBe("forbidden");
        }
        const shorter = await person.updateKey(made.data.id, {
          expires_at: SOON,
        });
        expect(shorter.status).toBe(200);
        expect(shorter.data.expires_at).toBe(SOON);
      } finally {
        await own.stop();
      }
    },
    2 * FRESH_SERVER_TIMEOUT_MS + 120_000,
  );
});
