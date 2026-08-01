/**
 * Node-only auth surface: the shared `~/.marfa/<instance>.json` credential
 * store and its file-backed `TokenStorage`. A separate subpath
 * (`@withmarfa/sdk/auth/node`) so the universal `./auth` entry stays free of
 * `node:fs` and browser bundlers never see it.
 */

export {
  configDir,
  deleteConfigFile,
  mergeConfigFile,
  parsePersistedTokens,
  readConfigFile,
  readConfigFileSync,
  resolveConfigPath,
  resolveInstanceName,
  writeConfigFile,
  type ConfigFile,
  type OAuthSlot,
} from "./config-file.js";
export {
  FileTokenStorage,
  type FileTokenStorageOptions,
} from "./file-token-storage.js";
