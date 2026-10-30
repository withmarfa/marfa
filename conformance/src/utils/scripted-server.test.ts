import { afterEach, describe, expect, it } from "vitest";
import { request } from "node:http";
import { ScriptedServer } from "../device/scripted-server.js";

/** A raw request, because `fetch` will not let a caller choose its Host. */
function get(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      { host: "127.0.0.1", port, path: "/", headers: { host } },
      (response) => {
        response.resume();
        response.on("end", () => {
          resolve(response.statusCode ?? 0);
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

describe("the scripted server's request record", () => {
  let server: ScriptedServer | undefined;
  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it("records only requests addressed as the device is given the server", async () => {
    server = await ScriptedServer.start();
    const port = Number(new URL(server.url).port);

    // The witness: the address the device is given is recorded and answered.
    expect(await get(port, `127.0.0.1:${String(port)}`)).toBe(200);
    expect(server.requests).toHaveLength(1);

    // A probe from another process on the machine is neither.
    expect(await get(port, `localhost:${String(port)}`)).toBe(421);
    expect(server.requests).toHaveLength(1);
    expect(server.unmatchedRequests).toHaveLength(0);
  });
});
