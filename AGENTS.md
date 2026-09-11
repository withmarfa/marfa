# Marfa

Typed data layer. This monorepo holds the workspace packages and the sample apps under `examples/`. The hosted deployment is a container image built by `deploy-server.yml` and run on a platform, so it has no shape checked in here; `docker-compose.yml` at the root is the self-hosting one and is a shipped feature rather than this deployment's path.

**Query the docs MCP before reading source** on any documented surface: types, edges, runtime substrates, connections, auth flows. `https://docs.marfa.so/mcp`, or `marfa docs search "<query>"` from the CLI.

**Published docs live only in `withmarfa/docs`.** Never author docs pages here. In-repo READMEs stay tight; `AGENTS.md` carries agent and build context. A change touching a public surface opens a companion docs pull request as part of the same change.

## Packages

- **`types`** holds the JSON schemas for the platform-shipped type set, the validator both authoring paths share, and the generator that emits the TypeScript registries. Private; bundled into `shared`.
- **`shared`** holds the wire types, validation schemas, error codes, ID utilities, the OAuth scope grammar, the integration manifest schema. Every other package imports it.
- **`server`** is the Hono HTTP server. Private; deployments build from source.
- **`sdk`** is the TypeScript HTTP client. `sdk/auth` holds the OAuth helpers; `sdk/auth/node` holds the Node-only credential store, kept separate so browser bundlers never see `node:fs`.
- **`webhooks`** does inbound signature verification, Web Crypto only.
- **`runtime-sdk`** is the SDK Integrations consume: dispatch engine, per-connection state, echo suppression.
- **`runtime-test`** is an in-memory harness mirroring that surface, so an Integration can unit-test handlers without booting the server.
- **`sync-manifest`** is the manifest the sync client installs against. Private, and not an Integration for the reason below.

**Where the code has to run decides whether something is an Integration.** An Integration is installed into a deployment's integrations directory and dispatched by the runtime. A client's code can only run elsewhere: sync watches a filesystem, so it runs on the machine holding the files, ships a manifest and no handler, and that manifest ships with the server build rather than being installed. Installing as a Connection, with credentials, configuration and observability, is plumbing both kinds share and decides nothing.

**Integrations live in `withmarfa/integrations`.** The server image installs the set `packages/server/installed-integrations.txt` declares, built from the commit `packages/server/integrations-ref.txt` pins. A registry entry merged there changes nothing here until the pin moves, which is the point: the image build holds the declared set to the registry at the pinned commit, and it is the only place both are readable.

**Publishing is sequential and the order is load-bearing.** `publish.yml` fires on `v*` tags and packs `shared`, `sdk`, `runtime-sdk`, `runtime-test`, `webhooks` in that order, because `pnpm pack` resolves a `workspace:*` dependency to a concrete version and packing before that version exists on the registry produces a tarball nobody can install. `sdk` sits in the middle and is easy to leave out of a mental model of the chain: `runtime-sdk` depends on it.

## Dev commands

```bash
pnpm install
pnpm build            # all packages
pnpm typecheck
pnpm test             # full SQLite suite, single run
pnpm test:changed     # tests for files changed against origin/main
pnpm test:related …   # tests depending on the listed source files
pnpm test:fresh-sqlite
pnpm test:pg          # boots a throwaway postgres:17 plus a pooler
pnpm test:full        # the whole dual-dialect matrix
pnpm lint / lint:fix / format / format:check
```

Regenerating committed artifacts:

```bash
pnpm --filter @withmarfa/types generate
pnpm --silent --filter @withmarfa/server generate:openapi > openapi.json
pnpm --filter @withmarfa/server schema-sql:generate
```

**A worktree that rebases `main` and picks up a new workspace package needs a plain `pnpm install`.** `--frozen-lockfile` is a near-instant no-op when the lockfile hash is unchanged, so the new package's `node_modules/.bin` symlinks are never linked and the first build fails with `tsup: command not found` from inside it. `verifyDepsBeforeRun: error` fast-fails with `ERR_PNPM_VERIFY_DEPS_BEFORE_RUN` before any script runs. Do not bypass with `--no-verify`: the state change is real and the install is the fix.

## Before pushing

- **The pre-push hook is slim and deliberately so.** Build, typecheck, lint, format check and `test:changed`, SQLite only, targeting sub-thirty seconds. A hook running the full matrix invites `--no-verify`, and a bypassed hook is not a gate.
- **`ci.yml` is the authoritative run** and decides mergeability: the full dual-dialect matrix on every pull request.
- **Run `pnpm test:full` locally before pushing, not the hook.** It covers both dialects against a throwaway container and catches essentially everything CI would. The hook has already gone green on a commit whose Postgres job failed.
- **Batch the work.** A whole matrix fires on every push to a pull request, and several tests fail on a fixed time budget, so pushing after each commit multiplies the load for no extra signal.
- **Never re-run CI to see whether a failure repeats.** Reproduce it locally. If it genuinely looks environmental, say so with the evidence.

