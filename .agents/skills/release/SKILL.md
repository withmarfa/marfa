---
name: release
description: Cut, check or repair a Marfa release. Tags the next 0.0.N on a green commit of main, follows release.yml job by job, checks the six release files, the server image, the npm packages and the Homebrew tap, and finishes a failed or partial run. Use when asked to release, tag a version, check a release, or fix a release run.
---

# Cut a Marfa release

A release is a git tag `v<version>` on a commit of `main`. Pushing the tag runs `.github/workflows/release.yml`, and nothing else publishes. A `workflow_dispatch` run of the same workflow with a `version` input is a dry run: it builds, signs and proves everything and publishes nothing.

## The version

- Every manifest in the tree carries `0.0.0`, and `ci/version-fields.test.ts` refuses any other. A version exists only as a tag. `release.yml` stamps it into every manifest in its own checkout with `scripts/release/stamp-version.sh`; never run that script in yours.
- The next version is the highest `v0.0.N` tag plus 0.0.1. `Read the version` accepts nothing else: it refuses any `major.minor` but `0.0`, so `v0.1.0` fails there today, and a patch below 70, the first release of the Rust server.
- Find the highest tag:

  ```bash
  git ls-remote --tags --refs origin 'refs/tags/v0.0.*' | sed 's#.*/v0\.0\.##' | sort -n | tail -1
  ```

## Before you tag

1. Choose the commit: the head of `origin/main`, or an earlier commit of `main` after the previous release.
2. Check that a `ci.yml` run on a push to `main` passed for that exact commit. `Require green CI` refuses a tag without one:

   ```bash
   gh run list --workflow ci.yml --commit <sha> --event push --json conclusion,headBranch
   ```

