import { describe, it, expect, vi } from "vitest";
import { MymeClient } from "./client.js";

// ---------------------------------------------------------------------------
// `client.connections` SDK namespace coverage. Pins:
//   - `install(input)` POSTs to `/connections/install` with the body shape.
//   - `uninstall(id)` POSTs to `/connections/:id/uninstall` with no body.
//   - The typed result shapes returned by the routes are surfaced to the
//     caller unchanged.
//
// End-to-end coverage of the routes + pipelines lives in
// `packages/server/src/routes/connections.test.ts` and
// `packages/server/src/connections/{install,uninstall}-pipeline.test.ts`.
// The SDK tests here use a mock fetch — the in-process integration server
// in `client.test.ts` already exercises every other namespace; spinning
// up a second server fixture for two methods would be overkill.
// ---------------------------------------------------------------------------

function makeClient(fetchImpl: typeof globalThis.fetch): MymeClient {
  return new MymeClient({
    url: "http://example.test",
    apiKey: "myme_k1_test",
    fetch: fetchImpl,
  });
}

function makeJsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("client.connections.install", () => {
  it("issues POST /connections/install with the typed body and returns the install result", async () => {
    const fakeResult = {
      connection_id: "itm_conn_99",
      credential_id: "api_cred_99",
      activity_id: "itm_act_99",
    };

    const mockFetch = vi.fn(
      (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const urlStr =
          typeof url === "string"
            ? url
            : url instanceof URL
              ? url.href
              : url.url;
        expect(urlStr).toBe("http://example.test/connections/install");
        expect(init?.method).toBe("POST");
        const body = JSON.parse(init?.body as string) as Record<
          string,
          unknown
        >;
        expect(body).toEqual({
          integration_id: "itm_int_42",
          label: "Acme Slack",
        });
        return Promise.resolve(makeJsonResponse(201, fakeResult));
      },
    );

    const client = makeClient(mockFetch as unknown as typeof globalThis.fetch);
    const result = await client.connections.install({
      integration_id: "itm_int_42",
      label: "Acme Slack",
    });

    expect(result).toEqual(fakeResult);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("omits the optional label when not provided", async () => {
    const mockFetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const body = JSON.parse(init?.body as string) as Record<
          string,
          unknown
        >;
        expect(body).toEqual({ integration_id: "itm_int_43" });
        return Promise.resolve(
          makeJsonResponse(201, {
            connection_id: "x",
            credential_id: "y",
            activity_id: "z",
          }),
        );
      },
    );

    const client = makeClient(mockFetch as unknown as typeof globalThis.fetch);
    await client.connections.install({ integration_id: "itm_int_43" });
  });

  it("propagates 404 / 400 errors through the typed-error mapping", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeJsonResponse(404, {
        error: { code: "not_found", message: "Integration not found" },
      }),
    );
    const client = makeClient(mockFetch as unknown as typeof globalThis.fetch);

    await expect(
      client.connections.install({ integration_id: "itm_missing" }),
    ).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
  });
});

describe("client.connections.uninstall", () => {
  it("issues POST /connections/:id/uninstall with no body and returns the typed result", async () => {
    const fakeResult = {
      connection_id: "itm_conn_1",
      revoked_credential_ids: ["api_cred_1"],
      oauth_tokens_deleted: false,
      leased_tokens_revoked: 0,
      inbound_webhooks_disabled: 0,
      activity_id: "itm_act_1",
    };

    const mockFetch = vi.fn(
      (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const urlStr =
          typeof url === "string"
            ? url
            : url instanceof URL
              ? url.href
              : url.url;
        expect(urlStr).toBe(
          "http://example.test/connections/itm_conn_1/uninstall",
        );
        expect(init?.method).toBe("POST");
        // No request body — the route reads only the path param.
        expect(init?.body).toBeUndefined();
        return Promise.resolve(makeJsonResponse(200, fakeResult));
      },
    );

    const client = makeClient(mockFetch as unknown as typeof globalThis.fetch);
    const result = await client.connections.uninstall("itm_conn_1");

    expect(result).toEqual(fakeResult);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("propagates server-side error responses through the typed-error mapping", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeJsonResponse(404, {
        error: { code: "not_found", message: "Connection not found" },
      }),
    );
    const client = makeClient(mockFetch as unknown as typeof globalThis.fetch);

    await expect(
      client.connections.uninstall("itm_missing"),
    ).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
  });

  it("propagates 400 already_revoked with the uninstall_error_code on err.details", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeJsonResponse(400, {
        error: {
          code: "validation_error",
          message: "Connection itm_x is already revoked",
          details: { uninstall_error_code: "already_revoked" },
        },
      }),
    );
    const client = makeClient(mockFetch as unknown as typeof globalThis.fetch);

    await expect(client.connections.uninstall("itm_x")).rejects.toMatchObject({
      code: "validation_error",
      status: 400,
      details: { uninstall_error_code: "already_revoked" },
    });
  });
});

describe("client.connections.previewEvent", () => {
  it("issues POST /connections/preview-event with the typed body and returns the typed result", async () => {
    const fakeResult = {
      envelopes: [
        {
          connection_id: "itm_conn_1",
          integration_name: "acme.slack",
          would_dispatch: true,
          dispatch_reason: "ok",
          envelope: {
            kind: "item-event",
            integration_name: "acme.slack",
            connection_id: "itm_conn_1",
            event_type: "item.created",
            item_id: "itm_note_1",
            cycle: { originating_connection_id: null, hop_count: 0 },
            payload: {},
          },
        },
      ],
      hop_budget: { max: 5, used: 0 },
    };

    const mockFetch = vi.fn(
      (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const urlStr =
          typeof url === "string"
            ? url
            : url instanceof URL
              ? url.href
              : url.url;
        expect(urlStr).toBe("http://example.test/connections/preview-event");
        expect(init?.method).toBe("POST");
        const body = JSON.parse(init?.body as string) as Record<
          string,
          unknown
        >;
        expect(body).toEqual({
          item_id: "itm_note_1",
          event_type: "created",
          connection_id: "itm_conn_1",
        });
        return Promise.resolve(makeJsonResponse(200, fakeResult));
      },
    );

    const client = makeClient(mockFetch as unknown as typeof globalThis.fetch);
    const result = await client.connections.previewEvent({
      item_id: "itm_note_1",
      event_type: "created",
      connection_id: "itm_conn_1",
    });

    expect(result).toEqual(fakeResult);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("forwards an optional cycle override unchanged", async () => {
    const mockFetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const body = JSON.parse(init?.body as string) as Record<
          string,
          unknown
        >;
        expect(body).toEqual({
          item_id: "itm_note_2",
          event_type: "updated",
          cycle: { originating_connection_id: "itm_conn_2", hop_count: 4 },
        });
        return Promise.resolve(
          makeJsonResponse(200, {
            envelopes: [],
            hop_budget: { max: 5, used: 4 },
          }),
        );
      },
    );

    const client = makeClient(mockFetch as unknown as typeof globalThis.fetch);
    await client.connections.previewEvent({
      item_id: "itm_note_2",
      event_type: "updated",
      cycle: { originating_connection_id: "itm_conn_2", hop_count: 4 },
    });
  });

  it("propagates 404 errors through the typed-error mapping", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeJsonResponse(404, {
        error: { code: "not_found", message: "Item not found" },
      }),
    );
    const client = makeClient(mockFetch as unknown as typeof globalThis.fetch);

    await expect(
      client.connections.previewEvent({
        item_id: "itm_missing",
        event_type: "created",
      }),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
  });
});
