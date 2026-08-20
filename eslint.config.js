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
          // Default is 8. Every workspace package contributes a
          // tsup.config and a vitest.config that fall through to the
          // default project, so the real number grows by two with each
          // new package or integration — and crossing the cap fails
          // lint from files nobody touched, naming the config rather
          // than the addition that pushed it over.
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
      // Wrangler's local cache and its mid-deploy scratch bundles. These are
      // generated tool output, not source: `wrangler deploy` writes a rolled-up
      // worker.js under .wrangler/tmp/ while it uploads. Linting them fails on
      // a parse error, because a generated bundle is in no tsconfig project —
      // so an unrelated deploy running in parallel breaks the lint gate.
      "**/.wrangler/",
      "packages/*/scripts/*.mjs",
      // The scheduled health check runs standalone on a CI runner with no
      // install step, so it is plain ESM outside every tsconfig project and
      // the type-aware rules have nothing to resolve it against. Same reason
      // the package scripts above are ignored.
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