3. Check `core.yml` yourself, because the release does not: its live checks on macOS (the command line, the folder watch, the Swift package) run on a push to `main` in that workflow, not in `ci.yml`. Its `paths` filter skips some pushes; then the latest run on an earlier commit vouches for it. A failed or cancelled run means the commit is not ready.
4. Check that the previous tag is a published release, not a draft (`gh release view v0.0.<N-1> --json isDraft`). `Read the version` refuses a version whose predecessor is only tagged.
5. If the database schema (`core/marfa-server/src/db/migrations/`) or the archive layout changed since the previous release, write down what an owner must do before upgrading. Every release's notes start with the same `scripts/release/upgrade-note.md`, so add the words to this release's notes once it is public (step 4 of [Check the release](#check-the-release)).
6. To prove a change to the release itself or to the native pins before tagging, run a dry run on the commit and wait for it:

   ```bash
   gh workflow run release.yml --ref main -f version=<next version>
   ```

## Tag

```bash
git tag v<version> <sha>
git push origin v<version>
gh run list --workflow release.yml --limit 1
gh run watch <run id> --exit-status
```

## What release.yml does

Each job is named as GitHub shows it.

1. **Require green CI:** for a tag, a successful `ci.yml` run for the commit, from a push to `main` or a dispatch.
2. **Read the version:** the gate in [The version](#the-version). It also refuses a version when a higher one is released, and a commit that is not after the previous release's.
3. **Build the programs (macOS),** on `macos-26`: stamps the version, packs `@withmarfa/core` (the Apple silicon `.node` module) and `@withmarfa/client`, and builds `marfa` and `marfa-server` for `aarch64-apple-darwin` with `scripts/release/build-programs.sh`. Each program must report `<program> <version>`.
4. **Sign the programs:** signs both with the Developer ID under the hardened runtime and has Apple notarize them (`scripts/release/sign-binary.sh`, six `APPLE_*` secrets; a dry run signs too), packs `marfa-<version>-darwin-arm64.tar.gz`, boots it and reads a PDF and a picture with it (`check-archive.sh`, `prove-reading.sh`).
5. **Build the programs (x86_64 Linux)** and **(aarch64 Linux):** static musl builds in the pinned build image, packed as `marfa-<version>-linux-x86_64.tar.gz` and `marfa-<version>-linux-aarch64.tar.gz`. These programs are not signed.
6. **Run the programs (x86_64 Linux)** and **(aarch64 Linux):** each archive booted and reading files on a runner of its own architecture.
7. **Collect the release:** writes `marfa-<version>-checksums.txt` for the three archives and the Homebrew formula, and holds the release to six files: the three archives, the checksums and the two npm tarballs.
8. **Build the server image (linux/amd64)** and **(linux/arm64):** `deploy/Dockerfile` around the Linux archives' own programs, checked with `scripts/check-image.sh`. A tag run pushes each platform to `ghcr.io/withmarfa/marfa-server` by digest, untagged, and boots the pushed digest.
9. **Prove the install (darwin-arm64)**, **(linux-x86_64)** and **(linux-aarch64):** `scripts/release/install-proof.sh` installs through `scripts/install.sh` from the run's own files, behind HTTPS, claims the server, and runs it to uninstall. The modes are a user service on the Mac and on aarch64 Linux, and a root install and Docker on x86_64 Linux.
10. **Publish,** for a tag only: requires an npm that publishes by trusted publishing and npm's trust for this run; drafts the GitHub release with the six files and notes made of `scripts/release/upgrade-note.md` and the generated list of pull requests; checks the draft's archives against its checksums; tags the image `<version>` and `latest` and pulls it signed out; publishes `@withmarfa/core` and `@withmarfa/client` to npm with provenance; then makes the release public.
11. **Update the Homebrew tap,** for a tag only: writes `Formula/marfa.rb` for `withmarfa/homebrew-tap`, and pushes it only when the repository variable `HOMEBREW_TAP` is `publish`. Otherwise it writes the formula into the log, says it was not pushed, and passes.

## Check the release

1. The release is public and holds exactly the six files:

   ```bash
   gh release view v<version> --json isDraft,assets --jq '.isDraft, .assets[].name'
   ```

2. The image has both platforms, and `latest` is the same digest:

   ```bash
   docker buildx imagetools inspect ghcr.io/withmarfa/marfa-server:<version>
   docker buildx imagetools inspect ghcr.io/withmarfa/marfa-server:latest
   ```

3. Both packages are on npm: `npm view @withmarfa/client@<version> version` and `npm view @withmarfa/core@<version> version`.
4. If step 5 of [Before you tag](#before-you-tag) wrote anything, add it to the notes. `gh release edit --notes-file` replaces the whole body, so write the current body to a file first (`gh release view v<version> --json body --jq .body`), add the words, and edit with that file.
5. The tap: `gh variable list` shows whether `HOMEBREW_TAP` is `publish`, and the formula the tap holds names its version:

   ```bash
   gh api repos/withmarfa/homebrew-tap/contents/Formula/marfa.rb --jq .content | base64 -d | grep -m1 url
   ```

   When the variable is not `publish`, the tap stays at the last version it was given. Say so in the hand-back; it is not a failed release.

## Finish a failed or partial run

- **Before `Publish`,** nothing is public under the version: the image job pushes untagged digests only. Fix what failed outside the code (a runner, a secret, a network fault) and re-run the failed jobs with `gh run rerun <run id> --failed`. The build and signing artifacts are kept for one day; after that, re-run the whole run with `gh run rerun <run id>`.
- **In `Publish`,** each step skips what is already there: a draft is given only the files it lacks, an image version that exists is kept, and an npm version that exists is skipped. Re-run the job after fixing what its error names:
  - A new package on ghcr.io is private until it is made public in its package settings.
  - A package npm has never published needs its first version published by hand from the run's artifacts and a trusted publisher set to this repository and `release.yml`.
- **`Update the Homebrew tap`** fails when `HOMEBREW_TAP` is `publish` and the secret `HOMEBREW_TAP_TOKEN` is missing. Set it to a fine-grained token with Contents read and write on `withmarfa/homebrew-tap`, then re-run the job. If several releases' tap jobs failed, re-run them oldest first: the job does not refuse to move the formula back to an older version.
- **A fix that needs a code change** cannot reach a tag that already ran. `Read the version` refuses the next version while this one is tagged and not released, so stop and bring it to the owner.

## Never

- Never move or delete a `v*` tag once it is pushed, and never tag the same version on another commit. Nothing compares a draft's files with the commit: a run after the tag moved keeps the draft's files and the image version built from the first commit, and can publish npm packages built from the second, so one version ships builds of two commits.
- Never set a version in a manifest, a README or a commit to the tree.
- Never unpublish an npm version. npm does not take a version back for reuse, and the release then cannot publish that version again.
