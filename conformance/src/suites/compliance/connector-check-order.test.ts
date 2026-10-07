import { randomUUID } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { declareOversizeBody } from "../../utils/oversize.js";
import {
  cleanup,
  createSecondClient,
  createTestContext,
  getOperatorClient,
} from "../../utils/setup.js";

/**
 * Where one request meets two refusals on the connector doors, which of the
 * two it is told. Each pair has its witnesses: the request with only the
 * first fault, and the request with only the second, so that the answer
 * names an order rather than a door that never reaches the later check.
 */

let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
let owner: MarfaClient;
let stranger: MarfaClient;
let connectorId: string;

const STATE_CAP = 512 * 1024;
const RECORD_CAP = 16 * 1024;
const UNKNOWN = "01a0c000-0000-7000-8000-000000000000";

beforeAll(async () => {
  ({ ctx, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "connector-check-order",
  ));
  owner = await createSecondClient(ctx, "owner");
  stranger = await createSecondClient(ctx, "stranger");
  const registered = await owner.registerConnector({
    name: `${ctx.runId} order`,
  });
  expect(registered.status).toBe(201);
  connectorId = registered.data.id;
});

afterAll(async () => {
  await cleanup(ctx);
});

interface Answer {
  status: number;
  code: string | undefined;
  details: Record<string, unknown> | undefined;
}

interface Call {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** The path under `/connectors/{id}`, query included. */
  path: string;
  body?: Record<string, unknown>;
}

async function answer(
  who: MarfaClient,
  id: string,
  call: Call,
): Promise<Answer> {
  const res = await who.rawRequest<unknown>(`/connectors/${id}${call.path}`, {
    method: call.method,
    body: call.body,
  });
  return {
    status: res.status,
    code: res.error?.error.code,
    details: res.error?.error.details,
  };
}

/** What one door takes: a request it refuses on its own terms, and one it
 *  would take from the connector's own key. */
interface Door {
  label: string;
  bad: Call;
  good: Call;
  /** What a key that is not the connector's is told by the good request. */
  stranger: { status: number; code: string };
}

const forbidden = { status: 403, code: "forbidden" };
const hidden = { status: 404, code: "connector_not_found" };

/** A registration of its own, so a hold taken here is nobody else's. */
async function freshConnector(
  label: string,
): Promise<{ client: MarfaClient; id: string }> {
  const client = await createSecondClient(ctx, label);
  const registered = await client.registerConnector({
    name: `${ctx.runId} ${label}`,
  });
  expect(registered.status).toBe(201);
  return { client, id: registered.data.id };
}

const bodyDoors: Door[] = [
  {
    label: "POST runs",
    bad: {
      method: "POST",
      path: "/runs",
      body: {
        outcome: "skipped",
        started_at: "2026-10-05T18:00:00Z",
        finished_at: "2026-10-05T18:00:01Z",
      },
    },
    good: {
      method: "POST",
      path: "/runs",
      body: {
        outcome: "succeeded",
        started_at: "2026-10-05T18:00:00Z",
        finished_at: "2026-10-05T18:00:01Z",
      },
    },
    stranger: forbidden,
  },
  {
    label: "POST hold",
    bad: { method: "POST", path: "/hold", body: { process: "" } },
    good: { method: "POST", path: "/hold", body: { process: "p" } },
    stranger: forbidden,
  },
  {
    label: "DELETE hold",
    bad: { method: "DELETE", path: "/hold" },
    good: { method: "DELETE", path: "/hold?process=p" },
    stranger: forbidden,
  },
  {
    label: "PUT state",
    bad: { method: "PUT", path: "/state", body: { process: "p", state: [] } },
    good: { method: "PUT", path: "/state", body: { process: "p", state: {} } },
    stranger: forbidden,
  },
  {
    label: "POST agreements",
    bad: {
      method: "POST",
      path: "/agreements",
      body: {
        process: "p",
        set: [{ item_id: UNKNOWN, waiting: "yes", record: {} }],
      },
    },
    good: {
      method: "POST",
      path: "/agreements",
      body: { process: "p", clear: [UNKNOWN] },
    },
    stranger: forbidden,
  },
  {
    label: "POST agreements/lookup",
    bad: { method: "POST", path: "/agreements/lookup", body: { item_ids: [] } },
    good: {
      method: "POST",
      path: "/agreements/lookup",
      body: { item_ids: [UNKNOWN] },
    },
    stranger: forbidden,
  },
  {
    label: "POST endpoints",
    bad: { method: "POST", path: "/endpoints", body: { label: "" } },
    good: { method: "POST", path: "/endpoints", body: {} },
    stranger: forbidden,
  },
  {
    label: "POST deliveries/handled",
    bad: {
      method: "POST",
      path: "/deliveries/handled",
      body: { ids: [UNKNOWN], outcome: "done" },
    },
    good: {
      method: "POST",
      path: "/deliveries/handled",
      body: { ids: [UNKNOWN], outcome: "processed" },
    },
    stranger: forbidden,
  },
  {
    label: "GET runs",
    bad: { method: "GET", path: "/runs?limit=0" },
    good: { method: "GET", path: "/runs" },
    stranger: hidden,
  },
  {
    label: "GET agreements",
    bad: { method: "GET", path: "/agreements?limit=0" },
    good: { method: "GET", path: "/agreements" },
    stranger: forbidden,
  },
  {
    label: "GET deliveries",
    bad: { method: "GET", path: "/deliveries?limit=0" },
    good: { method: "GET", path: "/deliveries" },
    stranger: forbidden,
  },
];

