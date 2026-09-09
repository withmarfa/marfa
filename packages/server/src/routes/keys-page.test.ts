/**
 * The keys page groups a key under the app that made it.
 *
 * A key minted through a sign-in records which app minted it, and the two
 * kinds are not the same thing to the person reading the page: one is theirs
 * and lives until they revoke it, the other arrived with an app they connected
 * and goes when they disconnect it. Rendering them in one undifferentiated
 * list tells a person they made a credential they did not make.
 *
 * Renderer-only, so these are cheap and exact. The route half — resolving the
 * client id to a display name — is covered where the route is.
 */
import { describe, it, expect } from "vitest";
import { renderKeysPage, type KeysPageKey } from "./keys-page.js";

const own = (id: string, label: string): KeysPageKey => ({
  id,
  label,
  created_at: "2026-05-10T10:00:00.000Z",
  last_used_at: null,
});

const made = (
  id: string,
  label: string,
  app: string,
  appId = app,
): KeysPageKey => ({
  ...own(id, label),
  app_id: appId,
  app_name: app,
});

describe("renderKeysPage grouping", () => {
  it("heads each app's keys with the app's name", () => {
    const html = renderKeysPage({
      email: "person@example.com",
      keys: [own("k1", "Laptop"), made("k2", "Notes key", "Notes")],
    });
    expect(html).toContain("Your keys");
    expect(html).toContain("Made by Notes");
    // Both keys are still listed — grouping is not filtering.
    expect(html).toContain("Laptop");
    expect(html).toContain("Notes key");
  });

  it("puts the person's own keys first", () => {
    const html = renderKeysPage({
      email: "person@example.com",
      keys: [made("k2", "App key", "Notes"), own("k1", "Laptop")],
    });
    expect(html.indexOf("Laptop")).toBeLessThan(html.indexOf("App key"));
  });

  it("orders the app groups by name rather than by row order", () => {
    // Otherwise the page reshuffles between loads on nothing more than the
    // order the store happened to return rows in.
    const html = renderKeysPage({
      email: "person@example.com",
      keys: [made("k1", "Z key", "Zebra"), made("k2", "A key", "Alpaca")],
    });
    expect(html.indexOf("Made by Alpaca")).toBeLessThan(
      html.indexOf("Made by Zebra"),
    );
  });

  it("keeps every key of an app under one heading", () => {
    const html = renderKeysPage({
      email: "person@example.com",
      keys: [
        made("k1", "First", "Notes"),
        own("k2", "Laptop"),
        made("k3", "Second", "Notes"),
      ],
    });
    expect(html.split("Made by Notes")).toHaveLength(2);
    expect(html).toContain("First");
    expect(html).toContain("Second");
  });

  it("shows no heading at all when no app has made a key", () => {
    // The page a person with no connected apps sees is the page they saw
    // before, with no section label inviting them to wonder what the other
    // section is.
    const html = renderKeysPage({
      email: "person@example.com",
      keys: [own("k1", "Laptop")],
    });
    expect(html).not.toContain("Your keys");
    expect(html).not.toContain("Made by");
    expect(html).toContain("Laptop");
  });

  it("still says the list is empty when there are no keys of any kind", () => {
    const html = renderKeysPage({ email: "person@example.com", keys: [] });
    expect(html).toContain("You have no API keys yet");
  });

  it("renders an app group with no keys of the person's own", () => {
    // Reachable: a person who has only ever connected an app. The empty-list
    // hint must not appear beside a group that has rows in it.
    const html = renderKeysPage({
      email: "person@example.com",
      keys: [made("k1", "App key", "Notes")],
    });
    expect(html).not.toContain("You have no API keys yet");
    expect(html).toContain("Made by Notes");
    expect(html).toContain("App key");
  });

  it("keeps two apps sharing a display name apart", () => {
    // Registration is open and `client_name` is caller-chosen, so grouping on
    // the name would file a second app's key under the first app's heading.
    const html = renderKeysPage({
      email: "person@example.com",
      keys: [
        made("k1", "First", "Notes", "client-a"),
        made("k2", "Second", "Notes", "client-b"),
      ],
    });
    expect(html.split("Made by Notes")).toHaveLength(3);
  });

  it("heads a group with the client id when no name resolved", () => {
    const html = renderKeysPage({
      email: "person@example.com",
      keys: [{ ...own("k1", "App key"), app_id: "client-unregistered" }],
    });
    expect(html).toContain("Made by client-unregistered");
  });

  it("escapes an app name, which is a string the app chose", () => {
    const html = renderKeysPage({
      email: "person@example.com",
      keys: [made("k1", "App key", '<img src=x onerror="alert(1)">')],
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });
});
