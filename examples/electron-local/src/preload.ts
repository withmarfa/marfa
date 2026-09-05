import { exposeLocalBridge } from "@withmarfa/sdk/electron/preload";

/**
 * The whole preload.
 *
 * It is bundled into one CommonJS file by `tsup.config.ts` rather than left
 * to resolve at runtime, because a sandboxed preload's `require` reaches
 * `electron` and a handful of builtins and nothing else — a preload that
 * imports a package by name loads only once a bundler has inlined it.
 */
exposeLocalBridge();
