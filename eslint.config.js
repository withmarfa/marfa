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
            // The hosted deployment's shape. Evaluated by the Railway CLI
            // rather than built by any package here, so it sits under no
            // package tsconfig for the same reason the configs below do not.
            ".railway/railway.ts",
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
    // with no space". An operator uninstalling a space's connection
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
            "Build the space fence with a helper from storage/space-condition.js rather than spelling it inline, which is how the stores came to disagree about what an absent space means. Pick by the column: spaceCondition, spaceBucketCondition or spaceOrPlatformCondition for a nullable space_id, and spaceSentinelCondition for blobs, custom_types and custom_edge_types, whose space_id is NOT NULL DEFAULT '' — the other three emit IS NULL against those and match nothing, silently.",
        },
      ],
    },
  },
  {
    // The path tag is the mechanism, and a convention nobody enforces is the
    // shape the tag was written to replace. The change that introduced it
    // converted forty-seven request paths and missed the forty-eighth, which
    // is the existence proof: `blobs.url` built its URL by plain
    // interpolation and was found by review rather than by any check.
    //
    // The selector reads a template literal that has interpolations, is not
    // tagged, and whose first chunk opens with `/` — which is what a request
    // path looks like and what almost nothing else in this file does. It
    // cannot see a path assembled in pieces or built from a variable, so it
    // is a floor rather than a proof.
    files: ["packages/sdk/src/client.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "TemplateLiteral[expressions.length>0][quasis.0.value.raw=/^\\//]:not(TaggedTemplateExpression > TemplateLiteral)",
          message:
            "Build a request path with the `path` tag from ./path.js, which percent-encodes every interpolated segment. An unescaped `/`, `?` or `#` in an identifier addresses a route the caller did not name, and nothing throws. A query string is not a segment: keep it outside the tag and concatenate, as types.delete does.",
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
      "packages/*/scripts/*.mjs",
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
    ],
  },
];
