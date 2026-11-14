import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type { Outcome } from "../../device/protocol.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { QUIET_SCHEDULE, quiet } from "../../utils/moved-clock.js";
import { clientsFor, DISK_ONLY, runJob } from "../../utils/own-blob-server.js";
import { fileOf, requireBinary } from "./harness.js";

let server: FreshServer;
let operator: MarfaClient;
let working: MarfaClient;
const stores: string[] = [];

beforeAll(async () => {
  server = await bootFreshServer("device-upload-again", {
    ...QUIET_SCHEDULE,
    ...DISK_ONLY,
    MARFA_BLOB_CLEANUP_GRACE_SECONDS: "0",
  });
  ({ operator, working } = clientsFor(server));
  await quiet(server, ["blob-orphans", "blob-replicate"]);
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  for (const store of stores)
    rmSync(dirname(store), { recursive: true, force: true });
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

function value<T>(answer: Outcome<T>): T {
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (!answer.ok) throw new Error(answer.refusal.raw);
  return answer.value;
}

it(
  "sends a file's bytes again once the server has purged them, and the file item lands",
  async () => {
    const store = newStore("upload-again");
    stores.push(store);
    const device = new CliDevice({
      binary: requireBinary(),
      store,
      url: server.apiUrl,
      key: server.workingKey,
    });
    value(await device.hydrate(["core.note"], "library"));
    const bytes = `the bytes of a photo ${String(Date.now())}\n`;

    const queued = value(
      await device.addFile(fileOf("photo.txt", bytes), { type: "core.file" }),
    );
    const upload = queued.find((write) => write.kind === "upload_blob");
    const file = queued.find((write) => write.kind === "create_item");
    const hash = upload?.blob;
    expect(hash, JSON.stringify(queued)).toBeTruthy();

    // The upload is the first write; the fault stalls the item write.
    await server.setFault("fail:lock=2");
    value(await device.drain());
    expect(
      (await server.faults()).find((fault) => fault.name === "fail:lock")
        ?.fired,
    ).toBe(1);
    await server.clearFault("fail:lock");
    const stalled = value(await device.queue());
    expect(stalled.find((write) => write.id === upload?.id)?.verdict).toBe(
      "accepted",
    );
    expect(
      stalled.find((write) => write.id === file?.id)?.verdict ?? null,
      JSON.stringify(stalled),
    ).toBeNull();

    const reported = await runJob<{ reported: number; purged: number }>(
      operator,
      "blob-orphans",
    );
    expect(reported.result.reported).toBeGreaterThanOrEqual(1);
    const purged = await runJob<{ reported: number; purged: number }>(
      operator,
      "blob-orphans",
    );
    expect(purged.result.purged).toBeGreaterThanOrEqual(1);
    expect(
      (await operator.downloadBlob(hash!)).status,
      "the sweep left the bytes, so nothing here is about bytes the server lost",
    ).toBe(404);

    const drained = value(await device.drain());
    const settled = value(await device.queue());
    expect(
      settled.find((write) => write.id === file?.id)?.verdict,
      JSON.stringify(drained),
    ).toBe("accepted");
    expect(settled.find((write) => write.id === upload?.id)?.verdict).toBe(
      "accepted",
    );

    expect(value(await device.release({ id: file!.id }))).toBe(0);

    value(await device.fileBudget("0"));
    const id = settled.find((write) => write.id === file?.id)?.item_id;
    expect(id).toBeTruthy();
    const item = await working.getItem(id!);
    expect(item.status, JSON.stringify(item.error)).toBe(200);
    expect(item.data.item.properties.blob_ref).toBe(hash);
    const read = await working.downloadBlob(hash!);
    expect(read.status).toBe(200);
    expect(new TextDecoder().decode(read.data as ArrayBuffer)).toBe(bytes);
  },
  FRESH_SERVER_TIMEOUT_MS,
);
