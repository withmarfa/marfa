import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  archiveLines,
  archiveManifest,
  LINE_FILES,
  readEntry,
  readLineFile,
} from "../../utils/archive.js";
import {
  cleanup,
  createSecondClient,
  createTestContext,
  getOwnerClient,
  trackKey,
} from "../../utils/setup.js";

/**
 * What an archive leaves out of a connector's inbound side: the endpoint, its
 * address and the deliveries it received.
 */
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, apiUrl } = await createTestContext(
    "compliance",
    "export-no-inbound",
  ));
});

afterAll(async () => {
  // Removing the registration removes its endpoints and deliveries.
  await cleanup(ctx);
});

describe("an archive of a source whose connector holds an inbound endpoint", () => {
  it("carries the connector's state and none of its endpoint, address or deliveries", async () => {
    const owner: MarfaClient = await createSecondClient(ctx, "inbound");
    const registered = await owner.registerConnector({
      name: `${ctx.runId} inbound`,
    });
    expect(registered.status, JSON.stringify(registered.error)).toBe(201);
    const { id, source } = registered.data;

    const process = "export-no-inbound";
    expect((await owner.takeConnectorHold(id, process)).status).toBe(200);
    const stateWritten = await owner.replaceConnectorState(id, {
      process,
      state: { cursor: "c1" },
    });
    expect(stateWritten.status, JSON.stringify(stateWritten.error)).toBe(200);

    const made = await owner.createInboundEndpoint(id, { label: "export" });
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    const marker = `inbound-body-${randomUUID()}`;
    const sent = await fetch(`${apiUrl}${made.data.path}`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: marker,
    });
    expect(sent.status).toBe(202);
    const held = await owner.listInboundDeliveries(id);
    expect(held.data.data).toHaveLength(1);
    const deliveryId = held.data.data[0]!.id;

    // A key that holds every permission, so it is the archive's choice that
    // leaves the inbound side out.
    const minted = await getOwnerClient().createKey({
      label: "export-no-inbound",
      source: `${ctx.source}-everything`,
    });
    expect(minted.status, JSON.stringify(minted.error)).toBe(201);
    trackKey(ctx, minted.data.id);
    const everything = new MarfaClient({
      baseUrl: apiUrl,
      apiKey: minted.data.key,
    });
    const archive = await everything.exportArchive({
      state: "any",
      source,
    });
    expect(archive.status).toBe(200);

    // The witness: the archive carries the connector's state, so what it
    // leaves out of the inbound side is a choice it made.
    const lines = archiveLines<Record<string, unknown>>(
      archive.data,
      "instance",
    );
    expect(lines.map((line) => line.connector_state)).toContainEqual({
      source,
      state: { cursor: "c1" },
    });

    const text = [
      readEntry(archive.data, "manifest.json"),
      ...LINE_FILES.map((name) => readLineFile(archive.data, name)),
    ].join("\n");
    for (const absent of [
      made.data.path,
      made.data.path.replace("/inbound/", ""),
      made.data.id,
      deliveryId,
      marker,
    ]) {
      expect(text, absent).not.toContain(absent);
    }
    for (const line of lines) {
      expect(
        Object.keys(line).filter((key) => /inbound|endpoint|deliver/.test(key)),
      ).toEqual([]);
    }
    expect(
      Object.keys(archiveManifest(archive.data)).filter((key) =>
        /inbound|endpoint|deliver/.test(key),
      ),
    ).toEqual([]);
  });
});
