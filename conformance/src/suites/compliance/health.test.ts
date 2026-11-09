import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approvedAppToken,
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * What `GET /health` says when a component is not well, and to whom
 * (the instance chapter's `instance/health-*` rules).
 *
 * **Every fault is made on a server of the fixture's own.** The run's server
 * is healthy and shared, and no operation makes a component `down`. What
 * does is a `refuse:` fault, which makes the server refuse reads, writes or
 * its blob store, or hold a write as a lock held elsewhere would. Each is
 * cleared before the next case, and the server is the same one throughout.
 *
 * The write probe is committed at most once every ten seconds and its
 * outcome, a refusal included, answers the calls in between. So a fault that
 * touches only the write is seen by polling until the window ends, which is
 * a wait on a condition and not on a clock.
 *
 * The server's busy budget is zero, so a write held by `refuse:write-lock`
 * is refused at once instead of waiting out a budget of its own.
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

/** The statuses of every component other than `except`. */
function othersOf(answer: Pick<Answer, "body">, except: string): string[] {
  return COMPONENTS.filter((name) => name !== except).map(
    (name) => answer.body.components[name]?.status ?? "missing",
  );
}

describe("GET /health when a component is down", () => {
  it("answers 503 with the database down when the database refuses a read, and 200 once it answers", async () => {
    // The witness: before the fault the answer is `200` and `ok`.
    const before = await until(isOk);
    expect(Object.keys(before.body.components).sort()).toEqual(COMPONENTS);

    await server!.setFault("refuse:read");
    let down: Answer;
    try {
      down = await until((answer) => answer.httpStatus === 503);
    } finally {
      await server!.clearFault("refuse:read");
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

    await server!.setFault("refuse:write");
    let down: Answer;
    try {
      down = await until((answer) => answer.httpStatus === 503);
    } finally {
      await server!.clearFault("refuse:write");
    }
    expect(down.body.status).toBe("down");
    expect(down.body.components.database_write?.status).toBe("down");
    expect(down.body.components.database?.status).toBe("ok");

    const after = await until(isOk);
    expect(after.body.components.database_write?.status).toBe("ok");
  }, 120_000);

  it("answers 503 with blob storage down when the disk store refuses, and 200 once it answers", async () => {
    expect((await until(isOk)).httpStatus).toBe(200);

    await server!.setFault("refuse:blob-store");
    let down: Answer;
    try {
      down = await until((answer) => answer.httpStatus === 503);
    } finally {
      await server!.clearFault("refuse:blob-store");
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

    await server!.setFault("refuse:write-lock");
    let degraded: Answer;
    try {
      degraded = await until((answer) => answer.body.status === "degraded");
    } finally {
      await server!.clearFault("refuse:write-lock");
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
    expect((await until(isOk)).httpStatus).toBe(200);

    // The first `degraded` after an `ok` is a write the probe attempted and
    // was refused, since a cached `ok` cannot turn into one.
    await server!.setFault("refuse:write-lock");
    try {
      await until((answer) => answer.body.status === "degraded");
    } finally {
      await server!.clearFault("refuse:write-lock");
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

    // The window ends and the probe writes again.
    const after = await until(isOk);
    expect(after.body.components.database_write?.status).toBe("ok");
  }, 120_000);

  it("commits its write once in ten seconds however many callers ask", async () => {
    await until(isOk);
    // The probe's next write fails, once. A probe that wrote on every call
    // would answer `ok` from the second call on; one that writes once per
    // window answers every call in it with that one failure.
    await server!.setFault("fail:health-write");
    const first = await until((answer) => answer.httpStatus === 503);
    expect(first.body.components.database_write?.status).toBe("down");

    const started = Date.now();
    for (let call = 0; call < 40; call++) {
      const answer = await health();
      expect(answer.httpStatus, `call ${call}`).toBe(503);
      expect(
        answer.body.components.database_write?.status,
        `call ${call}`,
      ).toBe("down");
    }
    expect(Date.now() - started, "the callers outran the window").toBeLessThan(
      WINDOW_MS,
    );
    const armed = (await server!.faults()).find(
      (fault) => fault.name === "fail:health-write",
    );
    expect(armed?.fired).toBe(1);

    const after = await until(isOk);
    expect(after.body.components.database_write?.status).toBe("ok");
  }, 120_000);
});

describe("the error text of GET /health", () => {
  it("is given to a key with instance.read and withheld without that permission", async () => {
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

    await server!.setFault("refuse:write");
    try {
      // The management key is told what the database said, which is the witness
      // that there is text to leave out.
      const told = await until(
        (answer) => answer.httpStatus === 503,
        server!.managementKey,
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
      await server!.clearFault("refuse:write");
    }
  }, 120_000);

  it("is withheld from bearer credentials while the database cannot look keys up", async () => {
    const callers: [string, string | undefined][] = [
      ["the management key", server!.managementKey],
      ["a working key", server!.workingKey],
      ["a key the instance does not hold", "marfa_a-key-no-instance-holds"],
      ["no credential", undefined],
    ];
    expect((await until(isOk)).httpStatus).toBe(200);

    await server!.setFault("refuse:write");
    try {
      // The write refusal, with the keys readable: the management key is
      // told, so there is text to leave out below.
      const told = await until(
        (answer) => answer.httpStatus === 503,
        server!.managementKey,
      );
      expect(told.body.components.database_write?.error).toEqual(
        expect.any(String),
      );

      // Reads go too. The write's refusal is the same one and the text is
      // still there to give.
      await server!.setFault("refuse:read");
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
        await server!.clearFault("refuse:read");
      }

      // With reads back the management key is told again, so what was
      // withheld was withheld for the lookup and not for the key.
      const toldAgain = await health(server!.managementKey);
      expect(toldAgain.body.components.database_write?.error).toEqual(
        expect.any(String),
      );
    } finally {
      await server!.clearFault("refuse:write");
    }
  }, 120_000);
});

describe("GET /health while the write outlasts its two seconds", () => {
  /** Above the two seconds a probe is given, so the write is still waiting
   *  on the lock, and not refused, when the probe stops waiting. */
  const BUSY_BUDGET_MS = 20_000;
  const PROBE_BUDGET_MS = 2_000;
  let patient: FreshServer;

  beforeAll(async () => {
    patient = await bootFreshServer("health-patient", {
      SQLITE_BUSY_BUDGET_MS: String(BUSY_BUDGET_MS),
    });
  }, FRESH_SERVER_TIMEOUT_MS);

  async function ask(): Promise<Answer & { elapsedMs: number }> {
    const started = Date.now();
    const response = await fetch(`${patient.apiUrl}/health`, {
      headers: { Authorization: `Bearer ${patient.managementKey}` },
    });
    return {
      httpStatus: response.status,
      body: (await response.json()) as Health,
      elapsedMs: Date.now() - started,
    };
  }

  it("answers the write component degraded and the status 200 when the probe has given no answer within two seconds, and ok once the lock is released", async () => {
    // The witness: with no lock the write commits and the answer is quick.
    const before = await ask();
    expect(before.httpStatus).toBe(200);
    expect(before.body.components.database_write?.status).toBe("ok");
    expect(before.elapsedMs).toBeLessThan(PROBE_BUDGET_MS);

    await patient.setFault("refuse:write-lock");
    let silent: Awaited<ReturnType<typeof ask>>;
    try {
      // The write that answered above is reused for ten seconds, so the
      // first call that is not `ok` is the one that attempts a write.
      const deadline = Date.now() + POLL_BUDGET_MS;
      silent = await ask();
      while (silent.body.status === "ok") {
        if (Date.now() > deadline) {
          throw new Error("the write probe never met the held lock");
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        silent = await ask();
      }
    } finally {
      await patient.clearFault("refuse:write-lock");
    }

    expect(silent.httpStatus).toBe(200);
    expect(silent.body.status).toBe("degraded");
    expect(silent.body.components.database_write?.status).toBe("degraded");
    expect(othersOf(silent, "database_write")).toEqual(["ok", "ok", "ok"]);
    // A silence and not a refusal: the answer came when the probe's own
    // budget ran out, long before the write's busy budget would have
    // refused it with `write_contention`.
    expect(silent.elapsedMs).toBeGreaterThanOrEqual(PROBE_BUDGET_MS);
    expect(silent.elapsedMs).toBeLessThan(BUSY_BUDGET_MS);
    expect(silent.body.components.database_write?.error).toMatch(
      /no write committed within 2000ms/,
    );

    // The write that was waiting lands once the lock is gone.
    const deadline = Date.now() + POLL_BUDGET_MS;
    let after = await ask();
    while (after.body.status !== "ok") {
      if (Date.now() > deadline) {
        throw new Error(`/health never recovered: ${JSON.stringify(after)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      after = await ask();
    }
    expect(after.httpStatus).toBe(200);
  }, 120_000);
});

describe("GET /health when the free space cannot be read", () => {
  let own: FreshServer;

  beforeAll(async () => {
    own = await bootFreshServer("health-disk");
  }, FRESH_SERVER_TIMEOUT_MS);

  async function ask(): Promise<Answer> {
    const response = await fetch(`${own.apiUrl}/health`, {
      headers: { Authorization: `Bearer ${own.managementKey}` },
    });
    return {
      httpStatus: response.status,
      body: (await response.json()) as Health,
    };
  }

  it("answers the disk component degraded, never down, and blob storage down, when the free space cannot be read and the store refuses, and ok once both are cleared", async () => {
    // The witness: both volumes are measured and are `ok`.
    const before = await ask();
    expect(before.httpStatus).toBe(200);
    expect(before.body.status).toBe("ok");
    expect(before.body.components.disk?.status).toBe("ok");
    expect(before.body.components.blob_storage?.status).toBe("ok");

    // Either volume alone, unreadable, leaves the instance serving.
    for (const volume of ["blobs", "database"]) {
      await own.setFault(`free:${volume}=unknown`);
      let alone: Answer;
      try {
        alone = await ask();
      } finally {
        await own.clearFault(`free:${volume}`);
      }
      expect(alone.body.components.disk?.status, volume).toBe("degraded");
      expect(alone.body.components.disk?.error, volume).toMatch(
        /^free space unknown/,
      );
      expect(othersOf(alone, "disk"), volume).toEqual(["ok", "ok", "ok"]);
      expect(alone.body.status, volume).toBe("degraded");
      expect(alone.httpStatus, volume).toBe(200);
    }

    // With a store that refuses as well, the status is 503 for that
    // component: free space unknown is not down, so the disk stays
    // `degraded`.
    await own.setFault("free:blobs=unknown");
    await own.setFault("refuse:blob-store");
    let unknown: Answer;
    try {
      unknown = await ask();
    } finally {
      await own.clearFault();
    }
    expect(unknown.body.components.disk?.status).toBe("degraded");
    expect(unknown.body.components.disk?.error).toMatch(/^free space unknown/);
    expect(unknown.body.components.blob_storage?.status).toBe("down");
    expect(unknown.body.components.blob_storage?.error).not.toContain(
      own.stateDir,
    );
    expect(othersOf(unknown, "disk")).toEqual(["down", "ok", "ok"]);
    expect(unknown.body.status).toBe("down");
    expect(unknown.httpStatus).toBe(503);

    const after = await ask();
    expect(after.httpStatus).toBe(200);
    expect(after.body.status).toBe("ok");
    expect(after.body.components.disk?.status).toBe("ok");
    expect(after.body.components.blob_storage?.status).toBe("ok");
  }, 120_000);

  it("answers the disk and blob storage components degraded within two seconds when the filesystem does not answer, while other requests are served, and ok once it does", async () => {
    // The witness: with the filesystem answering, the same call is quick and `ok`.
    const before = await ask();
    expect(before.body.components.disk?.status).toBe("ok");
    expect(before.body.components.blob_storage?.status).toBe("ok");

    await own.setFault("hold:disk-probe");
    let held: Answer;
    let elapsedMs: number;
    let meanwhile: Response[];
    try {
      const started = Date.now();
      const asking = ask();
      // Calls that arrive while the probes are blocked are served and not queued behind them.
      meanwhile = await Promise.all(
        Array.from({ length: 64 }, () => fetch(`${own.apiUrl}/`)),
      );
      held = await asking;
      elapsedMs = Date.now() - started;
    } finally {
      await own.clearFault("hold:disk-probe");
    }
    expect(meanwhile.map((response) => response.status)).toEqual(
      meanwhile.map(() => 200),
    );
    expect(held.body.components.disk?.status).toBe("degraded");
    expect(held.body.components.disk?.error).toMatch(/within 2000ms$/);
    expect(held.body.components.blob_storage?.status).toBe("degraded");
    expect(held.body.components.blob_storage?.error).toMatch(/within 2000ms$/);
    expect(othersOf(held, "disk")).toEqual(["degraded", "ok", "ok"]);
    expect(held.httpStatus).toBe(200);
    expect(elapsedMs).toBeLessThan(5_000);

    const after = await ask();
    expect(after.body.status).toBe("ok");
    expect(after.body.components.disk?.status).toBe("ok");
    expect(after.body.components.blob_storage?.status).toBe("ok");
  }, 120_000);
});
