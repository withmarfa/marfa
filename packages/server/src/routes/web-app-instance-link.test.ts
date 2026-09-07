/**
 * The sign-in page's link back to the web app's instance picker.
 *
 * Most of these are about the one thing that could go wrong badly rather than
 * merely not work: the only request-supplied value reaching the href is
 * `redirect_uri`, so every case where it is not exactly one the client
 * registered has to answer `undefined`. A "Use a different Marfa server" link
 * pointing at somebody else's site is worse than no link at all.
 */
import { describe, it, expect } from "vitest";
import { resolveWebAppInstanceLink } from "./web-app-instance-link.js";
import type { Storage } from "../storage/interface.js";

const APP = "https://app.marfa.so";
const INSTANCE = "https://staging.marfa.so";
const REGISTERED = `${APP}/auth/callback`;

/** A storage double answering for one client and nothing else. */
function storageWith(clientId: string, redirectUris: string[]): Storage {
  return {
    oauthProvider: {
      getClient: (id: string) =>
        Promise.resolve(
          id === clientId ? { clientId: id, redirectUris } : null,
        ),
    },
  } as unknown as Storage;
}

function authorizeReturnTo(params: Record<string, string>): string {
  return `/auth/authorize?${new URLSearchParams(params).toString()}`;
}

const webAppStorage = storageWith("marfa-web", [REGISTERED]);

describe("resolveWebAppInstanceLink", () => {
  it("sends the web app back to its own origin, naming this server", async () => {
    const link = await resolveWebAppInstanceLink(
      webAppStorage,
      authorizeReturnTo({ client_id: "marfa-web", redirect_uri: REGISTERED }),
      INSTANCE,
    );
    expect(link).toBe(`${APP}/?instance=${encodeURIComponent(INSTANCE)}`);
  });

  it("uses the origin the request came from rather than a hardcoded host", async () => {
    // The self-hosted case. Same client id, a different deployment of the
    // same app, and the link has to reach that one.
    const selfHosted = "https://marfa.example.internal";
    const link = await resolveWebAppInstanceLink(
      storageWith("marfa-web", [`${selfHosted}/auth/callback`]),
      authorizeReturnTo({
        client_id: "marfa-web",
        redirect_uri: `${selfHosted}/auth/callback`,
      }),
      INSTANCE,
    );
    expect(link).toBe(
      `${selfHosted}/?instance=${encodeURIComponent(INSTANCE)}`,
    );
  });

  it("refuses a redirect_uri the client never registered", async () => {
    // The open-redirect case, and the reason this function exists rather than
    // the page reading the query itself.
    const link = await resolveWebAppInstanceLink(
      webAppStorage,
      authorizeReturnTo({
        client_id: "marfa-web",
        redirect_uri: "https://attacker.example/auth/callback",
      }),
      INSTANCE,
    );
    expect(link).toBeUndefined();
  });

  it("refuses a redirect_uri that merely starts with a registered one", async () => {
    // Exact membership, not a prefix: `https://app.marfa.so.evil.example` and
    // `https://app.marfa.so/auth/callback/../..` both pass a looser check.
    const link = await resolveWebAppInstanceLink(
      webAppStorage,
      authorizeReturnTo({
        client_id: "marfa-web",
        redirect_uri: `${REGISTERED}.evil.example`,
      }),
      INSTANCE,
    );
    expect(link).toBeUndefined();
  });

  it("says nothing for another client", async () => {
    // `marfa-tickets` is first-party too and has no instance picker to reach.
    const link = await resolveWebAppInstanceLink(
      storageWith("marfa-tickets", ["https://tickets.marfa.so/auth/callback"]),
      authorizeReturnTo({
        client_id: "marfa-tickets",
        redirect_uri: "https://tickets.marfa.so/auth/callback",
      }),
      INSTANCE,
    );
    expect(link).toBeUndefined();
  });

  it("says nothing for a sign-in reached directly", async () => {
    const link = await resolveWebAppInstanceLink(webAppStorage, "/", INSTANCE);
    expect(link).toBeUndefined();
  });

  it("says nothing when the client is not registered at all", async () => {
    const link = await resolveWebAppInstanceLink(
      storageWith("someone-else", [REGISTERED]),
      authorizeReturnTo({ client_id: "marfa-web", redirect_uri: REGISTERED }),
      INSTANCE,
    );
    expect(link).toBeUndefined();
  });

  it("says nothing when the authorize query names no redirect", async () => {
    const link = await resolveWebAppInstanceLink(
      webAppStorage,
      authorizeReturnTo({ client_id: "marfa-web" }),
      INSTANCE,
    );
    expect(link).toBeUndefined();
  });

  it("says nothing when this deployment does not know its own base URL", async () => {
    const link = await resolveWebAppInstanceLink(
      webAppStorage,
      authorizeReturnTo({ client_id: "marfa-web", redirect_uri: REGISTERED }),
      undefined,
    );
    expect(link).toBeUndefined();
  });

  it("names the origin only, whatever path the base URL carries", async () => {
    const link = await resolveWebAppInstanceLink(
      webAppStorage,
      authorizeReturnTo({ client_id: "marfa-web", redirect_uri: REGISTERED }),
      `${INSTANCE}/auth`,
    );
    expect(link).toBe(`${APP}/?instance=${encodeURIComponent(INSTANCE)}`);
  });
});
