import { request } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * Whom the server believes a caller to be (the instance chapter's
 * `instance/proxy-*` rules).
 *
 * **How the address is seen.** The audit log records the caller's address
 * for every write, so a write sent with chosen headers and read back from
 * `/audit` shows the address the server took. The harness reaches the server
 * from `127.0.0.1`, so a range of `127.0.0.0/8` makes the harness a trusted
 * proxy and a range elsewhere leaves it a stranger.
 *
 * **On servers of the fixture's own.** The trust is fixed when the server
 * starts.
 */

afterAll(stopFreshServers, 2 * FRESH_SERVER_TIMEOUT_MS);

const PEER = "127.0.0.1";

type Headers = Record<string, string | string[]>;

/** A write with the headers given, as the audit log recorded its caller. */
async function seenAs(
  server: FreshServer,
  headers: Headers,
  name: string,
): Promise<string | null> {
  const url = new URL(server.apiUrl);
  const body = JSON.stringify({
    type: "core.note",
    properties: { body: name },
  });
  const created = await new Promise<{ status: number; body: string }>(
    (resolve, reject) => {
      const sent = request(
        {
          host: url.hostname,
          port: url.port,
          path: "/items",
          method: "POST",
          headers: {
            ...headers,
            Authorization: `Bearer ${server.workingKey}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (answer) => {
          const chunks: Buffer[] = [];
          answer.on("data", (chunk: Buffer) => chunks.push(chunk));
          answer.on("end", () =>
            resolve({
              status: answer.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      sent.on("error", reject);
      sent.end(body);
    },
  );
  expect(created.status, created.body).toBe(201);
  const id = (JSON.parse(created.body) as { item: { id: string } }).item.id;
  const audit = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.managementKey,
  });
  const page = await audit.listAudit({
    action: "item.create",
    resource_id: id,
  });
  expect(page.status, JSON.stringify(page.error)).toBe(200);
  expect(page.data.data).toHaveLength(1);
  return page.data.data[0]?.client_ip ?? null;
}

describe("the forwarded chain", () => {
  async function forwarding(): Promise<FreshServer> {
    return bootFreshServer("proxy-forwarded", {
      MARFA_TRUSTED_PROXY_CIDRS: "127.0.0.0/8",
    });
  }

  it("is read from the right, skipping the proxies, so that an address the caller wrote further left is never taken", async () => {
    const server = await forwarding();
    // The witness: no chain at all is the peer's own address.
    expect(await seenAs(server, {}, "no-chain")).toBe(PEER);
    // The caller forged the left entry; the right one is a proxy of ours.
    expect(
      await seenAs(
        server,
        { "X-Forwarded-For": "198.51.100.7, 203.0.113.5, 127.0.0.2" },
        "forged",
      ),
    ).toBe("203.0.113.5");
    // Two proxies in a row are both skipped, and a chain split over two
    // header lines reads as one.
    expect(
      await seenAs(
        server,
        { "X-Forwarded-For": ["198.51.100.7, 203.0.113.5", "127.0.0.9"] },
        "two-lines",
      ),
    ).toBe("203.0.113.5");
    // Every entry is a proxy of ours: the leftmost is the caller.
    expect(
      await seenAs(
        server,
        { "X-Forwarded-For": "127.0.0.3, 127.0.0.2" },
        "all-ours",
      ),
    ).toBe("127.0.0.3");
  });

  it("stops at an entry that is not an address and takes the last proxy address it read", async () => {
    const server = await forwarding();
    expect(
      await seenAs(
        server,
        { "X-Forwarded-For": "203.0.113.5, not-an-address, 127.0.0.2" },
        "malformed",
      ),
    ).toBe("127.0.0.2");
    // The witness: the same chain without the bad entry reaches the stranger.
    expect(
      await seenAs(
        server,
        { "X-Forwarded-For": "203.0.113.5, 127.0.0.2" },
        "well-formed",
      ),
    ).toBe("203.0.113.5");
  });

  it("reads at most 32 entries, however long the chain", async () => {
    const server = await forwarding();
    const proxies = Array.from({ length: 32 }, (_, n) => `127.0.0.${n + 1}`);
    // Thirty-two proxies of ours, and a stranger beyond the 32nd entry.
    expect(
      await seenAs(
        server,
        { "X-Forwarded-For": ["203.0.113.9", ...proxies].join(", ") },
        "past-the-limit",
      ),
    ).toBe("127.0.0.1");
    // The witness: with one entry fewer, the stranger is within the limit.
    expect(
      await seenAs(
        server,
        { "X-Forwarded-For": ["203.0.113.9", ...proxies.slice(1)].join(", ") },
        "at-the-limit",
      ),
    ).toBe("203.0.113.9");
  });

  it("treats an IPv4-mapped IPv6 address as the IPv4 address it maps, in the ranges and in the chain", async () => {
    const server = await forwarding();
    // A mapped proxy address is inside 127.0.0.0/8, so it is skipped.
    expect(
      await seenAs(
        server,
        { "X-Forwarded-For": "203.0.113.5, ::ffff:127.0.0.9" },
        "mapped-proxy",
      ),
    ).toBe("203.0.113.5");
    // A mapped caller address is recorded as the IPv4 address.
    expect(
      await seenAs(
        server,
        { "X-Forwarded-For": "::ffff:203.0.113.6" },
        "mapped-caller",
      ),
    ).toBe("203.0.113.6");
  });

  it("is ignored from a peer outside the ranges", async () => {
    const server = await bootFreshServer("proxy-forwarded-stranger", {
      MARFA_TRUSTED_PROXY_CIDRS: "192.0.2.0/24",
    });
    expect(
      await seenAs(server, { "X-Forwarded-For": "203.0.113.5" }, "stranger"),
    ).toBe(PEER);
  });
});

describe("the edge's header", () => {
  const HEADER = "X-Edge-Client";

  it("is read whatever the peer is while no range is set, and only when it holds one address", async () => {
    const server = await bootFreshServer("proxy-header-alone", {
      MARFA_TRUSTED_PROXY_HEADER: HEADER,
    });
    expect(await seenAs(server, { [HEADER]: "203.0.113.5" }, "single")).toBe(
      "203.0.113.5",
    );
    expect(await seenAs(server, { [HEADER]: "2001:db8::7" }, "single-v6")).toBe(
      "2001:db8::7",
    );
    expect(
      await seenAs(server, { [HEADER]: "::ffff:203.0.113.6" }, "mapped"),
    ).toBe("203.0.113.6");
    // Anything but one address did not come from the edge.
    for (const [name, sent] of [
      ["list", "203.0.113.5, 203.0.113.6"],
      ["twice", ["203.0.113.5", "203.0.113.6"]],
      ["text", "not-an-address"],
      ["empty", ""],
    ] as [string, string | string[]][]) {
      expect(await seenAs(server, { [HEADER]: sent }, name), name).toBe(PEER);
    }
    // The witness: with no header, the peer stands for the caller.
    expect(await seenAs(server, {}, "absent")).toBe(PEER);
  });

  it("is read only from a peer inside the ranges when ranges are set", async () => {
    const inside = await bootFreshServer("proxy-header-inside", {
      MARFA_TRUSTED_PROXY_HEADER: HEADER,
      MARFA_TRUSTED_PROXY_CIDRS: "127.0.0.0/8",
    });
    expect(await seenAs(inside, { [HEADER]: "203.0.113.5" }, "inside")).toBe(
      "203.0.113.5",
    );
    const outside = await bootFreshServer("proxy-header-outside", {
      MARFA_TRUSTED_PROXY_HEADER: HEADER,
      MARFA_TRUSTED_PROXY_CIDRS: "192.0.2.0/24",
    });
    expect(await seenAs(outside, { [HEADER]: "203.0.113.5" }, "outside")).toBe(
      PEER,
    );
  });
});
