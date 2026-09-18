import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Client } from "@libsql/client";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Replays the scope rename against rows written before it.
 *
 * Eight stored places carry one of the eleven space permissions and all of
 * them move together, because a held scope the parser no longer recognizes is
 * not a refusal a client can act on: the door answers 403 naming a literal
 * nobody asked for.
 *
 * Three properties are pinned rather than assumed. The two literals that drop
 * a prefix (`capability.space_settings`, `capability.space_usage`) land on
 * `space.settings` and `space.usage` rather than on the stuttering form a
 * generic root replacement would produce. A scope outside the eleven is left
 * exactly as it was, in the same position. And an integration manifest's
 * capability — a different concept wearing the same English word — does not
 * move, which is what a `LIKE 'capability%'` sweep would break.
 */
const MIGRATION = readFileSync(
  join(
    __dirname,
    "../../../drizzle/sqlite/0089_space_permission_scope_rename.sql",
  ),
  "utf8",
);

const OLD_SET = [
  "core.note:read",
  "capability.keys",
  "capability.space_settings",
  "capability.space_usage",
  "capability.item_purge",
];

/** The five `auth_oauth_*` columns hold a JSON array as text. */
const OLD_SET_JSON = JSON.stringify(OLD_SET);

/** Deliberately not `OLD_SET`, and deliberately overlapping it in nothing but
 *  shape. The machine-to-machine ceiling is its own column, so a statement
 *  reading the wrong source would land this row's other list here. */
const M2M_SET = ["capability.audit_read", "core.task:write"];
const M2M_SET_JSON = JSON.stringify(M2M_SET);
const M2M_SET_AFTER = ["space.audit_read", "core.task:write"];

const NEW_SET = [
  "core.note:read",
  "space.keys",
  "space.settings",
  "space.usage",
  "space.item_purge",
];

async function seed(db: Client): Promise<void> {
  await db.batch(
    [
      `CREATE TABLE auth_oauth_client (id text PRIMARY KEY, scopes text, client_credentials_scopes text)`,
      `CREATE TABLE auth_oauth_access_token (id text PRIMARY KEY, scopes text NOT NULL)`,
      `CREATE TABLE auth_oauth_refresh_token (id text PRIMARY KEY, scopes text NOT NULL)`,
      `CREATE TABLE auth_oauth_consent (id text PRIMARY KEY, scopes text NOT NULL)`,
      `CREATE TABLE oauth_device_codes (id text PRIMARY KEY, scope text NOT NULL)`,
      `CREATE TABLE auth_verification (id text PRIMARY KEY, value text NOT NULL)`,
      `CREATE TABLE items (id text PRIMARY KEY, type text, state text, properties blob)`,
    ],
    "write",
  );

  await db.batch(
    [
      {
        // `client_credentials_scopes` is a separate ceiling for the
        // machine-to-machine grant type rather than a subset of the first, so
        // it is seeded with a DIFFERENT list: a statement that read the wrong
        // source column would overwrite one with the other and still pass an
        // assertion that only checked the names had moved.
        sql: `INSERT INTO auth_oauth_client VALUES ('client-live', ?, ?), ('client-untouched', ?, NULL)`,
        args: [OLD_SET_JSON, M2M_SET_JSON, JSON.stringify(["core.task:write"])],
      },
      {
        sql: `INSERT INTO auth_oauth_access_token VALUES ('at-1', ?)`,
        args: [OLD_SET_JSON],
      },
      {
        sql: `INSERT INTO auth_oauth_refresh_token VALUES ('rt-1', ?)`,
        args: [OLD_SET_JSON],
      },
      {
        sql: `INSERT INTO auth_oauth_consent VALUES ('consent-1', ?)`,
        args: [OLD_SET_JSON],
      },
      {
        sql: `INSERT INTO oauth_device_codes VALUES ('dc-1', ?), ('dc-2', ?)`,
        args: [
          "openid core.note:read capability.space_usage capability.webhooks",
          "openid core.note:read",
        ],
      },
      {
        // A pending authorization code, and beside it the shape the same
        // table holds for an email verification: a bare token, not JSON.
        sql: `INSERT INTO auth_verification VALUES ('v-code', ?), ('v-email', ?)`,
        args: [
          JSON.stringify({
            type: "authorization_code",
            query: {
              client_id: "client-live",
              scope: "openid capability.keys capability.space_settings",
            },
          }),
          "a-plain-verification-token",
        ],
      },
      {
        // A live grant, a revoked one — `revokeProjectedGrant` leaves the
        // scope list verbatim on the row it flips — and an integration
        // connection whose manifest capability must not move.
        sql: `INSERT INTO items VALUES
                ('grant-live',    'system.connection', 'active',  jsonb(?)),
                ('grant-revoked', 'system.connection', 'revoked', jsonb(?)),
                ('conn-integration', 'system.connection', 'active', jsonb(?))`,
        args: [
          JSON.stringify({
            kind: "app",
            client_id: "client-live",
            scopes: OLD_SET,
          }),
          JSON.stringify({
            kind: "app",
            client_id: "client-old",
            scopes: ["capability.audit_read"],
          }),
          JSON.stringify({
            kind: "integration",
            manifest: {
              oauth_requirements: { "capability.drive.upload": "leased" },
            },
          }),
        ],
      },
    ],
    "write",
  );
}

