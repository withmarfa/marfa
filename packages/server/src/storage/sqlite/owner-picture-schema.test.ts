/**
 * The owner's picture has one source, the `owner_picture` table. The sign-in
 * library serves the `image` column of a user as the OIDC `picture` claim
 * and nothing in the claim hooks can take that back out, so `auth_user`
 * declares no such column, and a file that holds one is another build's.
 */
import { createClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConnection } from "./connection.js";
import { SCHEMA_VERSION } from "./migrations.js";
import { SCHEMA_SQL } from "./schema-shape.js";
import { RefusedDatabaseError } from "./refused-database.js";

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "marfa-owner-picture-"));
  dirs.push(dir);
  return join(dir, "marfa.db");
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const WITH_IMAGE = SCHEMA_SQL.replace(
  "\t`email_verified` integer DEFAULT false NOT NULL,\n",
  "\t`email_verified` integer DEFAULT false NOT NULL,\n\t`image` text,\n",
);

const OWNER_WITH_IMAGE =
  "INSERT INTO auth_user (id, name, email, email_verified, image, created_at, updated_at) VALUES ('u1', 'Owner', 'owner@example.test', 1, 'https://example.test/old.png', 1, 1);";

const OWNER =
  "INSERT INTO auth_user (id, name, email, email_verified, created_at, updated_at) VALUES ('u1', 'Owner', 'owner@example.test', 1, 1, 1);";

async function seed(path: string, ddl: string, after = ""): Promise<void> {
  const client = createClient({ url: `file:${path}` });
  try {
    await client.executeMultiple(ddl);
    // A file holding rows and no version is taken to be an unstamped
    // build's, so one with this build's tables carries this build's version.
    await client.execute(`PRAGMA user_version = ${String(SCHEMA_VERSION)}`);
    if (after !== "") await client.executeMultiple(after);
  } finally {
    client.close();
  }
}

describe("the owner's picture and the sign-in library's user table", () => {
  it("is declared by no column of the user table", async () => {
    const path = scratch();
    const connection = await createConnection(path);
    await connection.close();
    const client = createClient({ url: `file:${path}` });
    try {
      const columns = (await client.execute("PRAGMA table_info(auth_user)"))
        .rows;
      expect(columns.map((row) => row.name)).toContain("email_verified");
      expect(columns.map((row) => row.name)).not.toContain("image");
    } finally {
      client.close();
    }
  });

  it("refuses a file whose user table keeps an address as the image", async () => {
    // The witness: the same file without the column is this build's.
    const own = scratch();
    await seed(own, SCHEMA_SQL, OWNER);
    await (await createConnection(own)).close();

    const path = scratch();
    await seed(path, WITH_IMAGE, OWNER_WITH_IMAGE);
    const refusal = createConnection(path);
    await expect(refusal).rejects.toBeInstanceOf(RefusedDatabaseError);
    await expect(refusal).rejects.toThrow(
      /the auth_user table has image, which this build does not declare/,
    );
  });
});
