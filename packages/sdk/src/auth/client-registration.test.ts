import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { OAuthError } from "./errors.js";
import {
  CLIENT_REGISTRATION_EPOCH,
  DEVICE_CODE_GRANT,
  InMemoryClientRegistrationStore,
  isDeadClientError,
  isStaleCeilingError,
  oauthErrorFrom,
  registerClient,
  registrationIsStale,
  repairCanHelp,
  resolveClient,
  uncoveredScopes,
  withClientRepair,
  type ClientManifest,
  type StoredClientRegistration,
} from "./client-registration.js";

const ISSUER = "https://marfa.example";
const ENDPOINT = "https://marfa.example/auth/oauth2/register";

const MANIFEST: ClientManifest = {
  clientName: "Marfa for Tests",
  grantTypes: [DEVICE_CODE_GRANT, "refresh_token"],
};

function stored(
  over: Partial<StoredClientRegistration> = {},
): StoredClientRegistration {
  return {
    clientId: "client-stored",
    issuer: ISSUER,
    claimedScope: "openid offline_access items.read",
    epoch: CLIENT_REGISTRATION_EPOCH,
    ...over,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function mockFetch(): Mock<typeof globalThis.fetch> {
  return vi.fn<typeof globalThis.fetch>();
}

/** The JSON body of a mocked fetch's first call. */
function sentBody(
  fetchImpl: Mock<typeof globalThis.fetch>,
): Record<string, unknown> {
  const call = fetchImpl.mock.calls[0];
  if (!call) throw new Error("fetch was never called");
  return JSON.parse((call[1] as { body: string }).body) as Record<
    string,
    unknown
  >;
}

/** The client id a mocked runner was handed on its nth call. */
function clientIdOf(run: Mock, n: number): string {
  const call = run.mock.calls[n];
  if (!call) throw new Error(`no call ${String(n)}`);
  return (call[0] as { clientId: string }).clientId;
}

describe("uncoveredScopes", () => {
  it("names the scopes a claim does not hold", () => {
    expect(
      uncoveredScopes("openid items.read", ["openid", "items.write"]),
    ).toEqual(["items.write"]);
  });

  it("treats a wildcard as covering nothing beneath it", () => {
    // The server's own check is plain set membership, so a claim of `items.*`
    // does not admit `items.read`. Matching that exactly is the point: a
    // looser rule here would call a registration sufficient that the surface
    // deciding will refuse.
    expect(uncoveredScopes("items.*", ["items.read"])).toEqual(["items.read"]);
  });

  it("ignores the shape of the separator", () => {
    expect(uncoveredScopes("  openid   items.read ", ["items.read"])).toEqual(
      [],
    );
  });
});

describe("registrationIsStale", () => {
  const base = { scopes: ["openid"], scopesAreAuthoritative: true };

  it("is stale with nothing stored", () => {
    expect(registrationIsStale({ ...base, stored: null })).toBe(true);
  });

  it("is stale for a record written under an older epoch", () => {
    // The case no scope comparison can see: the record is well-formed and its
    // claim covers, but the server lost the row it names.
    expect(registrationIsStale({ ...base, stored: stored({ epoch: 0 }) })).toBe(
      true,
    );
  });

  it("is stale when no claim was recorded", () => {
    expect(
      registrationIsStale({ ...base, stored: stored({ claimedScope: "" }) }),
    ).toBe(true);
  });

  it("reuses a current record whose claim covers", () => {
    expect(
      registrationIsStale({ ...base, scopes: ["openid"], stored: stored() }),
    ).toBe(false);
  });

  it("re-registers for an uncovered space permission", () => {
    // The one family the server's ceiling catch-up refuses to repair, because
    // admitting it would let an unauthenticated request write an
    // administrative permission into a stored registration.
    expect(
      registrationIsStale({
        ...base,
        scopes: ["space.keys"],
        stored: stored(),
      }),
    ).toBe(true);
  });

  it("reuses when the only gap is one the next authorize closes itself", () => {
    expect(
      registrationIsStale({
        ...base,
        scopes: ["items.write"],
        stored: stored(),
      }),
    ).toBe(false);
  });

  it("reuses a stored record when the scope set is not the server's", () => {
    // A scope set the client invented is evidence about nothing. Deciding from
    // one re-registers on every sign-in a flapping discovery endpoint produces,
    // abandoning the client the previous pass minted.
    expect(
      registrationIsStale({
        stored: stored(),
        scopes: ["space.keys"],
        scopesAreAuthoritative: false,
      }),
    ).toBe(false);
  });

  it("still registers with nothing stored even on an invented scope set", () => {
    expect(
      registrationIsStale({
        stored: null,
        scopes: ["space.keys"],
        scopesAreAuthoritative: false,
      }),
    ).toBe(true);
  });
});

describe("repairCanHelp", () => {
  it("can replace a stored id", () => {
    expect(repairCanHelp("stored")).toBe(true);
  });

  it("will not touch an operator-pinned id", () => {
    expect(repairCanHelp("pinned")).toBe(false);
  });

  it("will not re-register one minted moments ago", () => {
    expect(repairCanHelp("registered")).toBe(false);
  });
});

describe("classifying a refusal", () => {
  it("recognizes a dead client", () => {
    expect(isDeadClientError(new OAuthError("invalid_client", "gone"))).toBe(
      true,
    );
    expect(isDeadClientError(new OAuthError("invalid_grant", "no"))).toBe(
      false,
    );
  });

  it("recognizes one thrown by a different copy of the class", () => {
    // **The test the whole repair rests on.** Two copies of the SDK in a tree,
    // a bundler emitting the class twice, or a suite substituting its own all
    // break `instanceof` while leaving the value correct — and an `instanceof`
    // check would then leave a repair that silently never fires.
    class ForeignOAuthError extends Error {
      code = "invalid_client";
      constructor() {
        super("gone");
        this.name = "OAuthError";
      }
    }
    expect(isDeadClientError(new ForeignOAuthError())).toBe(true);
  });

  it("says no to things that are not errors at all", () => {
    expect(isDeadClientError(null)).toBe(false);
    expect(isDeadClientError("invalid_client")).toBe(false);
    expect(isDeadClientError({ code: "invalid_client" })).toBe(false);
  });

  it("separates a stale ceiling from a dead client", () => {
    const ceiling = new OAuthError("invalid_scope", "too much");
    expect(isStaleCeilingError(ceiling)).toBe(true);
    expect(isDeadClientError(ceiling)).toBe(false);
  });
});

describe("oauthErrorFrom", () => {
  it("reads the flat RFC 6749 shape", () => {
    const err = oauthErrorFrom(400, {
      error: "invalid_client",
      error_description: "no such client",
    });
    expect(err.code).toBe("invalid_client");
    expect(err.message).toBe("no such client");
    expect(err.status).toBe(400);
  });

  it("reads the structured shape the device routes return", () => {
    // The SDK had two readers that disagreed about exactly this, so the code a
    // caller saw depended on which surface refused it.
    const err = oauthErrorFrom(400, { error: { code: "invalid_client" } });
    expect(err.code).toBe("invalid_client");
  });

  it("falls back to a server error rather than inventing a code", () => {
    expect(oauthErrorFrom(503, {}).code).toBe("server_error");
    expect(oauthErrorFrom(503, "not json at all").code).toBe("server_error");
  });
});

describe("registerClient", () => {
  it("claims the scope ceiling on the wire", async () => {
    const fetchImpl = mockFetch();
    fetchImpl.mockResolvedValue(jsonResponse(201, { client_id: "fresh" }));
    const record = await registerClient({
      issuer: ISSUER,
      manifest: MANIFEST,
      scopes: ["openid", "space.keys"],
      registrationEndpoint: ENDPOINT,
      fetch: fetchImpl,
    });

    expect(record.clientId).toBe("fresh");
    expect(record.epoch).toBe(CLIENT_REGISTRATION_EPOCH);
    const body = sentBody(fetchImpl);
    expect(body.scope).toBe("openid space.keys");
    expect(body.token_endpoint_auth_method).toBe("none");
    // A device-only client sends no redirect URIs; the server requires them
    // only for the authorization-code grant.
    expect(body.redirect_uris).toBeUndefined();
  });

  it("sends redirect URIs for an authorization-code client", async () => {
    const fetchImpl = mockFetch();
    fetchImpl.mockResolvedValue(jsonResponse(201, { client_id: "fresh" }));
    await registerClient({
      issuer: ISSUER,
      manifest: {
        clientName: "Marfa for Raycast",
        grantTypes: ["authorization_code", "refresh_token"],
        redirectUris: ["raycast://redirect"],
      },
      scopes: ["openid"],
      registrationEndpoint: ENDPOINT,
      fetch: fetchImpl,
    });
    const body = sentBody(fetchImpl);
    expect(body.redirect_uris).toEqual(["raycast://redirect"]);
    expect(body.response_types).toEqual(["code"]);
  });

  it("surfaces a refused manifest as its own code", async () => {
    // Distinct from a dead client on purpose: nothing was minted, so a caller
    // holding a working registration must keep it.
    const fetchImpl = mockFetch();
    fetchImpl.mockResolvedValue(
      jsonResponse(400, { error: "invalid_client_metadata" }),
    );
    await expect(
      registerClient({
        issuer: ISSUER,
        manifest: MANIFEST,
        scopes: ["openid"],
        registrationEndpoint: ENDPOINT,
        fetch: fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "invalid_client_metadata" });
  });

  it("refuses a response that carries no client_id", async () => {
    const fetchImpl = mockFetch();
    fetchImpl.mockResolvedValue(jsonResponse(201, {}));
    await expect(
      registerClient({
        issuer: ISSUER,
        manifest: MANIFEST,
        scopes: ["openid"],
        registrationEndpoint: ENDPOINT,
        fetch: fetchImpl,
      }),
    ).rejects.toThrow(/no client_id/);
  });

  it("turns a transport failure into an OAuthError", async () => {
    const fetchImpl = mockFetch();
    fetchImpl.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(
      registerClient({
        issuer: ISSUER,
        manifest: MANIFEST,
        scopes: ["openid"],
        registrationEndpoint: ENDPOINT,
        fetch: fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "server_error" });
  });
});

describe("resolveClient", () => {
  let store: InMemoryClientRegistrationStore;
  let fetchImpl: Mock<typeof globalThis.fetch>;

  beforeEach(() => {
    store = new InMemoryClientRegistrationStore();
    fetchImpl = mockFetch();
    fetchImpl.mockResolvedValue(jsonResponse(201, { client_id: "fresh" }));
  });

  const opts = () => ({
    issuer: ISSUER,
    manifest: MANIFEST,
    scopes: ["openid"],
    registrationEndpoint: ENDPOINT,
    scopesAreAuthoritative: true,
    store,
    fetch: fetchImpl,
  });

  it("returns a pinned id untouched and stores nothing", async () => {
    const resolved = await resolveClient({
      ...opts(),
      pinnedClientId: "operator-set",
    });
    expect(resolved).toMatchObject({
      clientId: "operator-set",
      origin: "pinned",
    });
    expect(await store.read(ISSUER)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reuses a current stored record without registering", async () => {
    await store.write(stored());
    const resolved = await resolveClient(opts());
    expect(resolved).toMatchObject({
      clientId: "client-stored",
      origin: "stored",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("registers and persists when the record is pre-epoch", async () => {
    await store.write(stored({ epoch: 0 }));
    const resolved = await resolveClient(opts());
    expect(resolved).toMatchObject({ clientId: "fresh", origin: "registered" });
    expect(await store.read(ISSUER)).toMatchObject({
      clientId: "fresh",
      epoch: CLIENT_REGISTRATION_EPOCH,
    });
  });

  it("leaves a working record alone when registration fails", async () => {
    // A narrow live client beats no client. Nothing is written until the
    // server has answered.
    await store.write(stored({ epoch: 0 }));
    fetchImpl.mockResolvedValue(
      jsonResponse(400, { error: "invalid_client_metadata" }),
    );
    await expect(resolveClient(opts())).rejects.toMatchObject({
      code: "invalid_client_metadata",
    });
    expect(await store.read(ISSUER)).toMatchObject({
      clientId: "client-stored",
    });
  });
});

describe("withClientRepair", () => {
  let store: InMemoryClientRegistrationStore;
  let fetchImpl: Mock<typeof globalThis.fetch>;

  beforeEach(async () => {
    store = new InMemoryClientRegistrationStore();
    await store.write(stored());
    let minted = 0;
    fetchImpl = mockFetch();
    fetchImpl.mockImplementation(() => {
      minted += 1;
      return Promise.resolve(
        jsonResponse(201, { client_id: `fresh-${String(minted)}` }),
      );
    });
  });

  const opts = () => ({
    issuer: ISSUER,
    manifest: MANIFEST,
    scopes: ["openid"],
    registrationEndpoint: ENDPOINT,
    scopesAreAuthoritative: true,
    store,
    fetch: fetchImpl,
  });

  it("re-registers once and succeeds on the retry", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new OAuthError("invalid_client", "gone"))
      .mockResolvedValueOnce("done");

    await expect(withClientRepair(opts(), run)).resolves.toBe("done");
    expect(run).toHaveBeenCalledTimes(2);
    expect(clientIdOf(run, 0)).toBe("client-stored");
    expect(clientIdOf(run, 1)).toBe("fresh-1");
  });

  it("mints exactly one client across a repair that fails again", async () => {
    // **The cap has to be structural, not caller discipline.** A loop here
    // abandons a client row per attempt and nothing the client can call
    // revokes one.
    const run = vi
      .fn()
      .mockRejectedValue(new OAuthError("invalid_client", "gone"));
    await expect(withClientRepair(opts(), run)).rejects.toMatchObject({
      code: "invalid_client",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("clears only the registration, never the session", async () => {
    const clear = vi.spyOn(store, "clear");
    const run = vi
      .fn()
      .mockRejectedValueOnce(new OAuthError("invalid_client", "gone"))
      .mockResolvedValueOnce("done");
    await withClientRepair(opts(), run);
    expect(clear).toHaveBeenCalledWith(ISSUER);
  });

  it("does not repair a pinned id", async () => {
    const run = vi
      .fn()
      .mockRejectedValue(new OAuthError("invalid_client", "gone"));
    await expect(
      withClientRepair({ ...opts(), pinnedClientId: "operator-set" }, run),
    ).rejects.toMatchObject({ code: "invalid_client" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("repairs a stale ceiling only when the caller opts in", async () => {
    // The device endpoint refuses on a frozen ceiling; the authorize endpoint
    // narrows silently, so an authorization-code caller has nothing to react to.
    const ceiling = () => new OAuthError("invalid_scope", "above the ceiling");

    const optIn = vi
      .fn()
      .mockRejectedValueOnce(ceiling())
      .mockResolvedValueOnce("ok");
    await expect(
      withClientRepair({ ...opts(), alsoRepairOn: ["invalid_scope"] }, optIn),
    ).resolves.toBe("ok");

    const optOut = vi.fn().mockRejectedValue(ceiling());
    await expect(withClientRepair(opts(), optOut)).rejects.toMatchObject({
      code: "invalid_scope",
    });
    expect(optOut).toHaveBeenCalledTimes(1);
  });

  it("passes an unrelated failure straight through", async () => {
    const run = vi
      .fn()
      .mockRejectedValue(new OAuthError("invalid_grant", "no"));
    await expect(withClientRepair(opts(), run)).rejects.toMatchObject({
      code: "invalid_grant",
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports why it repaired", async () => {
    const onRepair = vi.fn();
    const run = vi
      .fn()
      .mockRejectedValueOnce(new OAuthError("invalid_client", "gone"))
      .mockResolvedValueOnce("done");
    await withClientRepair({ ...opts(), onRepair }, run);
    expect(onRepair).toHaveBeenCalledWith("invalid_client");
  });
});
