import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootUnclaimedServer, stopServer } from "../../scripts/marfa-server.js";
import { controlRequest } from "./control-request.js";
import { bootFreshServer, runScript } from "./fresh-server.js";

describe("the fixture server's script runner", () => {
  it("keeps the worker's timers ticking while a script runs", async () => {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 10);
    try {
      const ran = await runScript(
        process.execPath,
        ["-e", "setTimeout(() => console.log('slept'), 500)"],
        process.env,
      );
      expect(ran).toEqual({ status: 0, output: "slept\n" });
      // Half a second of script leaves room for dozens of ticks; a runner
      // that held the worker would let it pass with none.
      expect(ticks).toBeGreaterThanOrEqual(10);
    } finally {
      clearInterval(timer);
    }
  });
});

describe("fixture listener ownership", () => {
  it("rejects an occupied IPv4 port without trusting its health or an earlier boot log", async () => {
    let requests = 0;
    let port = 0;
    const squatter = createServer((request, response) => {
      // Another process on a shared machine can probe a local port as
      // `localhost:<port>`; only a request addressed as the harness
      // addresses it counts.
      if (request.headers.host === `127.0.0.1:${String(port)}`) requests++;
      response.end("healthy impostor");
    });
    await new Promise<void>((done) => squatter.listen(0, "127.0.0.1", done));
    port = (squatter.address() as { port: number }).port;
    const state = mkdtempSync(join(tmpdir(), "marfa-occupied-port-"));
    // The impostor really does answer health before the harness is asked.
    await (await fetch(`http://127.0.0.1:${port}/health`)).text();
    expect(requests).toBe(1);
    requests = 0;
    writeFileSync(
      join(state, "server.log"),
      `${JSON.stringify({ message: `Marfa server listening on port ${port}` })}\n`,
    );
    try {
      await expect(bootUnclaimedServer({ state, port })).rejects.toThrow(
        "EADDRINUSE",
      );
      expect(requests).toBe(0);
    } finally {
      await stopServer({ state });
      await new Promise<void>((done) => squatter.close(() => done()));
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("assigns concurrent listeners their own ports, private sockets, and identities", async () => {
    const states = Array.from({ length: 4 }, () =>
      mkdtempSync(join(tmpdir(), "marfa-parallel-boot-")),
    );
    try {
      const boots = await Promise.allSettled(
        states.map((state) => bootUnclaimedServer({ state, port: 0 })),
      );
      const servers = boots.map((boot) => {
        if (boot.status === "rejected") throw boot.reason;
        return boot.value;
      });
      expect(new Set(servers.map((server) => server.url)).size).toBe(4);
      expect(new Set(servers.map((server) => server.controlSocket)).size).toBe(
        4,
      );
      for (const server of servers) {
        const publicRoot = await (await fetch(`${server.url}/`)).json();
        const discovery = await (
          await fetch(
            `${server.url}/auth/.well-known/oauth-authorization-server`,
          )
        ).json();
        expect(new URL(discovery.issuer).origin).toBe(
          new URL(server.url).origin,
        );
        const privateRoot = await controlRequest(server.controlSocket, "/");
        expect(publicRoot.instance_id).toBe(privateRoot.body.instance_id);
        const competitor = createServer();
        try {
          await expect(
            new Promise<void>((done, reject) => {
              competitor.once("error", reject);
              competitor.listen(
                Number(new URL(server.url).port),
                "127.0.0.1",
                done,
              );
            }),
          ).rejects.toMatchObject({ code: "EADDRINUSE" });
        } finally {
          await new Promise<void>((done) => competitor.close(() => done()));
        }
      }
    } finally {
      await Promise.all(
        states.map(async (state) => {
          await stopServer({ state });
          rmSync(state, { recursive: true, force: true });
        }),
      );
    }
  });

  it("restarts on an assigned port and on a retained port after keep-alive requests", async () => {
    const server = await bootFreshServer("restart-listener", { PORT: "0" });
    try {
      const root = await (await fetch(`${server.apiUrl}/`)).json();
      await server.restart();
      expect(await (await fetch(`${server.apiUrl}/`)).json()).toMatchObject({
        instance_id: root.instance_id,
      });
      const url = server.apiUrl;
      await server.restart({ env: { PORT: new URL(url).port } });
      expect(server.apiUrl).toBe(url);
      expect(await (await fetch(`${url}/`)).json()).toMatchObject({
        instance_id: root.instance_id,
      });
    } finally {
      await server.stop();
    }
  });
});
