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

The simplest way to run the server is with SQLite (the default):

```bash
cd packages/server
pnpm dev
```

This starts the server on `http://localhost:8600` with a local SQLite database.

## Code style

- TypeScript strict mode, ESM-only
- Prettier with single quotes (run `pnpm format`)
- ESLint (run `pnpm lint`)
- Explicit `import type` for type-only imports
- File extensions required in imports (`.js` for TS files)
- Named exports only

## Commits

We use [Conventional Commits](https://www.conventionalcommits.org/) with package scope:

```
feat(server): add blob reconciliation endpoint
fix(sdk): handle timeout on large exports
chore(shared): bump zod dependency
```

Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`

## Pull requests

- One logical change per PR
- Run `pnpm test`, `pnpm lint`, and `pnpm typecheck` before submitting
- Squash merge by default

## Testing

```bash
pnpm test           # run all tests
pnpm test:watch     # watch mode
pnpm typecheck      # type-check all packages
pnpm lint           # lint
pnpm format:check   # check formatting
```

The server tests run against SQLite, locally and in CI.

## Conformance suite

The [conformance](https://github.com/withmarfa/conformance) repo contains the conformance test suite. To run it against a local server:

```bash
cd ../conformance
MARFA_API_URL=http://localhost:8600 MARFA_API_KEY=your-key pnpm test
```
