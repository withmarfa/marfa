# Contributing

Thanks for your interest in contributing to Marfa.

## Setup

```bash
git clone https://github.com/withmarfa/marfa.git
cd marfa
pnpm install
pnpm test
```

## Running the server locally

The server runs on SQLite, which is the only database it has:

```bash
cd packages/server
pnpm dev
```

This starts the server on `http://localhost:8600` with a local SQLite database.

### Making the first key

Until the instance holds a credential, the server logs a one-time bootstrap secret at every boot. In a second terminal, build `marfa` and use the secret to mint the first key:

```bash
cargo install --locked --path core/marfa-cli
export MARFA_API_URL=http://localhost:8600
marfa keys bootstrap          # paste the secret from the server's log, then press Enter
```

The command prints the operator key. The operator key mints and revokes keys and is the instance's recovery root, so keep it somewhere safe. It reaches no type, so it is not a working key. Use it to mint a working key, then keep the working key in the keychain:

```bash
read -rs MARFA_API_KEY && export MARFA_API_KEY    # paste the operator key
marfa status                  # the server, the instance and its health; the counts need a working key
marfa keys create --label laptop --source laptop
unset MARFA_API_KEY
marfa keys keep               # paste the working key that keys create printed
marfa status                  # now with the item counts
```

On a system with no keychain, set `MARFA_API_KEY` to the working key and skip `marfa keys keep`.

The README's quick start creates the owner, which sign-in needs.

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
numbered statement can be green locally and red in CI without it.

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
