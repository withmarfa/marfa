import { AsyncLocalStorage } from "node:async_hooks";
import {
  createRegistryFrame,
  discardRegistryFrame,
  prepareRegistryPublication,
  publishRegistryView,
  registrySnapshotView,
  setRegistryFrameAccessor,
  type RegistryFrame,
  type RegistryReadScope,
  type RegistrySnapshot,
  type RegistryView,
} from "@withmarfa/shared";
import type { StructuralParticipant } from "./transaction-control.js";

export const registryContext = new AsyncLocalStorage<
  RegistryFrame | RegistryReadScope
>();
let ready = true;
export function assertRegistryReady(): void {
  if (!ready) throw new Error("Storage registry state is unavailable");
}
setRegistryFrameAccessor(() => {
  const scope = registryContext.getStore();
  if (scope?.mode === "read") scope.assertActive();
  return scope;
}, assertRegistryReady);
export function publishBootRegistry(snapshot: RegistrySnapshot): void {
  publishRegistryView(registrySnapshotView(snapshot));
  ready = true;
}
export function registryParticipant(
  frame: RegistryFrame,
): StructuralParticipant {
  let prepared: RegistryView | undefined;
  return {
    get changed() {
      return frame.dirty || frame.reachDirty;
    },
    get structuralChanged() {
      return frame.reachDirty;
    },
    seal() {
      frame.sealed = true;
    },
    prepare() {
      prepared = prepareRegistryPublication(frame);
    },
    committed() {
      if (prepared) publishRegistryView(prepared);
      discardRegistryFrame(frame);
    },
    rolledBack() {
      discardRegistryFrame(frame);
    },
    unavailable() {
      ready = false;
    },
    async uncertain(load) {
      ready = false;
      try {
        const recovered = await load();
        publishRegistryView(registrySnapshotView(recovered.registry));
        ready = true;
      } finally {
        discardRegistryFrame(frame);
      }
    },
  };
}
export function rootRegistryParticipant(): {
  frame: RegistryFrame;
  participant: StructuralParticipant;
} {
  assertRegistryReady();
  const frame = createRegistryFrame();
  return { frame, participant: registryParticipant(frame) };
}
