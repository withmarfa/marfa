import { describe, expect, it } from "vitest";
import {
  isSamePgEndpoint,
  pgEndpointHost,
  pgEndpointLabel,
} from "./endpoint.js";

/**
 * The startup log names the endpoint streaming RLS reserves from, and the only
 * thing that identifies it is the host. The rest of the connection string is
 * the password.
 */
describe("pgEndpointHost", () => {
  it("returns the host and nothing else", () => {
    expect(
      pgEndpointHost(
        "postgres://marfa:s3cret@ep-cool-1-pooler.example:6432/db",
      ),
    ).toBe("ep-cool-1-pooler.example");
  });

  it("never leaks the credentials in the string it returns", () => {
    const host = pgEndpointHost(
      "postgresql://marfa:hunter2@direct.example:5432/db?sslmode=require",
    );
    expect(host).not.toContain("hunter2");
    expect(host).not.toContain("marfa:");
  });

  it("degrades to a placeholder rather than throwing on an unparseable URL", () => {
    // A log line is never worth failing a boot over.
    expect(pgEndpointHost("not a url")).toBe("unknown");
    expect(pgEndpointHost("")).toBe("unknown");
  });
});

describe("pgEndpointLabel", () => {
  it("names host and port, and still never the credentials", () => {
    const label = pgEndpointLabel(
      "postgres://marfa:hunter2@pooler.example:6432/db",
    );
    expect(label).toBe("pooler.example:6432");
    expect(label).not.toContain("hunter2");
  });

  it("fills in the default port when the URL omits one", () => {
    expect(pgEndpointLabel("postgres://marfa@direct.example/db")).toBe(
      "direct.example:5432",
    );
  });

  it("degrades to a placeholder rather than throwing", () => {
    expect(pgEndpointLabel("not a url")).toBe("unknown");
  });
});

/**
 * What makes the direct endpoint actually direct. The failure this guards is
 * not "unset" but "set to the pooled endpoint again": the deploy tooling
 * resolves the two from adjacent variable names, and on Neon the hostnames
 * differ by the six characters of the `-pooler` suffix.
 */
describe("isSamePgEndpoint", () => {
  const POOLED =
    "postgres://marfa:pw@ep-cool-1-pooler.eu-west-2.example:5432/db";
  const DIRECT = "postgres://marfa:pw@ep-cool-1.eu-west-2.example:5432/db";

  it("separates a Neon pooled/direct pair", () => {
    expect(isSamePgEndpoint(POOLED, DIRECT)).toBe(false);
  });

  it("catches the same URL handed to both variables", () => {
    expect(isSamePgEndpoint(POOLED, POOLED)).toBe(true);
  });

  it("catches the same endpoint dressed up differently", () => {
    // Different credentials, database and query string; same listener. The
    // pooler does not care which of these you vary.
    expect(
      isSamePgEndpoint(
        POOLED,
        "postgresql://other:different@ep-cool-1-pooler.eu-west-2.example:5432/other?sslmode=require",
      ),
    ).toBe(true);
  });

  it("ignores host casing, which DNS does too", () => {
    expect(
      isSamePgEndpoint(
        POOLED,
        POOLED.replace("ep-cool-1-pooler", "EP-COOL-1-POOLER"),
      ),
    ).toBe(true);
  });

  it("treats an omitted port as the default one", () => {
    expect(
      isSamePgEndpoint(
        "postgres://marfa:pw@db.example/marfa",
        "postgres://marfa:pw@db.example:5432/marfa",
      ),
    ).toBe(true);
  });

  it("allows a pooler and a Postgres sharing a host on different ports", () => {
    // The standard self-hosted topology: PgBouncer beside Postgres on one
    // machine. A host-only comparison would reject this legitimate pair.
    expect(
      isSamePgEndpoint(
        "postgres://marfa:pw@localhost:6432/marfa",
        "postgres://marfa:pw@localhost:5432/marfa",
      ),
    ).toBe(false);
  });

  it("does not claim sameness it cannot establish", () => {
    // Two different unparseable strings are not evidence of anything; the
    // emptiness guard and the connection attempt itself deal with those.
    expect(isSamePgEndpoint("not a url", "also not a url")).toBe(false);
    expect(isSamePgEndpoint("", "")).toBe(false);
    expect(isSamePgEndpoint(POOLED, "")).toBe(false);
  });

  it("still catches an identical unparseable string", () => {
    expect(isSamePgEndpoint("host=db port=5432", "host=db port=5432")).toBe(
      true,
    );
  });
});
