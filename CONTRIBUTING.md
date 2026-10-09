# Contributing

Thanks for your interest in contributing to Marfa.

## Setup

```bash
git clone https://github.com/withmarfa/marfa.git
cd marfa
pnpm install
pnpm build
pnpm test
```

## Running the server locally

The server runs on SQLite, which is the only database it has:

```bash
cd packages/server
export MARFA_AUTH_SECRET="$(openssl rand -hex 32)"
pnpm dev
```

This starts the server on `http://localhost:8600` with a local SQLite database.

### Claiming the instance and making a key

Open `http://localhost:8600/setup` and enter the code from the server's terminal to create the owner. Alternatively, from a second terminal at the repository root, claim it through the private socket:

```bash
cargo install --locked --path core/marfa-cli
unset MARFA_API_URL MARFA_API_KEY
marfa_socket="$(pwd -P)/packages/server/data/control/marfa.sock"
marfa --socket "$marfa_socket" setup claim --email owner@example.com
```

The command prompts for the password without echoing it. `setup claim --stdin` instead accepts a JSON object containing `email`, `password` and optional `name`. A remote claim uses `--url https://marfa.example.com setup claim --email owner@example.com` and prompts for both password and setup code; its JSON input also requires `code`. Supply secrets through the prompt or standard input, never command-line arguments.

The socket command must run under the server's operating-system account. Linux requires the `acl` package. `--socket` cannot be combined with `--url`, `--key`, `MARFA_API_URL` or `MARFA_API_KEY`, and an unavailable socket never falls back to HTTP or the keychain.

Sign in at `http://localhost:8600/auth/sign-in` and open `/auth/owner/manage` to create a key with the access you need. To create a content key from the machine instead:

```bash
marfa --socket "$marfa_socket" keys create --label laptop --source laptop \
  --type-permission '*=write' --edge-permission '*=write' \
  --metadata-permission '*=write' --extension-permission '*=write' \
  --profile-permission '*=write'
export MARFA_API_URL=http://localhost:8600
marfa keys keep    # paste the returned key on standard input
marfa status
```

The key has the five maps named above and no additional permissions. Use narrower maps for an app that needs only part of the dataset. Add named permissions only when needed; [the glossary](./GLOSSARY.md#permissions) lists all twelve. `keys.mint` permits delegation within the caller's own access; `keys.manage` permits key administration but does not grant content access or unrestricted minting.

On a system without a keychain, supply the ordinary key through `MARFA_API_KEY` and skip `keys keep`. Owner password recovery requires the private socket; see [Recovering the owner](./deploy/README.md#recovering-the-owner). Creating or changing keys through an owner browser session requires a password sign-in within the last five minutes.

## Code style

- TypeScript strict mode, ESM-only
- Prettier on its defaults, no config file (run `pnpm format`)
- ESLint (run `pnpm lint`)
- Explicit `import type` for type-only imports
- File extensions required in imports (`.js` for TS files)
- Named exports only

## Commits

We use [Conventional Commits](https://www.conventionalcommits.org/) with package scope:

```
feat(server): serve a blob by a signed link
fix(client): handle timeout on large exports
chore(shared): bump zod dependency
```

Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`

## Pull requests

- One logical change per PR
- Run `pnpm test`, `pnpm lint`, and `pnpm typecheck` before submitting
- Squash merge by default

## Testing

```bash
pnpm test           # every package, plus the checks over `ci/`
pnpm test:watch     # watch mode
pnpm typecheck      # type-check all packages
pnpm lint           # lint
pnpm format:check   # check formatting
```

`pnpm test` does **not** run the conformance suite's offline lane, which
checks the specification's citations, the coverage table and the generators
against the tree. Run it from `conformance/`:

```bash
cd conformance
pnpm test:generators
```

It needs no server, and CI runs it as a step of the conformance job before
booting anything — so a change to a spec chapter, a fixture title or a
statement can be green locally and red in CI without it.

## Releases

A release is a git tag, each the previous plus 0.0.1. `.github/workflows/release.yml` stamps it into every manifest, which otherwise carries `0.0.0`, then builds the `marfa` binary, `@withmarfa/core` and `@withmarfa/client`, publishes the packages and attaches all three artifacts to a GitHub release. The Swift package lives in [`withmarfa/marfa-swift`](https://github.com/withmarfa/marfa-swift).

## Conformance suite

`conformance/` holds the black-box suite and the written specification the server is held to. It boots the server in this checkout itself:

```bash
cd conformance
pnpm marfa:up
set -a; . .marfa-state/env; set +a
pnpm test:conformance
pnpm marfa:down
```

See [`conformance/README.md`](./conformance/README.md) for the individual lanes and the load profiles.

A change to what the server does and the change to the contract that admits
it belong in the same pull request. Where a document and the server
disagree, the server is right.
