# Contributing

Thanks for your interest in contributing to Marfa.

Most changes to this repository are made by coding agents, and the rules they follow are the rules for everyone. They are in [`AGENTS.md`](./AGENTS.md), with more for each area in the `AGENTS.md` file of that folder.

## Propose a change

1. Open an issue that says what is wrong or missing, and for whom.
2. Make the change on a branch and open a pull request as a draft. Its body carries the sections Summary, Changes, Testing, Notes for reviewers and Checklist.
3. A change to what Marfa does and the change to the contract that states it go in the same pull request. The contract is in [`conformance/spec/`](./conformance/spec/README.md).

## Set up

```bash
git clone https://github.com/withmarfa/marfa.git
cd marfa
pnpm install
pnpm build
pnpm test
```

The Rust code is under [`core/`](./core/README.md), and `core/AGENTS.md` has its commands.

## Report a security problem

Do not open a public issue for a weakness someone could use. Report it privately through the repository's Security tab.