/** libsql column values are a union that includes objects and buffers, so a
 *  bare `String(...)` on one is both a lint error and a silent way to compare
 *  against `[object Object]`. This refuses anything that is not text. */
function text(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error(`expected a text column value, got ${typeof value}`);
  }
  return value;
}

function parsed(value: unknown): unknown {
  return JSON.parse(text(value)) as unknown;
}

async function run(db: Client): Promise<void> {
  for (const statement of MIGRATION.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed.length > 0) await db.execute(trimmed);
  }
}

describe("0089 space permission scopes take the space root", () => {
  it("moves every stored place, and drops the prefix on the two that stutter", async () => {
    const db = createClient({ url: ":memory:" });
    try {
      await seed(db);
      await run(db);

      const json = async (sql: string): Promise<unknown> => {
        const { rows } = await db.execute(sql);
        return parsed(rows[0]?.[0]);
      };

      expect(
        await json(
          `SELECT scopes FROM auth_oauth_client WHERE id = 'client-live'`,
        ),
      ).toEqual(NEW_SET);
      expect(
        await json(
          `SELECT client_credentials_scopes FROM auth_oauth_client WHERE id = 'client-live'`,
        ),
      ).toEqual(M2M_SET_AFTER);
      expect(
        await json(
          `SELECT scopes FROM auth_oauth_access_token WHERE id = 'at-1'`,
        ),
      ).toEqual(NEW_SET);
      expect(
        await json(
          `SELECT scopes FROM auth_oauth_refresh_token WHERE id = 'rt-1'`,
        ),
      ).toEqual(NEW_SET);
      expect(
        await json(
          `SELECT scopes FROM auth_oauth_consent WHERE id = 'consent-1'`,
        ),
      ).toEqual(NEW_SET);

      const { rows: device } = await db.execute(
        `SELECT id, scope FROM oauth_device_codes ORDER BY id`,
      );
      expect(device.map((r) => r.scope)).toEqual([
        "openid core.note:read space.usage space.webhooks",
        "openid core.note:read",
      ]);

      const { rows: verification } = await db.execute(
        `SELECT id, value FROM auth_verification ORDER BY id`,
      );
      expect(parsed(verification[0]?.value)).toMatchObject({
        query: { scope: "openid space.keys space.settings" },
      });
      // The non-JSON row in the same table is untouched, which is why the
      // rewrite goes through text rather than the JSON functions.
      expect(text(verification[1]?.value)).toBe("a-plain-verification-token");

      const { rows: grants } = await db.execute(
        `SELECT id, json_extract(properties, '$.scopes') AS scopes FROM items ORDER BY id`,
      );
      const byId = new Map(grants.map((r) => [text(r.id), r.scopes]));
      expect(parsed(byId.get("grant-live"))).toEqual(NEW_SET);
      // A revoked projection still holds a scope list, and the surfaces
      // that render its history read the same names as the live ones.
      expect(parsed(byId.get("grant-revoked"))).toEqual(["space.audit_read"]);

      // The rest of the document survives. A statement that replaced the
      // whole properties bag rather than the one path would pass every
      // assertion above and lose the grant's identity.
      const { rows: kept } = await db.execute(
        `SELECT json_extract(properties, '$.kind') AS kind,
                  json_extract(properties, '$.client_id') AS client_id,
                  typeof(properties) AS storage
             FROM items WHERE id = 'grant-live'`,
      );
      expect(kept[0]?.kind).toBe("app");
      expect(kept[0]?.client_id).toBe("client-live");
      // And it is still SQLite's binary JSONB rather than JSON text. A
      // `json_set` without the `jsonb(...)` wrapper reverts the encoding for
      // the rows it touches, which nothing else here would notice.
      expect(kept[0]?.storage).toBe("blob");
    } finally {
      db.close();
    }
  });

  it("leaves an integration manifest's capability alone", async () => {
    const db = createClient({ url: ":memory:" });
    try {
      await seed(db);
      await run(db);
      const { rows } = await db.execute(
        `SELECT json_extract(properties, '$.manifest.oauth_requirements') AS req
             FROM items WHERE id = 'conn-integration'`,
      );
      expect(parsed(rows[0]?.req)).toEqual({
        "capability.drive.upload": "leased",
      });
    } finally {
      db.close();
    }
  });

  it("stays put on a second run", async () => {
    const db = createClient({ url: ":memory:" });
    try {
      await seed(db);
      await run(db);
      // Every column, not just one: the two rewritten with `replace()`
      // rather than through the JSON functions are where a second pass is
      // most plausibly not a no-op.
      const snapshot = async () =>
        (
          await db.execute(
            `SELECT (SELECT scopes FROM auth_oauth_consent WHERE id = 'consent-1') AS consent,
                      (SELECT scope  FROM oauth_device_codes  WHERE id = 'dc-1')      AS device,
                      (SELECT value  FROM auth_verification   WHERE id = 'v-code')    AS code,
                      (SELECT json_extract(properties, '$.scopes')
                         FROM items WHERE id = 'grant-live')                          AS grant_scopes`,
          )
        ).rows[0];
      const first = await snapshot();
      await run(db);
      const second = await snapshot();
      expect(parsed(second?.consent)).toEqual(NEW_SET);
      expect(second).toEqual(first);
    } finally {
      db.close();
    }
  });
});
