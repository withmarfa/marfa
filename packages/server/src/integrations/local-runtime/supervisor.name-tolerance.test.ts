/**
 * Dispatch resolves an integration by either of its spellings.
 *
 * The failure this guards is silent by construction. A dispatch's
 * `integration_name` is read from the manifest FROZEN on the connection's
 * catalog row, while the registration is keyed on the name the running build
 * shipped. Those move in separate steps during the identifier rename, and a
 * by-name miss is not an error — the supervisor acks and skips an unknown
 * integration, exactly as it does for one that is genuinely not installed. So
 * a connection would simply stop dispatching, with nothing logged, no
 * activity row, and a `runtime_status` still reading healthy.
 *
 * No database: `getRegistration` is a map read, so the storage argument is
 * never touched.
 */
import { describe, expect, it } from "vitest";
import { createSupervisor } from "./supervisor.js";
import type { LocalIntegrationRegistration } from "./types.js";
import type { Storage } from "../../storage/interface.js";

function supervisorWith(name: string) {
  const registration = {
    name,
    entryPath: "/dev/null",
    manifest: { name },
  } as unknown as LocalIntegrationRegistration;
  return {
    registration,
    runtime: createSupervisor({} as unknown as Storage, {
      apiUrl: "http://test.local",
      apiKeySalt: "test-salt",
      authMode: "keys" as const,
      registrations: [registration],
      executor: {
        dispatch: () => Promise.reject(new Error("not dispatched here")),
        terminate: () => Promise.resolve(),
      },
      boss: null,
    }),
  };
}

describe("dispatch tolerates both spellings of an integration name", () => {
  it("resolves a build shipping the new name from a catalog row holding the old one", () => {
    const { registration, runtime } = supervisorWith("marfa/podcasts");
    expect(runtime.getRegistration("marfa/podcasts")).toBe(registration);
    expect(runtime.getRegistration("withmarfa.podcasts")).toBe(registration);
  });

  it("resolves the other way round, for the window where the catalog moves first", () => {
    const { registration, runtime } = supervisorWith("withmarfa.podcasts");
    expect(runtime.getRegistration("withmarfa.podcasts")).toBe(registration);
    expect(runtime.getRegistration("marfa/podcasts")).toBe(registration);
  });

  it("covers a publisher that keeps its handle across the rename", () => {
    const { registration, runtime } = supervisorWith("readwise/reader");
    expect(runtime.getRegistration("readwise.reader")).toBe(registration);
  });

  it("answers for an unknown name only under that name", () => {
    // A third-party integration is not in the table and gains no aliases.
    const { registration, runtime } = supervisorWith("acme/widgets");
    expect(runtime.getRegistration("acme/widgets")).toBe(registration);
    expect(runtime.getRegistration("acme.widgets")).toBeUndefined();
  });

  it("does not resolve an integration nobody registered", () => {
    const { runtime } = supervisorWith("marfa/podcasts");
    expect(runtime.getRegistration("marfa/rss-watcher")).toBeUndefined();
    expect(runtime.getRegistration("withmarfa.rss-watcher")).toBeUndefined();
  });
});
