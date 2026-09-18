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
      // Build scripts in plain JavaScript; they are in no tsconfig project.
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
      // The Rust core workspace; its Node binding is linted where it lives.
      "core/",
      // The conformance suite, which is held by `tsc --noEmit` and Prettier
      // rather than by this config.
      //
      // Two reasons, and the first is the load-bearing one. A black-box
      // suite asserts over what a server sent, not over what a type says it
      // must have sent; its client types are hand-written declarations of
      // what the contract claims, so the checks that `no-unnecessary-
      // condition` and `no-unnecessary-type-assertion` call redundant are
      // exactly the ones a referee should keep. Linting it under
      // `strictTypeChecked` would delete assertions in the name of tidiness.
      //
      // The second is that the suite arrived written against a different
      // config, and the difference is style: 148 of its 341 reports were
      // `${count}` where this config wants `String(count)`. Rewriting a
      // fixture corpus whose readability is the specification, to satisfy a
      // preference, is a poor trade.
      "conformance/",
    ],
  },
];
