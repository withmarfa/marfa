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
            // The withmarfa.inbox integration ships a nested
            // Cloudflare Email Worker as its own workspace package
            // (`integrations/withmarfa-inbox/email-worker/`). Its
            // vitest.config.ts also falls through to the default
            // project.
            "integrations/*/email-worker/vitest.config.ts",
          ],
          // Default is 8; we have ~10 config files that fall through
          // to the default project (per-package tsup + vitest configs
          // across 6 packages + 1 integration + the root vitest +
          // eslint configs). Raised to 43 to accommodate the in-tree
          // integration configs plus the withmarfa.inbox email-worker
          // subpackage that contributes a vitest.config through the
          // `integrations/*/email-worker/vitest.config.ts` glob.
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 43,
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
      // The scheduled health check runs standalone on a CI runner with no
      // install step, so it is plain ESM outside every tsconfig project and
      // the type-aware rules have nothing to resolve it against. Same reason
      // the package scripts above are ignored.
      ".github/observability/*.mjs",
      // Git worktrees created under .claude/worktrees/<name>/ are
      // separate checkouts with their own lint runs; the main
      // checkout's lint must not descend into them or it'll surface
      // work-in-progress code from other agents/branches.
      ".claude/worktrees/",
      // Global scratch folders (per the user's ~/.gitignore_global —
      // also documented in the user-level CLAUDE.md). These hold
      // throwaway harnesses, captures, and never-tracked files; they
      // sit in the repo tree but aren't part of the project's source
      // set. The `**/` prefix catches them anywhere in the monorepo
      // (e.g. packages/server/_tmp/), not just the repo root. Without
      // this ignore, lint trips on any `.ts`/`.mjs` an agent drops
      // there for local exploration.
      "**/_local/**",
      "**/_tmp/**",
      "**/_ignore/**",
    ],
  },
];
