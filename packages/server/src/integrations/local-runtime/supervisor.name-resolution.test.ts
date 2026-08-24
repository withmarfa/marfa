/**
 * Dispatch resolves an integration by exact manifest name.
 *
 * Worth pinning because the failure on a miss is silent by construction. A
 * dispatch's `integration_name` is read from the manifest FROZEN on the
 * connection's catalog row, while the registration is keyed on the name the
 * running build shipped. A by-name miss is not an error — the supervisor acks
 * and skips an unknown integration, exactly as it does for one that is
 * genuinely not installed — so a connection whose stored name no longer
 * matches simply stops dispatching, with nothing logged, no activity row, and
 * a `runtime_status` still reading healthy.
 *
 * Any change that moves a manifest name therefore has to move the stored
 * names with it, in a step of its own.
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

describe("dispatch resolves an integration by exact name", () => {
  it("resolves the name the build registered", () => {
    const { registration, runtime } = supervisorWith("marfa/podcasts");
    expect(runtime.getRegistration("marfa/podcasts")).toBe(registration);
  });

  it("does not answer to the spelling the integration shipped under before", () => {
    const { runtime } = supervisorWith("marfa/podcasts");
    expect(runtime.getRegistration("withmarfa.podcasts")).toBeUndefined();
  });

  it("covers a publisher that kept its namespace through the rename", () => {
    const { registration, runtime } = supervisorWith("readwise/reader");
    expect(runtime.getRegistration("readwise/reader")).toBe(registration);
    expect(runtime.getRegistration("readwise.reader")).toBeUndefined();
  });

  it("answers for a third-party name under that name alone", () => {
    const { registration, runtime } = supervisorWith("acme/widgets");
    expect(runtime.getRegistration("acme/widgets")).toBe(registration);
    expect(runtime.getRegistration("acme.widgets")).toBeUndefined();
  });

  it("does not resolve an integration nobody registered", () => {
    const { runtime } = supervisorWith("marfa/podcasts");
    expect(runtime.getRegistration("marfa/rss-watcher")).toBeUndefined();
  });
});
