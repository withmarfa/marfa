/**
 * Types for the integrations-ref parser.
 *
 * The parser is plain Node ESM so a workflow step can run it with no build,
 * and this is what lets the suite import the same module without casting
 * its way past the type checker.
 */

/** Thrown for anything the file does not say unambiguously. */
export declare class RefError extends Error {}

/** Parse the file's text into one full commit SHA. Throws `RefError`
 *  rather than returning nothing. */
export declare function parseIntegrationsRef(text: string): string;

/** Read and parse the file. Throws `RefError` for an unreadable file too:
 *  both leave the caller with no commit. */
export declare function readIntegrationsRef(path: string): string;
