import type { AppConfig } from "../config.js";
import type { Housekeeping } from "../housekeeping/scheduler.js";
import type { BlobLayer } from "../storage/blob-layer.js";
import type { HousekeepingRow, Storage } from "../storage/interface.js";
import {
  objectStoreComponent,
  readHealth,
  type ComponentStatus,
  type HealthReading,
} from "./health.js";
import type { HealthProbes } from "./health-probes.js";

/**
 * What the owner console reads to say how Marfa is running: the same
 * answers `GET /health` and `GET /housekeeping` give, asked in one place for
 * the Health page and for Home.
 */
export interface ConsoleHealth {
  read(): Promise<HealthReading>;
  /** The attached object store, or `null` when there is none. */
  objectStore(budgetMs?: number): Promise<ComponentStatus | null>;
  jobs(): Promise<HousekeepingRow[]>;
}

export function consoleHealth(sources: {
  storage: Storage;
  blobs: BlobLayer;
  config: Pick<AppConfig, "diskReserveBytes">;
  probes: HealthProbes;
  housekeeping: Housekeeping;
}): ConsoleHealth {
  const { storage, blobs, config, probes, housekeeping } = sources;
  return {
    read: () => readHealth(storage, blobs, config, probes),
    objectStore: (budgetMs) => objectStoreComponent(blobs, budgetMs),
    jobs: () => housekeeping.list(),
  };
}
