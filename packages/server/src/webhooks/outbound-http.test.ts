import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import {
  DELIVERY_FAILURE,
  createWebhookHttpClient,
  isPublicAddress,
  refuseWebhookUrl,
} from "./outbound-http.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections();
          s.close(() => {
            resolve();
          });
        }),
    ),
  );
});

/** A receiver on loopback that answers with `respond`, counting hits. */
async function receiver(
  respond: (res: import("node:http").ServerResponse) => void = (res) => {
    res.writeHead(200);
    res.end("ok");
  },
): Promise<{ port: number; hits: () => number }> {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    req.resume();
    req.on("end", () => {
      respond(res);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      resolve();
    }),
  );
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("the receiver did not bind");
  }
  return { port: address.port, hits: () => hits };
}

const post = (url: string, timeoutMs = 5_000) => ({
  url,
  headers: { "Content-Type": "application/json" },
  body: "{}",
  timeoutMs,
});

describe("isPublicAddress", () => {
  it("takes global unicast addresses and refuses every special range", () => {
    for (const address of ["93.184.215.14", "8.8.8.8", "2606:4700::1"]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "255.255.255.255",
      "224.0.0.1",
      "192.0.2.1",
      "::1",
      "::",
      "fe80::1",
      "fd00::1",
      "fc00::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "64:ff9b::a00:1",
      "2002:a00:1::",
      "2001:db8::1",
      "not an address",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("judges an IPv4 address written as IPv6 as the IPv4 address it carries", () => {
    expect(isPublicAddress("::ffff:8.8.8.8")).toBe(true);
    expect(isPublicAddress("::ffff:192.168.0.1")).toBe(false);
  });
});

describe("refuseWebhookUrl", () => {
  it("takes http and https to a name or a public address", () => {
    for (const url of [
      "https://receiver.example/hook",
      "http://receiver.example:8080/hook?x=1",
      "https://93.184.215.14/hook",
      "https://[2606:4700::1]/hook",
    ]) {
      expect(refuseWebhookUrl(url, false), url).toBeNull();
    }
  });

  it("refuses another scheme, credentials in the URL and a non-public literal address", () => {
    for (const url of [
      "not a url",
      "ftp://receiver.example/hook",
      "javascript:alert(1)",
      "https://user:pass@receiver.example/hook",
      "http://127.0.0.1/hook",
      "http://[::ffff:127.0.0.1]/hook",
      "http://2130706433/hook",
      "http://0x7f.0.0.1/hook",
    ]) {
      expect(refuseWebhookUrl(url, false), url).not.toBeNull();
    }
  });

  it("takes a private literal address only where the operator allows one", () => {
    expect(refuseWebhookUrl("http://127.0.0.1/hook", true)).toBeNull();
    expect(refuseWebhookUrl("ftp://127.0.0.1/hook", true)).not.toBeNull();
  });
});

describe("the delivery client", () => {
  it("reaches a loopback receiver only where private addresses are allowed", async () => {
    const r = await receiver();
    const allowed = createWebhookHttpClient({ allowPrivateAddresses: true });
    // The witness: the receiver answers when nothing stands in the way.
    expect(
      await allowed.post(post(`http://127.0.0.1:${String(r.port)}/hook`)),
    ).toMatchObject({ kind: "answered", status: 200 });
    expect(r.hits()).toBe(1);

    const guarded = createWebhookHttpClient({ allowPrivateAddresses: false });
    for (const url of [
      `http://127.0.0.1:${String(r.port)}/hook`,
      `http://[::ffff:127.0.0.1]:${String(r.port)}/hook`,
      // A name resolving to loopback is refused when the socket opens,
      // after the lookup and before any byte is sent.
      `http://localhost:${String(r.port)}/hook`,
    ]) {
      expect(await guarded.post(post(url)), url).toEqual({
        kind: "failed",
        error: DELIVERY_FAILURE.notPublic,
      });
    }
    expect(r.hits()).toBe(1);
  });

  it("does not follow a redirect", async () => {
    const target = await receiver();
    const redirecting = await receiver((res) => {
      res.writeHead(302, {
        Location: `http://127.0.0.1:${String(target.port)}/hook`,
      });
      res.end();
    });
    const client = createWebhookHttpClient({ allowPrivateAddresses: true });
    expect(
      await client.post(
        post(`http://127.0.0.1:${String(redirecting.port)}/hook`),
      ),
    ).toEqual({ kind: "redirected", status: 302 });
    expect(redirecting.hits()).toBe(1);
    expect(target.hits()).toBe(0);
  });

  it("names a failure without the address or port it tried", async () => {
    const r = await receiver();
    const port = r.port;
    await new Promise<void>((resolve) => {
      servers.splice(0).forEach((s) => {
        s.close(() => {
          resolve();
        });
      });
    });
    const client = createWebhookHttpClient({ allowPrivateAddresses: true });
    const outcome = await client.post(
      post(`http://127.0.0.1:${String(port)}/`),
    );
    expect(outcome).toEqual({
      kind: "failed",
      error: DELIVERY_FAILURE.unreachable,
    });
  });

  it("gives up on a receiver that does not answer in time", async () => {
    const r = await receiver(() => {
      // Never answers.
    });
    const client = createWebhookHttpClient({ allowPrivateAddresses: true });
    expect(
      await client.post(post(`http://127.0.0.1:${String(r.port)}/`, 200)),
    ).toEqual({ kind: "failed", error: DELIVERY_FAILURE.timeout });
  });
});
