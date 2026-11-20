---
name: release
description: Cut, check or repair a Marfa release. Tags the next version on a green commit of main, follows release.yml job by job, checks the five release files, the server image, the npm package and the Homebrew tap, and finishes a failed or partial run. Use when asked to release, tag a version, check a release, or fix a release run.
---

# Cut a Marfa release

A release is a git tag `v<version>` on a commit of `main`. Pushing the tag runs `.github/workflows/release.yml`, and nothing else publishes. A `workflow_dispatch` run of the same workflow with a `version` input is a dry run: it builds, signs ad hoc, and proves everything, and publishes nothing. The Developer ID, the tap token and npm's trust belong to the `release` environment, which only a `v*` tag can use, so a dry run neither signs with the Developer ID nor notarizes.

## The version

- Every manifest in the tree carries `0.0.0`, and `ci/version-fields.test.ts` refuses any other. A version exists only as a tag. `release.yml` stamps it into every manifest in its own checkout with `scripts/release/stamp-version.sh`; never run that script in yours.
- The next version is the highest released `v*` tag plus a patch (`0.1.3` then `0.1.4`), or the next minor at patch 0 (`0.1.3` then `0.2.0`), which is for a breaking change. `Read the version` accepts nothing else. It refuses a version that goes back, skips one, repeats a released one, or has a major above 0 (a `1.x` needs the gate changed on purpose). The first `v0.1.0` follows the last `0.0.N` this way, and no `0.0.N` is released after it.
- Find the highest tag (a version in `scripts/release/abandoned-versions` is tagged but never released, so the gate passes over it and the previous release is the highest tag not listed there):

  ```bash
  git ls-remote --tags --refs origin 'refs/tags/v*' | sed 's#.*/v##' | sort -V | tail -1
  ```

## Before you tag

1. Choose the commit: the head of `origin/main`, or an earlier commit of `main` after the previous release.
2. Check that a `ci.yml` run on a push to `main` passed for that exact commit. `Require green CI` refuses a tag without one:

   ```bash
   gh run list --workflow ci.yml --commit <sha> --event push --json conclusion,headBranch
   ```

3. Check that `core.yml` passed for the commit. `Require green Core` refuses a tag without it. The live checks on macOS (the command line, the folder watch, the Swift package) run in `core.yml` on a push to `main` that touches the core, and its `paths` filter skips other pushes. A commit with no run of its own is vouched for by the nearest earlier run on `main`, when no commit since changed a path the filter lists. A run that failed, was cancelled or timed out, or is still running, refuses the release, and so does a comparison that fails for any reason but a 404 (re-run the job); for a run still going, wait for it and re-run the job:

   ```bash
   gh run list --workflow core.yml --branch main --json headSha,status,conclusion,createdAt --limit 10
   ```

