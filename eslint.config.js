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
            "packages/*/tsup.config.ts",
            "packages/*/vitest.config.ts",
            "integrations/*/tsup.config.ts",
            "integrations/*/vitest.config.ts",
          ],
          // Default is 8; we have ~10 config files that fall through
          // to the default project (per-package tsup + vitest configs
          // across 6 packages + 1 integration + the root vitest +
          // eslint configs). Bumped to 30 in T-236 (google-tasks),
          // then 32 in T-237 (google-contacts), then 34 in T-241
          // (todoist), then 36 in T-242 (readwise) — each new
          // integration adds its tsup + vitest configs to the
          // default-project file set.
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 36,
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
    // The Storage interface is async (Postgres path awaits); the SQLite
    // implementations satisfy it with sync bodies because better-sqlite3
    // is sync. require-await flags the empty Promise wrapping.
    files: ["**/storage/sqlite/*.ts"],
    rules: {
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    ignores: [
      "**/dist/",
      "**/coverage/",
      "**/node_modules/",
      "**/seed/",
      "packages/*/scripts/*.mjs",
      // Git worktrees created under .claude/worktrees/<name>/ are
      // separate checkouts with their own lint runs; the main
      // checkout's lint must not descend into them or it'll surface
      // work-in-progress code from other agents/branches.
      ".claude/worktrees/",
      // Global scratch folders (per the user's ~/.gitignore_global —
      // also documented in the user-level CLAUDE.md). These hold
      // throwaway harnesses, captures, and never-tracked files; they
      // sit in the repo tree but aren't part of the project's source
      // set. Without this ignore, lint trips on any `.ts` an agent
      // drops there for local exploration (e.g. the validation
      // harness from T-231 close-out).
      "_local/",
      "_tmp/",
      "_ignore/",
    ],
  },
];