**`deploy.sh` at the root is a shipped self-hosting feature, not this deployment's path.** It deploys over SSH into a source checkout run as a supervised service, and the self-hosting deployment page documents it along with its `DEPLOY_SERVICE_*` variables. Hosted Marfa deploys through `deploy-server.yml` to containers instead, so nothing here exercises the script and it reads as dead. It is not: deleting it breaks a documented path.

## Schema and generated artifacts

Migrations, the journal-stamp trap and the migrate-then-deploy ordering rule live in `packages/server/AGENTS.md`, which is where the work happens.

**Three freshness jobs regenerate a committed artifact and fail on drift**: types codegen, the OpenAPI spec and the bootstrap `SCHEMA_SQL`. They are ordinary pull-request checks with nothing to fire by hand, each gated on the paths that can actually stale its artifact, and each path set covers the generated file as well as its sources, because a hand-edit of a generated file is itself the defect, and without that a pull request touching only the output would run no check at all. `ci.yml`'s `changes` job holds the same lists; keep the two in step.

**Narrowing a contract that stored rows already match has no grace period unless you write one.** Several contracts here are validated against stored data on every read rather than only at write, the integration manifest most of all: re-parsed on every resolution, strictly, with a credential's permissions projected from the result, and a mint that fails closed. So a resolution failure is a stop rather than a degradation.

- **Enumerate everything the change tightens, not the thing that prompted it:** the field or shape itself, the schema **version gate** if the change moves a major, any **strictness** that now rejects what the old shape carried, and any **second validator** over the same document.
- **Then replay the new validator over real stored rows before trusting the tolerance.** Removing one required field shipped with a deliberate tolerance for that field, written by someone who knew the hazard; but dropping a required field is not additive, so the same change moved the major and the version gate then refused every row written under the old one. The tolerance covered a third of what the change did, which reads exactly like covering all of it until deploy.

## CI

Most workflows route `runs-on` through the `CI_RUNNER` Actions variable. Publish, deploy, provenance and notifier jobs are explicitly hosted.

- **A red `main` is a test failure or an abandonment, and they mean opposite things.** A failure says the commit is bad; an abandonment says nothing about it, and every later pull request is then measured against a baseline nobody has information about. The distinction is clean through the API and nothing computes it for you: an abandoned job has no step whose conclusion is `failure` and at least one `cancelled`, while a genuine failure has exactly one failing step.
- **The image build runs on merges to `main` and throws the image away.** It is the only job here that exercises the amd64 target, the lockfile install, the integration staging step and the runtime layout, and before it existed the first report of a break was a failed deploy on a green `main`. It is hosted, because the pool is arm64 and emulated cross-building is far slower, and it lives in its own workflow rather than in `ci.yml` so that a merge landing inside the build window cannot cancel the previous merge's build.
- **The pool canary reads `self-hosted` literally and must never read `vars.CI_RUNNER`.** Routed through the variable it would report the pool healthy from a hosted runner, which answers a different question than the one it is named for. It exists because a pool failing every job produces the same bytes as a pool with no work: everything else reports some workflow's own outcome, and a workflow nobody triggered has no outcome to report.
- **The dependency cache is allowed on `ubuntu-*` and `blacksmith-*` and nothing else**, resolved per job from its own `runs-on`. A label nobody recognises gets no cache, and the asymmetry is the reason: a missing cache costs one slow install, while a cache enabled on the self-hosted pool tars a large store on a machine every pull request shares, arriving as other people's tests timing out. `macos-` is absent deliberately, because a pool that happens to run macOS would prefix-match it. Keep a pool label clear of both allowed prefixes. `ci/cache-rule.test.ts` holds every copy, and a green run proves none of it, because on the pool both the old rule and the current one resolve to no cache.
- **Only the scheduled workflows notify**, because a push-triggered run has an audience and a scheduled one has none. The notifier states the finding rather than the exit code, so the checking job declares outputs and the notifier reads them.
- **Three properties make that work and none produces an error when undone.** The step writing `$GITHUB_OUTPUT` runs on `if: always()`, or the detail is missing exactly when the alert is worth sending. `STATE=resolved` is reachable only from an explicit verdict, so a step dying anywhere reports `inconclusive` rather than closing an alert about a condition nothing re-tested. And a finding is written before the exit that follows it.
- **`key` is `github/$REPO/$WORKFLOW`, and `github.workflow` is the display name.** Renaming `name:` re-keys every alert from that workflow: whatever is open under the old key never resolves.

## Test infrastructure owns what it creates

