import type { Storage } from "../storage/interface.js";

interface ActiveExport {
  controller: AbortController;
  settled: Promise<void>;
}

interface ExportState {
  stopping: boolean;
  active: Set<ActiveExport>;
}

const exportsByStorage = new WeakMap<Storage, ExportState>();

export function beginArchiveExport(storage: Storage, client: AbortSignal) {
  let state = exportsByStorage.get(storage);
  if (!state) {
    state = { stopping: false, active: new Set() };
    exportsByStorage.set(storage, state);
  }
  if (state.stopping) {
    throw new DOMException("The server is stopping", "AbortError");
  }
  const controller = new AbortController();
  let settle!: () => void;
  let fail!: (error: unknown) => void;
  const active = {
    controller,
    settled: new Promise<void>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    }),
  };
  state.active.add(active);
  void active.settled.catch(() => undefined);
  return {
    signal: AbortSignal.any([client, controller.signal]),
    finish(error?: unknown) {
      state.active.delete(active);
      if (error === undefined) settle();
      else fail(error);
    },
  };
}

export async function stopArchiveExports(storage: Storage): Promise<void> {
  let state = exportsByStorage.get(storage);
  if (!state) {
    state = { stopping: true, active: new Set() };
    exportsByStorage.set(storage, state);
  }
  state.stopping = true;
  const active = [...state.active];
  for (const run of active) {
    run.controller.abort(
      new DOMException("The server is stopping", "AbortError"),
    );
  }
  const settled = await Promise.allSettled(active.map((run) => run.settled));
  const failed = settled.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}
