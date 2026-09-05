/**
 * The local engine, hosted in an Electron main process.
 *
 * Its own subpath because `electron` is an optional peer: a consumer that is
 * not building a desktop application should not be made to install it. The
 * same reason `./local` is a subpath.
 *
 * **This is the main-process half.** The preload half is
 * `@withmarfa/sdk/electron/preload`, and the split is not tidiness: a
 * sandboxed preload has no filesystem `require` and could not load what this
 * entry imports even if a bundler inlined it.
 *
 * It exists as code rather than as a page of instructions because an
 * Electron integration is only correct as a whole. Channel names, argument
 * shapes and `webPreferences` all have to agree across a process boundary,
 * and a written recipe is a copy that drifts — separately, in every
 * application that followed it. Here a disagreement fails the build.
 */
export { openElectronLocalStore, sandboxedWebPreferences } from "./host.js";
export type {
  ElectronLocalHost,
  ElectronLocalHostOptions,
  ServeOptions,
} from "./host.js";

export { localStoreDirectory, localStorePath } from "./store-path.js";
export type { LocalStoreLocation } from "./store-path.js";

export {
  LOCAL_BRIDGE_KEY,
  LOCAL_EVENT_CHANNEL,
  LOCAL_INVOKE_CHANNEL,
  LOCAL_METHODS,
  PLAIN_REFUSAL,
  forRenderer,
  refusalNameOf,
} from "./protocol.js";
export type {
  BridgeEngineEvent,
  InvokeRequest,
  InvokeResult,
  LocalMethod,
  MarfaLocalBridge,
} from "./protocol.js";

export {
  LIBSQL_NATIVE_TARGETS,
  MissingNativeBinaryError,
  assertNativeTargets,
  verifyNativeTargets,
} from "./native-targets.js";
export type {
  LibsqlTarget,
  NativeTarget,
  NativeTargetFinding,
  NativeTargetReport,
  VerifyNativeTargetsOptions,
} from "./native-targets.js";
