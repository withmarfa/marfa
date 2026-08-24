/**
 * Types for the declaration parser.
 *
 * The parser itself is plain Node ESM because the in-image verification
 * imports it inside the runtime image, where there is no TypeScript and no
 * monorepo. This is what lets the suite import the same module without
 * casting its way past the type checker, which is how a wrong shape would
 * otherwise reach a test.
 */

/** One line of the declaration. */
export interface InstalledIntegration {
  /** The `<handle>/<name>` identifier, which is also the integration's
   *  directory under the integrations root. */
  name: string;
  /** Declared as shipping a manifest and no dispatchable handler entry. */
  manifestOnly: boolean;
}

/** Thrown for anything the declaration does not say unambiguously. */
export declare class DeclarationError extends Error {}

/** Parse declaration text. Throws `DeclarationError` rather than guessing. */
export declare function parseInstalledIntegrations(
  text: string,
): InstalledIntegration[];

/**
 * Read and parse a declaration file.
 *
 * Throws `DeclarationError` for anything the declaration does not say
 * unambiguously, and for a file that cannot be read at all: both mean the
 * same thing to every caller, so they get one failure shape rather than
 * two.
 */
export declare function readInstalledIntegrations(
  path: string,
): InstalledIntegration[];