4. Check that the previous tag is a published release, not a draft (`gh release view v<previous version> --json isDraft`). `Read the version` refuses a version whose predecessor is only tagged and not listed in `scripts/release/abandoned-versions`, or that is itself released already.
5. If the database schema (`core/marfa-server/src/db/migrations/`) or the archive layout changed since the previous release, write down what an owner must do before upgrading. Every release's notes start with the same `scripts/release/upgrade-note.md`, so add the words to this release's notes once it is public (step 4 of [Check the release](#check-the-release)).
6. The contract version is the integer in `info.version` of `openapi.json`, and it changes only with a break. Change it in a pull request merged before step 1, so the commit you tag and its CI run carry it: for the release that cuts `v0.1.0`, set it to 1 and run `pnpm generate`, and for a new minor that breaks compatibility, raise it by one the same way.
7. To prove a change to the release itself or to the native pins before tagging, run a dry run on the commit and wait for it:

   ```bash
   gh workflow run release.yml --ref main -f version=<next version>
   ```

   A dry run signs ad hoc, so it cannot catch a fault in the Developer ID, the `APPLE_*` secrets or notarization. If a tag run fails in `Sign the programs`, nothing is public: fix the secret or the identity in the `release` environment and re-run the failed jobs (see [Finish a failed or partial run](#finish-a-failed-or-partial-run)). A fault in the signing script itself needs a code change, which cannot reach that tag.

## Tag

A ruleset lets only a repository admin create a `v*` tag, so push the tag from an admin account. GitHub then reports the push as bypassing the ruleset's creation rule ("Bypassed rule violations"), which is expected. A second ruleset refuses moving or deleting a `v*` tag, for everyone.

```bash
git tag v<version> <sha>
git push origin v<version>
gh run list --workflow release.yml --limit 1
gh run watch <run id> --exit-status
```

## What release.yml does

Each job is named as GitHub shows it.

1. **Require green CI** and **Require green Core:** for a tag, a successful `ci.yml` run for the commit on `main`, from a push or a dispatch (a dry run accepts a green run of any event), and a successful `core.yml` run for it or for the nearest run before it with no core change since (`scripts/release/require-core-run.sh`).
2. **Read the version:** the gate in [The version](#the-version). It also refuses a version when a higher one is released, and a commit that is not after the previous release's.
3. **Build the programs (macOS),** on `macos-26`: stamps the version, packs `@withmarfa/client`, and builds `marfa` and `marfa-server` for `aarch64-apple-darwin` with `scripts/release/build-programs.sh`. Each program must report `<program> <version>`.
4. **Sign the programs:** signs both with the Developer ID under the hardened runtime and has Apple notarize them (`scripts/release/sign-binary.sh`, six `APPLE_*` secrets, which belong in the `release` environment; a dry run signs ad hoc, with no identity and no notarization), packs `marfa-<version>-darwin-arm64.tar.gz`, boots it and reads a PDF and a picture with it (`check-archive.sh`, `prove-reading.sh`).
5. **Build the programs (x86_64 Linux)** and **(aarch64 Linux):** static musl builds in the pinned build image, packed as `marfa-<version>-linux-x86_64.tar.gz` and `marfa-<version>-linux-aarch64.tar.gz`. These programs are not signed.
6. **Run the programs (x86_64 Linux)** and **(aarch64 Linux):** each archive booted and reading files on a runner of its own architecture.
7. **Collect the release:** writes the three archives' checksums to `marfa-<version>-checksums.txt`, writes the Homebrew formula from them, and holds the release to five files: the three archives, the checksums and the `@withmarfa/client` tarball.
8. **Build the server image (linux/amd64)** and **(linux/arm64):** `deploy/Dockerfile` around the Linux archives' own programs, checked with `scripts/check-image.sh`. A tag run pushes each platform to `ghcr.io/withmarfa/marfa-server` by digest, untagged, and boots the pushed digest.
9. **Prove the install (darwin-arm64)**, **(linux-x86_64)** and **(linux-aarch64):** `scripts/release/install-proof.sh` installs through `scripts/install.sh` from the run's own files, behind HTTPS, claims the server, and runs it to uninstall. The modes are a user service on the Mac and on aarch64 Linux, and a root install and Docker on x86_64 Linux.
10. **Publish,** for a tag only: requires an npm that publishes by trusted publishing and npm's trust for this run; drafts the GitHub release for this commit (`--target`) with the five files and notes made of `scripts/release/upgrade-note.md` and the generated list of pull requests; checks the draft's archives against its checksums; tags the image `<version>` and `latest`, attests the archives, the checksum file and the image (the index and each platform) with GitHub build provenance, and pulls the image signed out; publishes `@withmarfa/client` to npm with provenance; then makes the release public.
11. **Update the Homebrew tap,** for a tag only: writes `Formula/marfa.rb` for `withmarfa/homebrew-tap`, and pushes it only when the repository variable `HOMEBREW_TAP` is `publish`. Otherwise it writes the formula into the log, says it was not pushed, and passes.

## Check the release

1. The release is public and holds exactly the five files:

   ```bash
   gh release view v<version> --json isDraft,assets --jq '.isDraft, .assets[].name'
   ```

2. The image has both platforms, and `latest` is the same digest:

   ```bash
   docker buildx imagetools inspect ghcr.io/withmarfa/marfa-server:<version>
   docker buildx imagetools inspect ghcr.io/withmarfa/marfa-server:latest
   ```

   Both are attested. Verify one archive, the checksum file and the image the way [deploy/README.md](../../../deploy/README.md#verify-a-download) tells a person to, with `--source-ref refs/tags/v<version>`:

   ```bash
   gh release download v<version> --pattern 'marfa-<version>-*' --dir <empty folder>
   gh attestation verify <empty folder>/marfa-<version>-linux-x86_64.tar.gz --repo withmarfa/marfa \
     --signer-workflow withmarfa/marfa/.github/workflows/release.yml --source-ref refs/tags/v<version>
   gh attestation verify oci://ghcr.io/withmarfa/marfa-server:<version> --repo withmarfa/marfa \
     --signer-workflow withmarfa/marfa/.github/workflows/release.yml --source-ref refs/tags/v<version>
   ```

3. The package is on npm: `npm view @withmarfa/client@<version> version`.
4. If step 5 of [Before you tag](#before-you-tag) wrote anything, add it to the notes. `gh release edit --notes-file` replaces the whole body, so write the current body to a file first (`gh release view v<version> --json body --jq .body`), add the words, and edit with that file.
5. The tap: `gh variable list` shows whether `HOMEBREW_TAP` is `publish`, and the formula the tap holds names its version:

   ```bash
   gh api repos/withmarfa/homebrew-tap/contents/Formula/marfa.rb --jq .content | base64 -d | grep -m1 url
   ```

   When the variable is not `publish`, the tap stays at the last version it was given. Say so in the hand-back; it is not a failed release.

6. Stop. Publishing starts WithMarfa's release automation, which writes the release notes, syncs and rewrites the docs from the open docs issues, and moves the Swift package and the connectors to the release. Do none of these yourself.

## Finish a failed or partial run

- **Before `Publish`,** nothing is public under the version: the image job pushes untagged digests only. Fix what failed outside the code (a runner, a secret, a network fault) and re-run the failed jobs with `gh run rerun <run id> --failed`. The build and signing artifacts are kept for one day; after that, re-run the whole run with `gh run rerun <run id>`.
- **In `Publish`,** each step skips what is already there: a draft is given only the files it lacks, an image version that exists is kept, and an npm version that exists is skipped. A draft and an image are kept only when they were built from this run's commit: the draft's `targetCommitish` and the image's `org.opencontainers.image.revision` label are compared with it, before anything is uploaded, tagged or published to npm. Re-run the job after fixing what its error names:
  - A draft made for another commit (or by an earlier workflow, which recorded none) is refused. Delete it with `gh release delete v<version>`, which keeps the tag, and re-run the whole run so the files are built again.
  - An image tag built from another commit is refused. Delete that version of the `marfa-server` package in its settings on GitHub, then re-run the job.
  - A new package on ghcr.io is private until a maintainer makes it public in its package settings.
  - A package npm has never published stops the job before anything is published. Its first version is published by hand from the run's artifacts, with a trusted publisher set to this repository, `release.yml` and the environment `release`: that is a maintainer's step, so stop and say so; never publish it yourself.
- **`Update the Homebrew tap`** fails when `HOMEBREW_TAP` is `publish` and the secret `HOMEBREW_TAP_TOKEN` is missing. Set it, as a secret of the `release` environment (until it is moved there, a repository secret also reaches other workflows), to a fine-grained token with Contents read and write on `withmarfa/homebrew-tap`, then re-run the job. If several releases' tap jobs failed, re-run them oldest first: the job does not refuse to move the formula back to an older version.
- **A re-run of `Publish`** attests again, which adds attestations and removes none; a file or digest then has more than one, all from this repository's workflow.
- **A fix that needs a code change** cannot reach a tag that already ran. `Read the version` refuses the next version while this one is tagged and not released. Abandon the version instead: in a pull request, add it to `scripts/release/abandoned-versions` with the reason, merge the fix, and tag the next version on a green `main`. Nothing for the abandoned version may already be public.

## Never

- Never move or delete a `v*` tag once it is pushed, and never tag the same version on another commit. `Publish` refuses a draft, or a `<version>` image, built from another commit than the run's, but it cannot undo what npm already holds: a version published from the first commit stays, and the release then cannot publish that version again.
- Never set a version in a manifest, a README or a commit to the tree.
- Never unpublish an npm version. npm does not take a version back for reuse, and the release then cannot publish that version again.
