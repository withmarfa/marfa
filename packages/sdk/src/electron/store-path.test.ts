import { describe, expect, it } from "vitest";
import { SINGLE_ACCOUNT, SINGLE_SPACE } from "../local/types.js";
import type { StoreIdentity } from "../local/types.js";
import { localStoreDirectory, localStorePath } from "./store-path.js";

const userData = "/Users/someone/Library/Application Support/Notes";

function identity(overrides: Partial<StoreIdentity> = {}): StoreIdentity {
  return {
    origin: "https://api.marfa.so",
    spaceId: "spc_alpha",
    accountId: "acc_one",
    ...overrides,
  };
}

describe("where an Electron app keeps a store", () => {
  it("puts it under the userData directory it was given", () => {
    expect(localStorePath({ userData, identity: identity() })).toMatch(
      new RegExp(`^${userData}/`),
    );
  });

  it("gives the store a directory of its own", () => {
    // The engine writes more than one file per store: the SQLite database,
    // its WAL and shared-memory siblings, the writer lockfile, and a
    // recovery sidecar when a store has to be set aside. A directory keeps
    // the set together, so removing one store cannot take part of another
    // with it.
    const directory = localStoreDirectory({ userData, identity: identity() });
    expect(localStorePath({ userData, identity: identity() })).toBe(
      `${directory}/store.db`,
    );
  });

  it("answers the same for the same identity", () => {
    expect(localStorePath({ userData, identity: identity() })).toBe(
      localStorePath({ userData, identity: identity() }),
    );
  });

  it("gives a second account on one machine its own store", () => {
    // The whole reason the path is keyed on all three. Sharing a directory
    // between two accounts would open one account's store as the other and
    // meet the engine's identity refusal, which reads to a user as the app
    // being broken rather than as two accounts needing two stores.
    expect(
      localStorePath({
        userData,
        identity: identity({ accountId: "acc_one" }),
      }),
    ).not.toBe(
      localStorePath({
        userData,
        identity: identity({ accountId: "acc_two" }),
      }),
    );
  });

  it("separates two spaces, and two servers", () => {
    const paths = new Set([
      localStorePath({ userData, identity: identity() }),
      localStorePath({ userData, identity: identity({ spaceId: "spc_beta" }) }),
      localStorePath({
        userData,
        identity: identity({ origin: "https://staging.marfa.so" }),
      }),
    ]);
    expect(paths.size).toBe(3);
  });

  it("does not let one field's tail read as the next field's head", () => {
    // Concatenating the three and hashing that would map these two onto one
    // directory, and the collision is silent: both accounts open, one
    // overwrites the other's rows. The separator is what stops it, and
    // nothing else in the path would notice if it were dropped.
    const left = identity({
      origin: "https://a.example",
      spaceId: "bc",
      accountId: "d",
    });
    const right = identity({
      origin: "https://a.example",
      spaceId: "b",
      accountId: "cd",
    });
    expect(localStorePath({ userData, identity: left })).not.toBe(
      localStorePath({ userData, identity: right }),
    );
  });

  it("names a store for the server it belongs to", () => {
    // Readability only. Someone opening the application-support folder to
    // clear a store has to be able to tell which one is which, and a
    // directory of digests tells them nothing.
    expect(
      localStoreDirectory({
        userData,
        identity: identity({ origin: "https://staging.marfa.so" }),
      }),
    ).toContain("staging-marfa-so");
  });

  it("handles the sentinels a single-space server gives", () => {
    const path = localStorePath({
      userData,
      identity: {
        origin: "http://localhost:8600",
        spaceId: SINGLE_SPACE,
        accountId: SINGLE_ACCOUNT,
      },
    });
    expect(path).toMatch(/^\//);
    expect(path.endsWith("/store.db")).toBe(true);
  });

  it("keeps every store under one parent, so an app can find them all", () => {
    const first = localStoreDirectory({ userData, identity: identity() });
    const second = localStoreDirectory({
      userData,
      identity: identity({ accountId: "acc_two" }),
    });
    expect(first.slice(0, first.lastIndexOf("/"))).toBe(
      second.slice(0, second.lastIndexOf("/")),
    );
  });
});
