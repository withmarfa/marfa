import { afterEach, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { reservePublicListener } from "./public-listener.js";

const listeners: Awaited<ReturnType<typeof reservePublicListener>>[] = [];
afterEach(async () => {
  await Promise.all(
    listeners.splice(0).map(
      ({ server }) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
          server.closeAllConnections();
        }),
    ),
  );
});

it("holds an assigned port and serves only a startup response before activation", async () => {
  const config = loadConfig({ PORT: "0", MARFA_LISTEN_HOST: "127.0.0.1" });
  const listener = await reservePublicListener(config);
  listeners.push(listener);
  expect(config.port).toBeGreaterThan(0);
  expect(config.authBaseUrl).toBe(`http://127.0.0.1:${String(config.port)}`);
  const url = `http://127.0.0.1:${String(config.port)}`;
  expect((await fetch(url)).status).toBe(503);
  listener.activate(() => new Response("ready"));
  expect(await (await fetch(url)).text()).toBe("ready");
  await expect(reservePublicListener({ ...config })).rejects.toMatchObject({
    code: "EADDRINUSE",
  });
});

it("assigns distinct ports concurrently while preserving an explicit origin", async () => {
  const first = loadConfig({
    PORT: "0",
    MARFA_AUTH_BASE_URL: "http://localhost:0",
  });
  const second = loadConfig({ PORT: "0" });
  listeners.push(
    ...(await Promise.all([
      reservePublicListener(first),
      reservePublicListener(second),
    ])),
  );
  expect(first.port).not.toBe(second.port);
  for (const { server } of listeners) {
    const address = server.address();
    expect(
      address &&
        typeof address !== "string" &&
        ["::", "0.0.0.0"].includes(address.address),
    ).toBe(true);
  }
  expect(first.authBaseUrl).toBe("http://localhost:0");
});
