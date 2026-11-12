declare module "vitest" {
  interface TaskMeta {
    /** The one platform the test runs on. Elsewhere it is skipped for that alone. */
    onlyOn?: NodeJS.Platform;
    /** Why this machine cannot show what the test asserts, set just before it skips. */
    unobservable?: string;
  }
}

/**
 * The options of a test or chapter that runs only on macOS, such as one of
 * FSEvents or the keychain. The Rust score leaves such a test out on another
 * platform and counts every other skip as not passing
 * (`src/utils/rust-score.ts`).
 */
export const ON_MACOS = {
  skip: process.platform !== "darwin",
  meta: { onlyOn: "darwin" },
} as const satisfies {
  skip: boolean;
  meta: { onlyOn: NodeJS.Platform };
};
