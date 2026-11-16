import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { DISK_ONLY } from "../../utils/own-blob-server.js";

/**
 * `GET /health` calls the disk degraded below the greater of its fixed line
 * (64 MiB) and the instance's disk reserve. This server keeps a reserve above
 * the fixed line, so the two readings differ: 100 MiB is room enough for the
 * fixed line alone.
 */
const MiB = 1024 * 1024;
const RESERVE = 256 * MiB;

let server: FreshServer;

beforeAll(async () => {
  server = await bootFreshServer("disk-reserve-health", {
    ...DISK_ONLY,
    MARFA_DISK_RESERVE_BYTES: String(RESERVE),
  });
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

async function diskStatus(room: number): Promise<string | undefined> {
  await server.setFault(`free:database=${String(room)}`);
  await server.setFault(`free:blobs=${String(room)}`);
  const response = await fetch(`${server.apiUrl}/health`, {
    headers: { Authorization: `Bearer ${server.managementKey}` },
  });
  const body = (await response.json()) as {
    components: Record<string, { status: string }>;
  };
  return body.components.disk?.status;
}

async function diskError(): Promise<string | undefined> {
  const response = await fetch(`${server.apiUrl}/health`, {
    headers: { Authorization: `Bearer ${server.managementKey}` },
  });
  const body = (await response.json()) as {
    components: Record<string, { error?: string }>;
  };
  return body.components.disk?.error;
}

describe("GET /health with a disk reserve above the fixed line", () => {
  it("answers the disk component degraded below a reserve above 64 MiB, and ok at it", async () => {
    // The witness: room at the reserve is ok, so the degraded answers below
    // are the reserve's doing.
    expect(await diskStatus(RESERVE)).toBe("ok");
    expect(await diskStatus(100 * MiB)).toBe("degraded");
    expect(await diskStatus(RESERVE - 1)).toBe("degraded");
    // Under 1 MiB is down whatever the reserve is.
    expect(await diskStatus(MiB - 1)).toBe("down");
  });

  it("says in the disk component's error that the reserve is not less than the volume, naming the setting, where it is not", async () => {
    await server.setFault(`size:blobs=${String(RESERVE / 2)}`);
    await server.setFault(`free:database=${String(100 * MiB)}`);
    await server.setFault(`free:blobs=${String(100 * MiB)}`);
    expect(await diskError()).toContain(
      "disk reserve of 256 MiB (disk_reserve_bytes) is not less than the 128 MiB",
    );
    // The witness: a volume the reserve fits in says only that room is short.
    await server.setFault(`size:blobs=${String(RESERVE * 2)}`);
    const short = await diskError();
    expect(short).toContain("less than the disk reserve of 256 MiB");
    expect(short).not.toContain("not less than the");
    await server.clearFault();
  });
});
