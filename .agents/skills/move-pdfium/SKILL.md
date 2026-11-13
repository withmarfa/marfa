---
name: move-pdfium
description: Move Marfa's pinned PDFium to a newer chromium release. Use when the weekly pdfium-upkeep workflow has pushed the branch automation/pdfium-chromium-<N> and opened or edited the issue "Move PDFium to chromium/<N>", or when asked to move PDFium or pdfium-render.
---

# Move PDFium to a newer chromium release

File reading pins PDFium, which reads untrusted files, in `core/marfa-enrichment/native/manifest.txt`. Each week `.github/workflows/pdfium-upkeep.yml` runs `scripts/prepare-pdfium-move.sh`. Once the newest `bblanchon/pdfium-binaries` release is at least 28 days newer than the pinned one, the script:

- pushes the branch `automation/pdfium-chromium-<N>`, one commit on the `main` of that day (`chore(core): move PDFium to chromium/<N>`) that changes only the manifest: the `pdfium-binaries` archive line, the `pdfium` git line, and the release number in the comments about PDFium;
- opens the issue `Move PDFium to chromium/<N>`, labeled `core`, or edits the open issue whose title starts `Move PDFium to`.

It opens no pull request, because GitHub Actions may not open one in this repository and one opened with the workflow's token would start no CI. A session opens it, and the `Core native (x86_64 Linux)` job decides whether the move holds.

## Steps

1. Read the issue, then fetch the branch and check that it changes only the manifest:

   ```bash
   git fetch origin main automation/pdfium-chromium-<N>
   git diff --stat origin/main...origin/automation/pdfium-chromium-<N>
   ```

2. Open the pull request from the branch, with the template's sections (`Summary`, `Changes`, `Testing`, `Notes for reviewers`, `Checklist`) and `Closes #<issue>` in the body, then mark it ready. A draft runs only the quick jobs, so the native job runs only once the pull request is ready.

   ```bash
   gh pr create --base main --head automation/pdfium-chromium-<N> \
     --title "chore(core): move PDFium to chromium/<N>" --body-file <file>
   gh pr ready <number>
   ```

3. Wait for the run. A change under `core/marfa-enrichment/native/` runs `Core native (x86_64 Linux)`, `Server image` and `Rust server (release build)`. The native job builds PDFium, Leptonica and Tesseract from the pins with `native/release.sh x86_64-unknown-linux-musl --full`, runs the file matrix, checks the sandbox and fuzzes the reader. Its cache is keyed by the pins, so the first build of a new pin starts cold.
4. If the native job fails, read why before changing anything:
   - **`pdfium-render` has no API for this PDFium:** the static link fails. `pdfium-render` in `core/marfa-enrichment/Cargo.toml` names the newest PDFium API its bindings carry as a feature, `pdfium_<API>`, and the comment above the `pdfium-binaries` line in the manifest says which. Move `pdfium-render` to a release that carries a feature for this PDFium, or the newest one at or below it, change the feature, update the lockfile from `core/` (`cargo update -p pdfium-render`), and correct the manifest comment.
   - **`could not apply` a patch:** bblanchon's build steps changed under `native/patches/pdfium-steps.patch`. Make the patch apply to the new steps and keep what it does.
   - **A case of the matrix or the fuzzer fails:** find the cause in the new PDFium and fix it. Never change a case's expectation to accept a new reading of a file.

   Make these changes on a branch of your own (`git worktree add .claude/worktrees/pdfium-<N> -b core/pdfium-chromium-<N> origin/main`, then `git cherry-pick` the branch's commit). Never push to the automation branch: the next weekly run force-pushes it. Open the pull request from your branch, link the issue, and close the first pull request.

5. Prove the other platforms. No pull request job builds PDFium for macOS or aarch64 Linux; only `release.yml` does. Run a dry run of the release on the pull request's branch once its CI has passed, naming the next release version:

   ```bash
   gh workflow run release.yml --ref <branch> -f version=<next version>
   ```

   The dry run's `Read the version` refuses a branch that does not come after the latest release's commit. If it does, rebase the branch on `origin/main`, wait for its CI, and run the dry run again.

6. Merge with a squash once `Full CI` is green and the dry run passed, and check that the issue closed. The next weekly run then finds the pin current and does nothing.

## Rules

- Move Tesseract, Leptonica and the Rust toolchain in pull requests of their own, not in this one.
- Never weaken the native job, the matrix or the fuzzing to let a move pass.
- If no `pdfium-render` release carries an API that links with this PDFium, leave the pin, say so on the issue, and leave the issue open: the weekly run edits it again when a newer build appears.
