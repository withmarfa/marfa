import { renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approvedAppToken,
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { HeldLock } from "../../utils/held-lock.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";

/**
 * What `GET /health` says when a component is not well, and to whom
 * (the instance chapter's `instance/health-*` rules).
 *
 * **Every fault is made on a server of the fixture's own.** The run's server
 * is healthy and shared, and no door makes a component `down`. What does is
 * the stored state under a running server: a table renamed in the live
 * database file, the blob folder swapped for a file, or the write lock held
 * from a second connection. Each is undone before the next case, and the
 * server is the same one throughout.
 *
 * The write probe is committed at most once every ten seconds and its
 * outcome, a refusal included, answers the calls in between. So a fault that
 * touches only the write is seen by polling until the window ends, which is
 * a wait on a condition and not on a clock.
 *
 * The server's busy budget is zero, so a write that meets a held lock is
 * refused at once instead of waiting out a budget of its own.
 */
let server: FreshServer | undefined;

beforeAll(async () => {
  server = await bootFreshServer("health", { SQLITE_BUSY_BUDGET_MS: "0" });
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(stopFreshServers, FRESH_SERVER_TIMEOUT_MS);

interface Component {
  status: string;
  latency_ms?: number;
  error?: string;
}

interface Health {
  status: string;
  components: Record<string, Component>;
}

interface Answer {
  httpStatus: number;
  body: Health;
}

/** The window the write probe's outcome answers for, plus a margin. */
const WINDOW_MS = 10_000;
const POLL_BUDGET_MS = WINDOW_MS + 8_000;

const COMPONENTS = ["blob_storage", "database", "database_write", "disk"];

async function health(credential?: string): Promise<Answer> {
  const response = await fetch(`${server!.apiUrl}/health`, {
    headers:
      credential === undefined ? {} : { Authorization: `Bearer ${credential}` },
  });
  return {
    httpStatus: response.status,
    body: (await response.json()) as Health,
  };
}

/** Asks until `wanted` holds of an answer, and returns that answer. */
async function until(
  wanted: (answer: Answer) => boolean,
  credential?: string,
): Promise<Answer> {
  const deadline = Date.now() + POLL_BUDGET_MS;
  let last = await health(credential);
  while (!wanted(last)) {
    if (Date.now() > deadline) {
      throw new Error(
        `/health never reached the state asked for; the last answer was ${String(last.httpStatus)} ${JSON.stringify(last.body)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    last = await health(credential);
  }
  return last;
}

const isOk = (answer: Answer): boolean =>
  answer.httpStatus === 200 && answer.body.status === "ok";

function renameTable(from: string, to: string): void {
  withInstanceDatabase(server!.sqlitePath, (db) => {
    db.exec(`ALTER TABLE ${from} RENAME TO ${to}`);
  });
}

/** The statuses of every component other than `except`. */
function othersOf(answer: Answer, except: string): string[] {
  return COMPONENTS.filter((name) => name !== except).map(
    (name) => answer.body.components[name]?.status ?? "missing",
  );
}

/** The stored write probe: the instant it last committed. */
function storedProbe(): string {
  return withInstanceDatabase(server!.sqlitePath, (db) => {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'health_probe'")
      .get() as { value: string } | undefined;
    return row?.value ?? "";
  });
}

describe("GET /health when a component is down", () => {
  it("answers 503 with the database down when the database refuses a read, and 200 once it answers", async () => {
    // The witness: before the fault the answer is `200` and `ok`.
    const before = await until(isOk);
    expect(Object.keys(before.body.components).sort()).toEqual(COMPONENTS);

    renameTable("api_keys", "api_keys_away");
    let down: Answer;
    try {
      down = await until((answer) => answer.httpStatus === 503);
    } finally {
      renameTable("api_keys_away", "api_keys");
    }
    expect(down.body.status).toBe("down");
    expect(down.body.components.database?.status).toBe("down");

    const after = await until(isOk);
    expect(after.httpStatus).toBe(200);
    expect(after.body.components.database?.status).toBe("ok");
  }, 120_000);

  it("answers 503 with the database write down when the database refuses a write, and 200 once it takes one", async () => {
    // Reads answer throughout: the database that cannot be written to is not
    // the one that cannot be read, and only a committed write shows it.
    expect((await until(isOk)).httpStatus).toBe(200);

    renameTable("settings", "settings_away");
    let down: Answer;
    try {
      down = await until((answer) => answer.httpStatus === 503);
    } finally {
      renameTable("settings_away", "settings");
    }
    expect(down.body.status).toBe("down");
    expect(down.body.components.database_write?.status).toBe("down");
    expect(down.body.components.database?.status).toBe("ok");

    const after = await until(isOk);
    expect(after.body.components.database_write?.status).toBe("ok");
  }, 120_000);

  it("answers 503 with blob storage down when the disk store refuses, and 200 once it answers", async () => {
    expect((await until(isOk)).httpStatus).toBe(200);

    // A file where the folder was: a path under it is not a missing file but
    // one the store cannot look for, which is a refusal and not an absence.
    const blobs = join(dirname(server!.sqlitePath), "blobs");
    const away = `${blobs}-away`;
    renameSync(blobs, away);
    writeFileSync(blobs, "not a folder");
    let down: Answer;
    try {
      down = await until((answer) => answer.httpStatus === 503);
    } finally {
      rmSync(blobs, { force: true });
      renameSync(away, blobs);
    }
    expect(down.body.status).toBe("down");
    expect(down.body.components.blob_storage?.status).toBe("down");
    expect(down.body.components.database?.status).toBe("ok");

    const after = await until(isOk);
    expect(after.body.components.blob_storage?.status).toBe("ok");
  }, 120_000);
});

describe("GET /health while another connection holds the write lock", () => {
  it("answers 200 and degraded while the write is refused, and ok once the lock is released", async () => {
    expect((await until(isOk)).httpStatus).toBe(200);

    const lock = await HeldLock.take(server!.sqlitePath);
    let degraded: Answer;
    try {
      degraded = await until((answer) => answer.body.status === "degraded");
    } finally {
      await lock.release();
    }
    // `degraded` still serves, so it is not a failure to a gate that reads the
    // status code.
    expect(degraded.httpStatus).toBe(200);
    expect(degraded.body.components.database_write?.status).toBe("degraded");
    expect(othersOf(degraded, "database_write")).toEqual(["ok", "ok", "ok"]);

    const after = await until(isOk);
    expect(after.body.components.database_write?.status).toBe("ok");
  }, 120_000);
});

describe("the write probe", () => {
  it("answers the calls within ten seconds of its last write with that write's outcome, and writes again after", async () => {
    const ok = await until(isOk);
    expect(ok.httpStatus).toBe(200);
    const committed = storedProbe();
    expect(Number.isNaN(Date.parse(committed))).toBe(false);

    // The first `degraded` after an `ok` is a write the probe attempted and
    // was refused, since a cached `ok` cannot turn into one.
    const lock = await HeldLock.take(server!.sqlitePath);
    try {
      await until((answer) => answer.body.status === "degraded");
    } finally {
      await lock.release();
    }

    // The lock is gone, so a write now would land. The calls that follow
    // still say `degraded`, which is the refusal answering for them.
    for (let call = 1; call <= 3; call++) {
      const answer = await health();
      expect(
        answer.body.components.database_write?.status,
        `call ${call}`,
      ).toBe("degraded");
    }
    expect(storedProbe()).toBe(committed);

    // The window ends and the probe writes again.
    const after = await until(isOk);
    expect(after.body.components.database_write?.status).toBe("ok");
    expect(Date.parse(storedProbe())).toBeGreaterThan(Date.parse(committed));
  }, 120_000);

  it("commits its write once in ten seconds however many callers ask", async () => {
    await until(isOk);
    // Callers over a span much shorter than the window. A probe that wrote on
    // every call would leave a different instant after each of them, and one
    // that writes once per window can leave a new one at most once.
    const instants = new Set<string>([storedProbe()]);
    const started = Date.now();
    for (let call = 0; call < 40; call++) {
      expect((await health()).httpStatus).toBe(200);
      instants.add(storedProbe());
    }
    expect(Date.now() - started, "the callers outran the window").toBeLessThan(
      WINDOW_MS,
    );
    expect(instants.size).toBeLessThanOrEqual(2);
    for (const instant of instants) {
      expect(Number.isNaN(Date.parse(instant)), instant).toBe(false);
    }
  }, 120_000);
});

describe("the error text of GET /health", () => {
  it("is given to the operator key and to no other caller", async () => {
    expect((await until(isOk)).httpStatus).toBe(200);
    const appToken = await approvedAppToken(server!);
    const strangers: [string, string | undefined][] = [
      ["a working key", server!.workingKey],
      ["an app's access token", appToken],
      ["a key the instance does not hold", "marfa_a-key-no-instance-holds"],
      ["no credential", undefined],
    ];
    // The witness that the app's token is a credential the instance
    // accepts, so that it is withheld from by rule and not for being unknown.
    const accepted = await fetch(`${server!.apiUrl}/items?limit=1`, {
      headers: { Authorization: `Bearer ${appToken}` },
    });
    expect(accepted.status).toBe(200);

    renameTable("settings", "settings_away");
    try {
      // The operator key is told what the database said, which is the witness
      // that there is text to leave out.
      const told = await until(
        (answer) => answer.httpStatus === 503,
        server!.operatorKey,
      );
      const text = told.body.components.database_write?.error;
      expect(text).toEqual(expect.any(String));
      expect(text).not.toBe("");

      for (const [who, credential] of strangers) {
        const answer = await health(credential);
        expect(answer.httpStatus, who).toBe(503);
        expect(answer.body.status, who).toBe("down");
        expect(answer.body.components.database_write?.status, who).toBe("down");
        for (const [name, component] of Object.entries(
          answer.body.components,
        )) {
          expect(component, `${who}: ${name}`).not.toHaveProperty("error");
        }
      }
    } finally {
      renameTable("settings_away", "settings");
    }
  }, 120_000);

  it("is given to no caller, the operator key included, while the database cannot look the key up", async () => {
    const callers: [string, string | undefined][] = [
      ["the operator key", server!.operatorKey],
      ["a working key", server!.workingKey],
      ["a key the instance does not hold", "marfa_a-key-no-instance-holds"],
      ["no credential", undefined],
    ];
    expect((await until(isOk)).httpStatus).toBe(200);

    renameTable("settings", "settings_away");
    try {
      // The write refusal, with the key table readable: the operator key is
      // told, so there is text to leave out below.
      const told = await until(
        (answer) => answer.httpStatus === 503,
        server!.operatorKey,
      );
      expect(told.body.components.database_write?.error).toEqual(
        expect.any(String),
      );

      // The key table goes too. The write's refusal is the same one and the
      // text is still there to give.
      renameTable("api_keys", "api_keys_away");
      try {
        for (const [who, credential] of callers) {
          const answer = await health(credential);
          expect(answer.httpStatus, who).toBe(503);
          expect(answer.body.components.database?.status, who).toBe("down");
          expect(answer.body.components.database_write?.status, who).toBe(
            "down",
          );
          for (const [name, component] of Object.entries(
            answer.body.components,
          )) {
            expect(component, `${who}: ${name}`).not.toHaveProperty("error");
          }
        }
      } finally {
        renameTable("api_keys_away", "api_keys");
      }

      // With the key table back the operator key is told again, so what was
      // withheld was withheld for the lookup and not for the key.
      const toldAgain = await health(server!.operatorKey);
      expect(toldAgain.body.components.database_write?.error).toEqual(
        expect.any(String),
      );
    } finally {
      renameTable("settings_away", "settings");
    }
  }, 120_000);
});
