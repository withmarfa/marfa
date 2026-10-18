import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import {
  DELIVERY_FAILURE,
  createWebhookHttpClient,
  MAX_REGISTRATION_LOOKUPS,
  isPublicAddress,
  refuseNonPublicHost,
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

  it("takes an IPv6 address only inside 2000::/3, after an IPv4-mapped one is read as the IPv4 address it carries", () => {
    for (const address of [
      "2606:4700:4700::1111",
      "2a00:1450:4009:81f::200e",
      "2000::1",
      "3fff:ffff::1",
      "::ffff:8.8.8.8",
    ]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
    for (const address of [
      // Outside 2000::/3.
      "::10.0.0.1",
      "::a00:1",
      "::7f00:1",
      "::808:808",
      "::ffff:0:808:808",
      "64:ff9b::808:808",
      "64:ff9b:1::1",
      "fc00::1",
      "fe80::1",
      "fe80::1%eth0",
      "ff02::1",
      "ff0e::1",
      "1fff::1",
      "4000::1",
      "8000::1",
      "e000::1",
      // Special blocks inside 2000::/3.
      "2001::1",
      "2001:0:4136:e378:8000:63bf:3fff:fdd2",
      "2001:10::1",
      "2001:20::1",
      "2001:db8::1",
      "2002:808:808::1",
      "3fff::1",
      // IPv4-mapped, judged as the IPv4 address it carries.
      "::ffff:10.0.0.1",
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

/** A resolver that answers when the test says so, which a wait may outlast. */
function hungLookup(): {
  resolve: () => Promise<string[]>;
  answer: (addresses: string[]) => void;
} {
  let answer!: (addresses: string[]) => void;
  const promise = new Promise<string[]>((resolve) => {
    answer = resolve;
  });
  return { resolve: () => promise, answer };
}

describe("refuseNonPublicHost", () => {
  const resolvingTo =
    (...addresses: string[]) =>
    () =>
      Promise.resolve(addresses);

  it("refuses a name that resolves to an address a delivery would refuse, naming the setting", async () => {
    for (const address of [
      // A Tailscale host: carrier-grade NAT.
      "100.127.105.110",
      "10.0.0.5",
      "192.168.1.20",
      "172.16.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "::1",
      "fe80::1",
      "fc00::1",
      "fd12:3456:789a::1",
      "::ffff:10.0.0.1",
    ]) {
      const refusal = await refuseNonPublicHost(
        "https://receiver.example:8446/hook",
        { resolve: resolvingTo(address) },
      );
      expect(refusal, address).toContain(
        "MARFA_WEBHOOK_ALLOW_PRIVATE_ADDRESSES",
      );
    }
  });

  it("takes a name whose every address is public", async () => {
    // The witness for the refusals above: the same path accepts.
    expect(
      await refuseNonPublicHost("https://receiver.example/hook", {
        resolve: resolvingTo("93.184.215.14", "2606:4700::1"),
      }),
    ).toBeNull();
  });

  it("refuses a name with one public and one private address, as a delivery would", async () => {
    for (const addresses of [
      ["93.184.215.14", "10.0.0.5"],
      ["10.0.0.5", "93.184.215.14"],
      ["2606:4700::1", "fd00::1"],
    ]) {
      expect(
        await refuseNonPublicHost("https://receiver.example/hook", {
          resolve: resolvingTo(...addresses),
        }),
        addresses.join(),
      ).not.toBeNull();
    }
  });

  it("takes a name it cannot resolve, leaving delivery to look again", async () => {
    const hung = hungLookup();
    for (const resolve of [
      () => Promise.reject(new Error("ENOTFOUND")),
      () => Promise.resolve([]),
      // Answers, but past the limit, and with an address that would refuse.
      hung.resolve,
    ]) {
      expect(
        await refuseNonPublicHost("https://receiver.example/hook", {
          resolve,
          timeoutMs: 20,
        }),
      ).toBeNull();
    }
    hung.answer(["10.0.0.5"]);
  });

  it("makes at most MAX_REGISTRATION_LOOKUPS at once, accepting a name it does not look up, and gives the places back when the resolvers answer", async () => {
    const private_ = () => Promise.resolve(["10.0.0.5"]);
    // The witness: with a place free, the same resolver refuses.
    expect(
      await refuseNonPublicHost("https://receiver.example/hook", {
        resolve: private_,
      }),
    ).not.toBeNull();

    // Names that never answer take every place, though each wait ends.
    const hung = Array.from({ length: MAX_REGISTRATION_LOOKUPS }, hungLookup);
    for (const lookup of hung) {
      expect(
        await refuseNonPublicHost("https://receiver.example/hook", {
          resolve: lookup.resolve,
          timeoutMs: 10,
        }),
      ).toBeNull();
    }
    let asked = 0;
    const counted = () => {
      asked += 1;
      return private_();
    };
    expect(
      await refuseNonPublicHost("https://receiver.example/hook", {
        resolve: counted,
      }),
    ).toBeNull();
    expect(asked).toBe(0);

    for (const lookup of hung) lookup.answer([]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      await refuseNonPublicHost("https://receiver.example/hook", {
        resolve: counted,
      }),
    ).not.toBeNull();
    expect(asked).toBe(1);
  });

  it("leaves an address written out to refuseWebhookUrl, and asks no resolver", async () => {
    let asked = 0;
    const resolve = () => {
      asked += 1;
      return Promise.resolve(["10.0.0.5"]);
    };
    expect(
      await refuseNonPublicHost("http://10.0.0.5/hook", { resolve }),
    ).toBeNull();
    expect(
      await refuseNonPublicHost("http://[2606:4700::1]/hook", { resolve }),
    ).toBeNull();
    expect(asked).toBe(0);
  });

  it("resolves the host a URL names, without its port, path or brackets", async () => {
    const hosts: string[] = [];
    await refuseNonPublicHost("https://Receiver.Example:8446/a/b?c=1", {
      resolve: (host) => {
        hosts.push(host);
        return Promise.resolve([]);
      },
    });
    expect(hosts).toEqual(["receiver.example"]);
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
        kind: "refused",
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
