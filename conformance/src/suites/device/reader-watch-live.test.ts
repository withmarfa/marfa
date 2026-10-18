import { createServer, request } from "node:http";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { expect, it, vi } from "vitest";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import { createTestContext, cleanup } from "../../utils/setup.js";
import { requireBinary } from "./harness.js";

it("tells a never-hydrated reader about a concurrent save without a hydration warning or server contact", async () => {
  const context = await createTestContext("device", "reader-watch");
  const fixtureServer = new URL(context.apiUrl);
  let contacts = 0;
  const proxy = createServer((incoming, outgoing) => {
    contacts++;
    const requested = new URL(incoming.url ?? "/", "http://fixture.invalid");
    const upstream = request(
      fixtureServer,
      {
        path: `${requested.pathname}${requested.search}`,
        method: incoming.method,
        headers: incoming.headers,
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.on("error", () => outgoing.destroy());
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  if (!address || typeof address === "string")
    throw new Error("no proxy address");
  const store = newStore("reader-watch-live");
  const device = new CliDevice({
    binary: requireBinary(),
    store,
    url: `http://127.0.0.1:${address.port}`,
    key: context.apiKey,
  });
  try {
    expect((await device.status()).ok).toBe(true);
    // The same URL reaches the real server and the counter observes it.
    const served = await device.servedItemTypes();
    expect(served.ok, JSON.stringify(served)).toBe(true);
    expect(contacts).toBeGreaterThan(0);
    const status = await device.status();
    expect(status.ok && status.value.hydration).toBe("never");
    const before = contacts;
    const args = ["device", "--db", store, "watch", "--for", "20"];
    const writer = device.hold(args, "text");
    try {
      await vi.waitFor(() =>
        expect(writer.stderr).toContain("run `device hydrate` first"),
      );
    } finally {
      await writer.stop();
    }
    const reader = device.hold(
      ["device", "--db", store, "--reader", "watch", "--for", "20"],
      "text",
    );
    try {
      await vi.waitFor(
        async () => {
          expect(reader.running(), reader.stderr).toBe(true);
          const saved = await device.create({
            type: "core.note",
            properties: { title: "concurrent save", body: "saved locally" },
          });
          expect(saved.ok, JSON.stringify(saved)).toBe(true);
          expect(reader.stdout, reader.stderr).toContain("store.saved");
        },
        { timeout: 10_000, interval: 100 },
      );
      expect(reader.stderr).not.toContain("hydrate");
      expect(contacts, "a watch contacted the server before hydration").toBe(
        before,
      );
    } finally {
      await reader.stop();
    }
  } finally {
    proxy.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      proxy.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(dirname(store), { recursive: true, force: true });
    await cleanup(context.ctx);
  }
});
