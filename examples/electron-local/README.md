# Electron, on the local engine

A desktop application that opens `@withmarfa/sdk/local`, writes with no
network, and shows what it wrote after a restart.

```bash
pnpm --filter @withmarfa/example-electron-local start
```

Type a note, press Write, quit the window, run it again. The note is still
there and still marked as not sent, because nothing has been able to send it.

## What it is showing

- **The main process owns the store, and only the main process.** The
  renderer is sandboxed, has no Node, and reaches the engine through the
  bridge in `src/preload.ts`. That is the design rather than a hardening pass
  over it: a renderer with Node could open the store itself and become a
  second writer over one file.
- **A write lands on disk first.** `createItem` returns before anything has
  been sent, and the item is on screen with `version: 0` — the engine's mark
  for a row the server has not seen.
- **The store is keyed on origin, space and account**, so a second account on
  one machine gets its own store rather than meeting the engine's refusal to
  open one account's store as another.

Point it at a real server by setting `MARFA_API_URL`, `MARFA_SPACE_ID`,
`MARFA_ACCOUNT_ID` and `MARFA_API_KEY`. With no `MARFA_API_KEY` the engine is
never started, so the application makes no request at all — which is the state
it is meant to be tried in.

## Two locks, and they are not the same lock

`src/main.ts` takes Electron's single-instance lock. The engine takes its own
writer lock over the store file. Both matter and neither substitutes for the
other:

- **Electron's** decides whether a second copy of the **application** starts.
  Without it, opening the app twice gives two processes, and the second finds
  the store held and opens it read-only — an app that looks identical to the
  first and silently cannot save.
- **The engine's** decides which handle over one **store file** may advance
  its cursor. It still refuses a second writer when one process opens the same
  store twice, and it still permits two stores in one process, which is what a
  second signed-in account is.

## The packaging risk, and what is done about it

The engine's SQLite binding ships its native code as nine platform packages,
declared as optional dependencies of `libsql`. **An install resolves the build
host's and skips the other eight.** That is right for a server, which runs
where it was installed, and wrong for a desktop application, which is built on
one machine and run on others: build on an Apple Silicon Mac and the Windows
artifact carries a macOS binary, or nothing.

**None of that is a build error.** The build succeeds, the installer is
signed, and the first report is a module-not-found at the first store open on
somebody else's machine, on a code path with no visible relationship to a
missing file.

So this application declares the five platform packages it ships for as
**direct** dependencies — all of them install whatever the host — and
`scripts/check-native-targets.ts` runs from `build` and fails naming any
target whose binary is absent or is for another platform. It reads the object
headers rather than asking whether a file is there, because the failure it
exists for looks exactly like a healthy install from the filename down.

Two alternatives were considered and rejected. Building each platform on its
own machine is a packaging decision this repository has not taken. Fetching
the right package per target while packaging is the most delicate of the
three: it puts a network request inside the step that produces the artifact,
and moves the failure somewhere with even less to say about it.

**The cost is install weight**, about eight megabytes per target and roughly
forty for the five. That is the honest trade.

The versions are pinned exactly and `libsql` itself arrives through
`@libsql/client`, so bumping that means bumping these in step.

### What the check does and does not observe

It reads `node_modules` on the machine running it. It says the bindings a
packager could copy are present and are for the platforms they claim; it does
not open an artifact, and **this sample has no packaging step to open one**
— `build` is a bundle and a check, and `electron .` runs it from the tree.
An application that adds `electron-builder` or `electron-forge` still has to
make sure the packager copies the platform packages into the artifact it
produces, which is that packager's configuration.

The reader looks at the object headers, so it separates a Windows package
holding a macOS binary from one holding a Windows one, and a universal binary
that carries the architecture it needs from one that carries only the other.
It cannot tell glibc from musl, which no header records.

### Installing them with something other than pnpm

These five packages declare `os` and `cpu` for platforms the build host is
mostly not. Package managers differ on that, verified rather than assumed:

- **pnpm installs them without complaint** — no warning on a default install,
  and `engine-strict=true` does not change it, because that setting governs
  the `engines` field rather than `os`/`cpu`.
- **npm refuses**, with `EBADPLATFORM` naming the first mismatched package,
  and installs nothing. An application that has to support `npm install`
  needs a different route to the same place.

`pnpm.supportedArchitectures` is the sanctioned mechanism for pulling other
platforms' packages, and it is deliberately not configured here: it applies to
**optional** dependencies, and setting it in the workspace would pull every
platform variant of every optional dependency in the whole tree —
`esbuild`, `rollup`, `lightningcss` and the rest — to solve a problem five
direct dependencies already solve.

## Two things about the kit this sample has to work around

- **`@withmarfa/sdk/electron` is ESM-only.** There is no `require` condition
  on the subpath, and an Electron main process is overwhelmingly CommonJS, so
  a CJS main cannot `require` it — this sample's main is an ES module
  (`"type": "module"`, Electron 28 and later), and an application that is not
  has to bundle the subpath or move its main to ESM.
- **A `<script type="module">` never loads from a `file://` page.** Module
  scripts are fetched under CORS and a file URL has an opaque origin, so the
  request fails — with or without a Content-Security-Policy, in the same
  directory or another. `loadFile` gives a file URL, so `src/renderer.ts` is
  built as a classic script rather than a module. Verified in Chromium: the
  module form left the page blank, the classic form ran, under identical CSP.

## Electron's binary

Nothing here downloads Electron at install time: as of Electron 44 the package
has no install script, and the ~150MB platform binary is fetched lazily the
first time `require("electron")` runs from Node — which is `pnpm start` and
nothing else. Every other install and every CI job pays nothing for it.

## Layout

| Path                              | What it is                                         |
| --------------------------------- | -------------------------------------------------- |
| `src/main.ts`                     | Opens the store, serves the bridge, opens a window |
| `src/preload.ts`                  | One line: puts the engine on `window`              |
| `src/renderer.ts`                 | An ordinary browser script with no Node in it      |
| `app/index.html`                  | The page                                           |
| `scripts/check-native-targets.ts` | The build-time packaging check                     |

`tsup.config.ts` builds the three separately, because they are three programs
that agree on almost nothing: the preload has to be CommonJS and
self-contained, since Electron loads an ES-module preload only for renderers
that are not sandboxed and gives a sandboxed one a `require` that reaches
nothing off disk.