Every machine resource a test or script allocates is released by the same code, on every exit path including failure. The failure mode is invisible by design: nothing breaks when a resource leaks, so the cost surfaces later as somebody else's slow CI or full disk. `docker rm` on a container that mounted an anonymous volume takes `-v`, or the volume outlives it with nothing left to reference it.

**The exit paths are the easy half; the signal path reads as covered and is not.** A trap naming `EXIT INT TERM` looks complete and still leaked, because bash defers a trap until the foreground command finishes, and the runner's kill arrives ten seconds after its first signal. A script that starts anything needs all three of:

- **Background the long-running command and `wait` on it.** `wait` is interruptible; a foreground child is not. Give it its own process group so cleanup can signal the whole tree, since `pkill -P` reaches the direct child only.
- **Signal handlers exit; the `EXIT` trap cleans up.** A handler that returns resumes the script where it was interrupted. Trap `HUP` too: a runner ending its session sends it, and an untrapped fatal signal runs no `EXIT` trap.
- **Disarm inside the cleanup**, so a second signal during teardown cannot re-enter and abandon it half-done.

## Data model

- **One validator across both authoring paths.** `validateTypeSchema` in `@withmarfa/types` is called by the in-tree codegen and by `POST /types` alike, so an in-tree JSON schema is a valid runtime submission verbatim.
- **Three families ship with the platform**, core, integration and system, all registering into one registry and resolving identically. The split is provenance, not behaviour: it exists so a catalog can tell a space which types are the common vocabulary and which exist because a specific upstream service does. Platform-shipped types cannot be modified or deleted through the API.
- **Inheritance:** a child may add fields, and may re-state an inherited field only to sharpen its description or tighten it to required. Changing an inherited field's shape, or loosening a required one, is refused.
- **Lifecycle is universal.** The metadata-layer `state` axis is `active | archived | trashed`; types do not declare their own state machines.
- **Constrain an edge on a role whenever the set of valid endpoints is open.** A list of type names admits only what whoever wrote the edge had already thought of, and nobody outside this repository can add to it: `in-collection` named three platform containers and left every integration writing its own vocabulary with nothing it was allowed to point at. Roles are a closed set declared per type and inherited down the parent chain, and both authoring paths refuse an unknown one.
- **Edge direction is spec-exact.** For `parent-of`, source is the parent; for `in-thread`, source is the member. Every consumer obeys this.
- **Custom edge types are space-scoped**, so two spaces may register the same id independently. Core types are global and cannot be redefined.

## Permissions

Every credential, key or sign-in alike, carries one permission set: the content maps plus the space permissions. Nothing exceeds its creator's set at the moment of creation, and no door admits on who the caller is. The model is documented in the vault and on the docs site; `packages/server/AGENTS.md` carries what breaks silently.

- **Edge mutations dual-gate:** write on the source item's type **and** write on the edge type.
- **New credentials default to no edge access.** It is opt-in and callers must grant it explicitly.
- **Scope grammar is `<type>:<verb>`, `edge.<type>:<verb>`, `metadata[.<subresource>]:<verb>`**, plus the verb-less OIDC literals and `space.<surface>`, a closed set naming the administrative surfaces. `parseScope` in `@withmarfa/shared` is the parser.

## Code style

- **American English**: color, organization, favorite. Code, comments, commits and docs alike.
- **ESM-only**, `import`/`export` and never `require()`; explicit `import type`; file extensions in imports (`.js` for TS files, per NodeNext).
- **Prefer `interface` over `type` for object shapes**, `unknown` over `any`, named exports only.
- **`MarfaError` in `@withmarfa/shared` is the base error class**, with an `ErrorCode` and its HTTP status.

### Boolean naming

Name a boolean so it reads as a yes or no. Three valid shapes, and a bare noun is none of them.

- **Bare** for adjectives and participles: `active`, `verified`, `disabled`, `succeeded`.
- **Prefixed** for state and possession: `is_` for state, `has_` for possession.
- **Verb-led** for action directives: `force_`, `skip_`, `enable_`, where a state prefix would misdescribe it.

### One word: "space"

An isolated data boundary is a **space**, in code, in schemas, in database columns, on the wire and in anything a person reads. There is no second term and no translation step. Not "instance", which is a server deployment, and not "workspace", which oversells the team angle. The old term survives in applied migrations and commit history, both immutable; anywhere else it is a missed rename.

## Comments

Comments are self-contained and make sense to anyone reading this repository cold. Explain _why_ (the decision, constraint or non-obvious trade-off), not the _what_, which the code already states. Never reference internal trackers, ticket numbers or project phases. If a comment does not earn its place by capturing intent, delete it.

## Commits

Conventional Commits with package scope: `feat(shared):`, `fix(server):`, `test(sdk):`.