describe("a body or query the door refuses, against the registration and the key", () => {
  it("answers a request the door refuses 400 before the registration's 404 and the key's 403", async () => {
    for (const door of bodyDoors) {
      const own = await answer(owner, connectorId, door.bad);
      expect(own.status, `${door.label}: own key`).toBe(400);
      expect(own.code).toMatch(/^(validation_error|missing_required_field)$/);

      const notTheirs = await answer(stranger, connectorId, door.bad);
      expect(notTheirs.status, `${door.label}: another key`).toBe(400);
      expect(notTheirs.code, door.label).toBe(own.code);

      const noSuchRegistration = await answer(stranger, UNKNOWN, door.bad);
      expect(noSuchRegistration.status, `${door.label}: unknown id`).toBe(400);
      expect(noSuchRegistration.code, door.label).toBe(own.code);

      // The witnesses: with nothing wrong in the request, the same two
      // callers meet the refusals the bad request did not reach.
      const witnessKey = await answer(stranger, connectorId, door.good);
      expect(witnessKey.status, `${door.label}: another key, good`).toBe(
        door.stranger.status,
      );
      expect(witnessKey.code, door.label).toBe(door.stranger.code);
      const witnessId = await answer(stranger, UNKNOWN, door.good);
      expect(witnessId.status, `${door.label}: unknown id, good`).toBe(404);
      expect(witnessId.code, door.label).toBe("connector_not_found");
    }
  });
});

describe("a registration that is not there, against the key", () => {
  const retireDoor: Call = {
    method: "DELETE",
    path: `/endpoints/${UNKNOWN}`,
  };
  const noBody: { label: string; call: Call }[] = [
    { label: "POST heartbeat", call: { method: "POST", path: "/heartbeat" } },
    { label: "GET state", call: { method: "GET", path: "/state" } },
    { label: "DELETE state", call: { method: "DELETE", path: "/state" } },
    { label: "GET endpoints", call: { method: "GET", path: "/endpoints" } },
    { label: "DELETE endpoints/{endpoint_id}", call: retireDoor },
    {
      label: "GET deliveries/{delivery_id}/body",
      call: { method: "GET", path: `/deliveries/${UNKNOWN}/body` },
    },
    { label: "DELETE connector", call: { method: "DELETE", path: "" } },
  ];

  it("answers a registration that is not there 404 before the key's 403, on every door the key reaches", async () => {
    const calls = [
      ...bodyDoors
        .filter((door) => door.stranger.status === 403)
        .map((door) => ({ label: door.label, call: door.good })),
      ...noBody,
    ];
    for (const { label, call } of calls) {
      const missing = await answer(stranger, UNKNOWN, call);
      expect(missing.status, `${label}: unknown id`).toBe(404);
      expect(missing.code, label).toBe("connector_not_found");
      // The witness: the same request to a registration that is there is
      // refused for the key.
      const refused = await answer(stranger, connectorId, call);
      expect(refused.status, `${label}: known id`).toBe(403);
      expect(refused.code, label).toBe("forbidden");
    }
    // The refused removal left the registration standing.
    expect((await owner.getConnector(connectorId)).status).toBe(200);
  });
});

