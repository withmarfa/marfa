import { join } from "node:path";
import { expect, vi } from "vitest";
import {
  BindingDevice,
  type BindingFolder,
  type BindingFolderEvent,
  type Subscription,
} from "../../device/binding-adapter.js";
import {
  folderHarness,
  requireModule,
  KEY,
  type FolderHarness,
} from "./harness.js";

export interface BindingFolderHarness extends FolderHarness {
  device: BindingDevice;
  bound: BindingFolder;
}

/** Adds a binding host with its own registry and clock to a folder fixture. */
export async function openBindingFolder(
  harness: FolderHarness,
): Promise<BindingFolderHarness> {
  const device = await BindingDevice.start({
    module: requireModule(),
    store: join(harness.dir, "..", "binding.sqlite"),
    url: harness.server.url,
    key: KEY,
    registry: harness.registry,
  });
  await device.clock.manual();
  return {
    ...harness,
    device,
    bound: device.folder(harness.dir),
    stop: async () => {
      await device.close();
      await harness.stop();
    },
  };
}

export async function bindingFolderHarness(
  label: string,
  options: Parameters<typeof folderHarness>[1] = {},
): Promise<BindingFolderHarness> {
  const harness = await folderHarness(label, options);
  try {
    return await openBindingFolder(harness);
  } catch (error) {
    await harness.stop();
    throw error;
  }
}

/** Observes an event; the deadline only bounds a failed fixture. */
export async function folderTold(
  watch: Subscription<BindingFolderEvent>,
  kind: BindingFolderEvent["kind"],
  count = 1,
): Promise<void> {
  await vi.waitFor(
    () => {
      expect(watch.kinds.filter((one) => one === kind)).toHaveLength(count);
    },
    { timeout: 10_000, interval: 10 },
  );
}

/** Advances one registered engine wait, never the system clock. */
export async function folderTick(
  device: BindingDevice,
  ms?: number,
): Promise<void> {
  let left = 0;
  await vi.waitFor(
    async () => {
      const waits = await device.clock.waits();
      expect(waits.length).toBeGreaterThan(0);
      left = Math.min(
        ...waits.flatMap((wait) => (wait.leftMs === null ? [] : [wait.leftMs])),
      );
    },
    { timeout: 10_000, interval: 10 },
  );
  await device.clock.advance(ms ?? left);
}
