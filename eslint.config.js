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
            // The server's dispatch fixture is a nested workspace
            // package, so its tsup config falls through as well. No
            // vitest config: the fixture is driven by the image
            // verification and the worker-entry smoke, both of which
            // need it built, and neither is vitest.
            "packages/server/fixtures/*/tsup.config.ts",
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
    // The Storage interface is async (Postgres path awaits); the SQLite
    // implementations satisfy it with sync bodies because better-sqlite3
    // is sync. require-await flags the empty Promise wrapping.
    files: ["**/storage/sqlite/*.ts"],
    rules: {
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    // The space fence has one spelling, and it is `space-condition.ts`.
    //
    // Written inline it was written differently in each store, and the
    // stores then disagreed about what an absent space means: most read
    // it as "every space", one key-store method read it as "the rows
    // with no space". A platform admin uninstalling a space's connection
    // resolved the connection under the first reading and looked for its
    // credentials under the second, so the revocation list came back
    // empty every time while the pipeline reported success. Nothing about
    // either spelling looks wrong on its own, which is why this is a lint
    // rule rather than a comment.
    //
    // Every store in both dialects, so a store added tomorrow is covered
    // by default. An allowlist of the five files the connection pipelines
    // happen to read would leave a new store outside the rule, which is
    // the likeliest way the divergence comes back: nobody adding a file
    // thinks to add it to a lint config. The nineteen stores that still
    // spell the fence inline — ten on Postgres, nine on SQLite — carry
    // a file-level disable saying so, and deleting one is how the next
    // batch gets normalized. None of them disagrees with the meaning the
    // helper settled on; they are unconverted, not divergent.
    //
    // What still slips past, stated because it is cheap to say and
    // expensive to discover: a fence built inside a `sql` template, a
    // column destructured out of its table object first, or a table
    // imported under another name. The rule reads the shape, not the
    // meaning.
    files: ["packages/server/src/storage/{pg,sqlite}/*.ts"],
    ignores: ["packages/server/src/storage/{pg,sqlite}/*.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.name=/^(eq|ne|isNull|isNotNull)$/] > MemberExpression[property.name='space_id']",
          message:
            "Build the space fence with spaceCondition / spaceBucketCondition / spaceOrPlatformCondition from storage/space-condition.js. Spelling it inline is how the stores came to disagree about what an absent space means.",
        },
      ],
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
      // Another repository's checkout, staged into the server image. It is
      // linted where it lives, and it is in no tsconfig project here.
      "integrations-src/",
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
