import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { codeOf, openBody } from "../../utils/inbound-sender.js";
import {
  cleanup,
  createSecondClient,
  createTestContext,
  getManagementClient,
} from "../../utils/setup.js";

/**
 * Requests that arrive together, held to the outcomes every ordering of them
 * allows. A race that happens to land one way proves nothing, so each test
 * asserts the set of answers the rule permits, never which request got which.
 */

let ctx: TestContext;
let auditor: MarfaClient;

beforeAll(async () => {
  ({ ctx, client: auditor } = await createTestContext(
    "compliance",
    "connector-races",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

const ROUNDS = 3;

async function registered(
  label: string,
): Promise<{ client: MarfaClient; id: string }> {
  const client = await createSecondClient(ctx, label);
  const made = await client.registerConnector({
    name: `${ctx.runId} ${label}`,
  });
  expect(made.status).toBe(201);
  return { client, id: made.data.id };
}

describe("registrations and holds taken together", () => {
  it("answers one 201 and one 200, with one id, when a key registers twice at once", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const own = await createSecondClient(ctx, `register-${String(round)}`);
      const names = [`${ctx.runId} first`, `${ctx.runId} second`];
      const answers = await Promise.all(
        names.map((name) => own.registerConnector({ name })),
      );
      expect(answers.map((a) => a.status).sort()).toEqual([200, 201]);
      const [a, b] = answers;
      expect(a?.data.id).toBe(b?.data.id);

      const mine = (await own.listConnectors()).data.data;
      expect(mine.map((row) => row.id)).toEqual([a?.data.id]);
      expect(names).toContain(mine[0]?.name);
    }
  });

  it("answers one 200 and one 404, and audits once, when a registration is removed twice at once", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { client, id } = await registered(`remove-${String(round)}`);
      const answers = await Promise.all([
        client.deleteConnector(id),
        getManagementClient().deleteConnector(id),
      ]);
      expect(answers.map((a) => a.status).sort()).toEqual([200, 404]);
      const lost = answers.find((a) => a.status === 404);
      expect(lost?.error?.error.code).toBe("connector_not_found");

      expect((await getManagementClient().getConnector(id)).status).toBe(404);
      const audited = await auditor.listAudit({
        resource_id: id,
        action: "connector.delete",
      });
      expect(audited.data.data).toHaveLength(1);
    }
  });

  it("gives the hold to exactly one of two processes that take it at once", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { client, id } = await registered(`hold-${String(round)}`);
      const processes = [randomUUID(), randomUUID()];
      const answers = await Promise.all(
        processes.map((process) => client.holdConnector(id, process)),
      );
      expect(answers.map((a) => a.status).sort()).toEqual([200, 409]);
      const won = answers.find((a) => a.status === 200);
      const lost = answers.find((a) => a.status === 409);
      expect(lost?.error?.error.code).toBe("connector_held");
      expect(lost?.error?.error.details?.["expires_at"]).toBe(
        won?.data.expires_at,
      );
      expect((await client.getConnector(id)).data.hold_expires_at).toBe(
        won?.data.expires_at,
      );
      // The witness that the winner is a holder and the loser is not: the
      // one that took it renews.
      const winner = processes[answers.indexOf(won!)];
      expect(winner).toBeDefined();
      expect((await client.holdConnector(id, winner!)).data.renewed).toBe(true);
    }
  });

  it("makes ten live endpoints and refuses the rest when twenty are asked for at once", async () => {
    const { client, id } = await registered("endpoints");
    const answers = await Promise.all(
      Array.from({ length: 20 }, () => client.createInboundEndpoint(id)),
    );
    const made = answers.filter((a) => a.status === 201);
    const refused = answers.filter((a) => a.status === 409);
    expect(made).toHaveLength(10);
    expect(refused).toHaveLength(10);
    for (const a of refused) expect(a.error?.error.code).toBe("conflict");

    const listed = (await client.listInboundEndpoints(id)).data.data;
    expect(listed.map((row) => row.id).sort()).toEqual(
      made.map((a) => a.data.id).sort(),
    );
    expect(new Set(made.map((a) => a.data.path)).size).toBe(10);
  });
});

describe("receipts that complete together on an instance that caps its backlog", () => {
  let server: FreshServer;
  let minter: MarfaClient;
  let serial = 0;

  beforeAll(async () => {
    server = await bootFreshServer("inbound-race", {
      MARFA_INBOUND_BACKLOG_DELIVERIES: "2",
      MARFA_INBOUND_BACKLOG_BYTES: "4",
    });
    minter = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: server.workingKey,
    });
  }, 2 * FRESH_SERVER_TIMEOUT_MS);

  afterAll(async () => {
    await server.stop();
  }, 2 * FRESH_SERVER_TIMEOUT_MS);

  async function endpoint(): Promise<{
    client: MarfaClient;
    id: string;
    path: string;
  }> {
    serial += 1;
    const label = `race-${String(serial)}`;
    const minted = await minter.createKey({
      label,
      source: label,
      default_tier: "library",
    });
    expect(minted.status).toBe(201);
    const client = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: minted.data.key,
    });
    const registration = await client.registerConnector({ name: label });
    expect(registration.status).toBe(201);
    const made = await client.createInboundEndpoint(registration.data.id);
    expect(made.status).toBe(201);
    return { client, id: registration.data.id, path: made.data.path };
  }

  /** `count` bodies of `size` bytes, each begun and then all finished at
   *  once, so no answer is given before every body is on its way. */
  async function together(path: string, count: number, size: number) {
    const open = Array.from({ length: count }, () =>
      openBody(server.apiUrl, path, size, "x"),
    );
    for (const body of open) body.finish("x".repeat(size - 1));
    return Promise.all(open.map((body) => body.answer));
  }

  it("takes no more receipts than the backlog holds in deliveries when three complete together", async () => {
    const { client, id, path } = await endpoint();
    const answers = await together(path, 3, 1);
    expect(answers.map((a) => a.status).sort()).toEqual([202, 202, 503]);
    const refused = answers.find((a) => a.status === 503);
    expect(refused === undefined ? undefined : codeOf(refused)).toBe(
      "inbound_unavailable",
    );
    const stored = await client.listInboundDeliveries(id);
    expect(stored.data.data).toHaveLength(2);
  });

  it("takes no more receipts than the backlog holds in bytes when three complete together", async () => {
    const { client, id, path } = await endpoint();
    const answers = await together(path, 3, 3);
    expect(answers.map((a) => a.status).sort()).toEqual([202, 503, 503]);
    for (const refused of answers.filter((a) => a.status === 503)) {
      expect(codeOf(refused)).toBe("inbound_unavailable");
    }
    const stored = await client.listInboundDeliveries(id);
    expect(stored.data.data.map((row) => row.size)).toEqual([3]);
  });
});
