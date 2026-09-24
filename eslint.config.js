import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "eslint.config.js",
            "vitest.config.ts",
            // Imported by every package's vitest config for the shared test
            // and hook budget. Not under any package's tsconfig, for the same
            // reason the configs importing it are not.
            "vitest.shared.ts",
            "packages/*/tsup.config.ts",
            "packages/*/vitest.config.ts",
          ],
          // Default is 8. Every workspace package contributes a
          // tsup.config and a vitest.config that fall through to the
          // default project, so the real number grows by two with each
          // new package — and crossing the cap fails lint from files
          // nobody touched, naming the config rather than the addition
          // that pushed it over.
          //
          // Set well above the current count so an ordinary addition
          // does not trip it. When it is genuinely reached, raise it
          // again with headroom; the alternative is giving the config
          // files a tsconfig of their own so they stop falling through
          // at all.
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 80,
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["eslint.config.js"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
    },
  },
  {
    // Route handlers parse untyped JSON from HTTP requests
    files: ["**/routes/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
    },
  },
  {
    // Tests frequently use non-null assertions where an in-scope setup
    // guarantees the value exists; the test framework surfaces the failure
    // clearly if the assumption is wrong.
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    // The Storage interface is async; some SQLite store methods satisfy it
    // with bodies that never await, and require-await flags the wrapping.
    files: ["**/storage/sqlite/*.ts"],
    rules: {
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    ignores: [
      "**/dist/",
      // The generated client, whose shape is openapi-typescript's.
      "packages/client/src/generated/",
      "**/coverage/",
      "**/node_modules/",
      "**/seed/",
      // Nested worktrees are separate checkouts that run their own lint;
      // descending into them surfaces work in progress from other branches.
      "worktrees/",
      ".claude/worktrees/",
      // Scratch folders: throwaway harnesses, captures and never-tracked
      // files that sit in the repo tree without being part of its source.
      // The `**/` prefix catches them at any depth rather than only at the
      // root, so a stray `.ts` under one does not trip the lint gate.
      "**/_local/**",
      "**/_tmp/**",
      "**/_ignore/**",
      // The Rust core workspace; its Node binding is linted where it lives.
      "core/",
      // The conformance suite, held by `conformance/tsconfig.json` and
      // Prettier rather than by this config.
      //
      // The rules that fire are the ones that read a declared type as the
      // truth, and in this directory it is not. The fixtures assert over
      // what a server sent, against hand-written declarations of what the
      // contract claims it sends, so the checks `no-unnecessary-condition`
      // and `no-unnecessary-type-assertion` call redundant are exactly the
      // ones a referee should keep. The suite's tsconfig does not extend
      // `tsconfig.base.json`, so its types are weaker again: without
      // `noUncheckedIndexedAccess` an array index reads as defined, and
      // every `?? ""` behind one is reported as pointless when removing it
      // would be a defect. Turning that on instead is not a small change —
      // it reports 107 times across the fixtures.
      //
      // Style is the rest of it: 148 of the 341 reports were `${count}`
      // where this config wants `String(count)`. Rewriting a fixture corpus
      // whose readability is the specification, to satisfy a preference, is
      // a poor trade.
      "conformance/",
    ],
  },
];