describe("a field the door does not declare, against the key and the fence", () => {
  const strays: { label: string; call: Call; fence: Call }[] = [
    {
      label: "POST hold",
      call: {
        method: "POST",
        path: "/hold",
        body: { process: "p", window_ms: 1 },
      },
      fence: { method: "POST", path: "/hold", body: { process: "p" } },
    },
    {
      label: "PUT state",
      call: {
        method: "PUT",
        path: "/state",
        body: { process: "p", state: {}, merge: true },
      },
      fence: {
        method: "PUT",
        path: "/state",
        body: { process: "p", state: {} },
      },
    },
    {
      label: "POST agreements",
      call: {
        method: "POST",
        path: "/agreements",
        body: { process: "p", sets: [] },
      },
      fence: {
        method: "POST",
        path: "/agreements",
        body: { process: "p", clear: [UNKNOWN] },
      },
    },
    {
      label: "POST agreements/lookup",
      call: {
        method: "POST",
        path: "/agreements/lookup",
        body: { item_ids: [UNKNOWN], waiting: true },
      },
      fence: {
        method: "POST",
        path: "/agreements/lookup",
        body: { item_ids: [UNKNOWN] },
      },
    },
  ];

  it("answers the key's 403 and the registration's 404 before a field the door does not declare", async () => {
    for (const { label, call, fence } of strays) {
      // The witness: the connector's own key is told of the field.
      const own = await answer(owner, connectorId, call);
      expect(own.status, `${label}: own key`).toBe(400);
      expect(own.code).toBe("validation_error");
      expect(own.details?.["unknown_body_fields"], label).toBeDefined();

      const refused = await answer(stranger, connectorId, call);
      expect(refused.status, `${label}: another key`).toBe(403);
      expect(refused.code, label).toBe("forbidden");
      const operator = await answer(getOperatorClient(), connectorId, call);
      expect(operator.status, `${label}: operator`).toBe(403);
      const missing = await answer(stranger, UNKNOWN, call);
      expect(missing.status, `${label}: unknown id`).toBe(404);
      expect(missing.code, label).toBe("connector_not_found");

      // And the request without the field is a good one at the door.
      const clean = await answer(stranger, connectorId, fence);
      expect(clean.status, `${label}: another key, no field`).toBe(403);
    }
  });

  it("answers a field the door does not declare 400 before the fence's 409", async () => {
    const { client: own, id } = await freshConnector("fence");
    const holder = randomUUID();
    expect((await own.holdConnector(id, holder)).status).toBe(200);
    for (const { label, call, fence } of strays) {
      if (label === "POST hold" || label === "POST agreements/lookup") continue;
      const other = {
        ...call,
        body: { ...call.body, process: "another-process" },
      };
      const unfenced = await answer(own, id, other);
      expect(unfenced.status, `${label}: another process`).toBe(400);
      expect(unfenced.code, label).toBe("validation_error");
      expect(unfenced.details?.["unknown_body_fields"], label).toBeDefined();
      // The witness: without the field the same process is told it does not
      // hold the connector.
      const clean = await answer(own, id, {
        ...fence,
        body: { ...fence.body, process: "another-process" },
      });
      expect(clean.status, `${label}: another process, no field`).toBe(409);
      expect(clean.code, label).toBe("connector_held");
    }
  });

  it("answers a state or a batch the door refuses 400 before the fence's 409", async () => {
    const { client: own, id } = await freshConnector("fence-bodies");
    const holder = randomUUID();
    const other = "another-process";
    expect((await own.holdConnector(id, holder)).status).toBe(200);
    const row = uuidv7();
    const refused: { label: string; call: Call; fence: Call }[] = [
      {
        label: "a state over its cap",
        call: {
          method: "PUT",
          path: "/state",
          body: { state: { s: "x".repeat(STATE_CAP) } },
        },
        fence: { method: "PUT", path: "/state", body: { state: {} } },
      },
      {
        label: "a row named twice",
        call: {
          method: "POST",
          path: "/agreements",
          body: {
            set: [
              { item_id: row, waiting: true, record: {} },
              { item_id: row, waiting: false, record: {} },
            ],
          },
        },
        fence: {
          method: "POST",
          path: "/agreements",
          body: { clear: [row] },
        },
      },
      {
        label: "a record over its cap",
        call: {
          method: "POST",
          path: "/agreements",
          body: {
            set: [
              {
                item_id: row,
                waiting: true,
                record: { r: "x".repeat(RECORD_CAP) },
              },
            ],
          },
        },
        fence: {
          method: "POST",
          path: "/agreements",
          body: { clear: [row] },
        },
      },
    ];
    for (const { label, call, fence } of refused) {
      const named = (c: Call, process: string): Call => ({
        ...c,
        body: { process, ...c.body },
      });
      // The witness that the request is refused on its own terms: the
      // holder is told so.
      const holding = await answer(own, id, named(call, holder));
      expect(holding.status, `${label}: the holder`).toBe(400);
      expect(holding.code, label).toBe("validation_error");

      const notHolding = await answer(own, id, named(call, other));
      expect(notHolding.status, `${label}: another process`).toBe(400);
      expect(notHolding.code, label).toBe("validation_error");

      // The witness for the fence: a request that is fine is refused by it.
      const clean = await answer(own, id, named(fence, other));
      expect(clean.status, `${label}: another process, a fine request`).toBe(
        409,
      );
      expect(clean.code, label).toBe("connector_held");
    }
    expect((await own.getConnectorState(id)).data.updated_at).toBeNull();
  });
});

