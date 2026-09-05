/**
 * What a renderer needs, and nothing a renderer cannot have.
 *
 * The third entry, because Electron is three contexts rather than two. The
 * main-process half imports the store; the preload half imports `electron`;
 * a page can load neither. A renderer reaching for either would pull
 * `@libsql/client` or an `electron` module that does not exist in a browser
 * bundle into a script that has to be plain.
 *
 * Everything here is a type, a constant, or a pure function over a string.
 */
export {
  LOCAL_BRIDGE_KEY,
  LOCAL_EVENT_CHANNEL,
  LOCAL_INVOKE_CHANNEL,
  PLAIN_REFUSAL,
  refusalNameOf,
} from "../protocol.js";
export type {
  BridgeEngineEvent,
  InvokeRequest,
  InvokeResult,
  LocalMethod,
  MarfaLocalBridge,
} from "../protocol.js";