describe("a credential that is missing, against what the body would be refused for", () => {
  const bare = async (
    method: string,
    path: string,
    text: string,
  ): Promise<Answer> => {
    const res = await fetch(`${apiUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: text,
    });
    const body = (await res.json()) as {
      error?: { code?: string; details?: Record<string, unknown> };
    };
    return {
      status: res.status,
      code: body.error?.code,
      details: body.error?.details,
    };
  };

  it("answers a missing credential 401 before a body the door would refuse", async () => {
    const doors: {
      label: string;
      method: string;
      path: string;
      bad: string;
    }[] = [
      {
        label: "POST /connectors",
        method: "POST",
        path: "/connectors",
        bad: JSON.stringify({ name: "" }),
      },
      {
        label: "POST runs",
        method: "POST",
        path: `/connectors/${connectorId}/runs`,
        bad: JSON.stringify({ outcome: "skipped" }),
      },
      {
        label: "POST hold",
        method: "POST",
        path: `/connectors/${connectorId}/hold`,
        bad: JSON.stringify({ process: "" }),
      },
      {
        label: "PUT state",
        method: "PUT",
        path: `/connectors/${connectorId}/state`,
        bad: JSON.stringify({ process: "p", state: [] }),
      },
      {
        label: "POST agreements",
        method: "POST",
        path: `/connectors/${connectorId}/agreements`,
        bad: JSON.stringify({ process: "p", set: "none" }),
      },
      {
        label: "POST endpoints",
        method: "POST",
        path: `/connectors/${connectorId}/endpoints`,
        bad: JSON.stringify({ label: "" }),
      },
      {
        label: "POST deliveries/handled",
        method: "POST",
        path: `/connectors/${connectorId}/deliveries/handled`,
        bad: JSON.stringify({ ids: [], outcome: "done" }),
      },
    ];
    for (const { label, method, path, bad } of doors) {
      const unauthenticated = await bare(method, path, bad);
      expect(unauthenticated.status, label).toBe(401);
      expect(unauthenticated.code, label).toBe("unauthorized");
      // The witness: with a credential, the same body is the refusal.
      const res = await owner.rawRequest<unknown>(path, {
        method,
        body: JSON.parse(bad) as Record<string, unknown>,
      });
      expect(res.status, `${label}: with a credential`).toBe(400);
    }
  });

  it("answers a body nested too deep 400 before a missing credential's 401, and a body over the cap 413", async () => {
    const REQUEST_CAP = 1024 * 1024;
    const BULK_CAP = 16 * 1024 * 1024;
    const doors: {
      label: string;
      method: "POST" | "PUT";
      path: string;
      body: Record<string, unknown>;
      /** The cap the operation holds a body to. */
      cap: number;
    }[] = [
      {
        label: "POST /connectors",
        method: "POST",
        path: "/connectors",
        body: { name: "capped" },
        cap: REQUEST_CAP,
      },
      {
        label: "POST runs",
        method: "POST",
        path: `/connectors/${connectorId}/runs`,
        body: {
          outcome: "succeeded",
          started_at: "2026-10-05T18:00:00Z",
          finished_at: "2026-10-05T18:00:01Z",
        },
        cap: REQUEST_CAP,
      },
      {
        label: "POST hold",
        method: "POST",
        path: `/connectors/${connectorId}/hold`,
        body: { process: "p" },
        cap: REQUEST_CAP,
      },
      {
        label: "PUT state",
        method: "PUT",
        path: `/connectors/${connectorId}/state`,
        body: { process: "p", state: {} },
        cap: REQUEST_CAP,
      },
      {
        label: "POST agreements",
        method: "POST",
        path: `/connectors/${connectorId}/agreements`,
        body: { process: "p", clear: [UNKNOWN] },
        cap: BULK_CAP,
      },
      {
        label: "POST agreements/lookup",
        method: "POST",
        path: `/connectors/${connectorId}/agreements/lookup`,
        body: { item_ids: [UNKNOWN] },
        cap: REQUEST_CAP,
      },
      {
        label: "POST endpoints",
        method: "POST",
        path: `/connectors/${connectorId}/endpoints`,
        body: {},
        cap: REQUEST_CAP,
      },
      {
        label: "POST deliveries/handled",
        method: "POST",
        path: `/connectors/${connectorId}/deliveries/handled`,
        body: { ids: [UNKNOWN], outcome: "processed" },
        cap: REQUEST_CAP,
      },
    ];
    const nested = JSON.parse(`${"[".repeat(70)}${"]".repeat(70)}`) as unknown;

    for (const door of doors) {
      const { label, method, path } = door;
      // A field of its own, which a door ignores, so that what refuses the
      // deep body is its depth.
      const deep = { ...door.body, _nest: nested };
      const overCap = (headers: Record<string, string>) =>
        declareOversizeBody(`${apiUrl}${path}`, {
          method,
          headers: { "content-type": "application/json", ...headers },
          bytes: door.cap + 1,
        });

      // The witnesses: each body is refused for what it is when a credential
      // comes with it, and the plain body alone is a missing credential's.
      expect(
        (await bare(method, path, JSON.stringify(door.body))).status,
        `${label}: a plain body, no credential`,
      ).toBe(401);
      const withKey = await stranger.rawRequest<unknown>(path, {
        method,
        body: deep,
      });
      expect(withKey.status, `${label}: deep, with a credential`).toBe(400);
      expect(withKey.error?.error.code, label).toBe("validation_error");
      const sizedWith = await overCap({ Authorization: `Bearer ${apiKey}` });
      expect(
        sizedWith.status,
        `${label}: over the cap, with a credential`,
      ).toBe(413);

      const tooDeep = await bare(method, path, JSON.stringify(deep));
      expect(tooDeep.status, `${label}: deep`).toBe(400);
      expect(tooDeep.code, label).toBe("validation_error");
      const sized = await overCap({});
      expect(sized.status, `${label}: over the cap`).toBe(413);
      expect(
        (JSON.parse(sized.body) as { error: { code: string } }).error.code,
        label,
      ).toBe("request_too_large");
    }
  });

  it("answers the operator key 403 before a registration body it would be refused for", async () => {
    const operator = getOperatorClient();
    for (const body of [{ name: "" }, {}, { name: "n".repeat(201) }]) {
      const refused = await operator.rawRequest<unknown>("/connectors", {
        method: "POST",
        body,
      });
      expect(refused.status, JSON.stringify(body).slice(0, 30)).toBe(403);
      expect(refused.error?.error.code).toBe("forbidden");
      // The witness: a working key sending the body is refused for it.
      const invalid = await stranger.rawRequest<unknown>("/connectors", {
        method: "POST",
        body,
      });
      expect(invalid.status, JSON.stringify(body).slice(0, 30)).toBe(400);
    }
  });
});
