# Sensor runtime external adapters

Verified locally on 2026-10-01. Baseline: branch `sensor/runtime`, HEAD
`9003eb42175e52fc222f7959fcb69f302b28cbdb`, initially clean. Remotes:
`origin=https://github.com/ra-fares/paperclip.git`,
`upstream=https://github.com/paperclipai/paperclip.git`.

## Installation model and causes

Both adapter directories are ordinary tracked files. Both remain external
plugins loaded by `server/src/adapters/plugin-loader.ts`; no core registration
or nested Git repository is needed. For a local path, the install route only
reads package metadata and calls the loader: it does not install dependencies
or build the package. The loader resolves `exports["."].import` (or a string
export/main), imports that entry and validates `createServerAdapter()`.
Dependencies resolve from the imported package, not the plugin registry.

Cline in the old environment had an untracked junction from its
`node_modules/@paperclipai/adapter-utils` to that repository's
`packages/adapter-utils` (version 0.3.1, TypeScript source exports), plus local
TypeScript and built `dist`. Runtime had TypeScript but no adapter-utils link
and no dist. The manifest only declared a peer; `.npmrc` sets
`auto-install-peers=false`, and the root lock lacked a Cline importer. An
explicit `workspace:*` dev dependency now installs the same local API with
its patched ACPX 0.12.0 dependency. The 0.3.1 peer contract remains intact.
Cline build/typecheck intentionally uses the host workspace; it is not an
independent npm application. Normal installs must include dev dependencies.

Antigravity in the old environment resolved adapter-utils 2026.916.1 from
that repository's pnpm store. Runtime instead had a junction to the local
0.3.1 source package. Its standalone TypeScript configuration then followed
host sources and encountered host compiler/dependency assumptions. The
tracked Antigravity npm lock actually pins 2026.831.1, not 2026.916.1. Clean
`npm ci` with that unchanged lock passes all 57 tests and the current host's
actual loader. This establishes the existing lock's technical compatibility
without changing package versions to match an accidental local install.
Antigravity is excluded from the root pnpm workspace and installs independently
through its existing npm lock. Do not replace its dependency with workspace:*.

Generated node_modules, junctions and dist are installation/build artifacts,
not source/checkpoints to copy. Root pnpm install cannot silently replace
Antigravity's standalone dependency after its workspace exclusion.

## Repeatable local qualification

Run from the repository root, with Node >=24.11.0, npm and pnpm 9.15.4.
The commands below use npx to select the repository's declared pnpm version
without modifying global package-manager configuration.

```powershell
npx --yes pnpm@9.15.4 --filter @paperclipai/server... --filter @sensor/paperclip-adapter-cline-local... install --frozen-lockfile --ignore-scripts
npm --prefix packages/adapters/antigravity-local ci --ignore-scripts --no-audit --no-fund
npm --prefix packages/adapters/cline-local run build
npm --prefix packages/adapters/cline-local test
npm --prefix packages/adapters/antigravity-local run verify
node server/node_modules/tsx/dist/cli.mjs scripts/smoke/sensor-runtime-adapters.ts
npx --yes pnpm@9.15.4 exec vitest run server/src/adapters/plugin-loader.test.ts
```

The filtered install is sufficient for this adapter qualification; it is not
a complete server/UI deployment or release build. Before running Paperclip
from a fresh clone, perform the normal host setup from `doc/DEVELOPING.md`
using the pinned pnpm version, then repeat the standalone Antigravity npm ci
and adapter builds above. Do not use production-only installs for this
source-workspace server. Install output can warn about host runner/plugin-SDK
bin files whose unrelated dist outputs have not been built. The qualification
uses neither those executables nor the running server.

The smoke calls the real loader directly with repository-relative local
paths; it does not read/write registrations. It validates both factories,
Antigravity's UI parser and Cline's lazy ACPX executor import. It checks the
real paths of adapter-utils and Cline's engine/ACPX stay inside this checkout.
It never calls execute, model discovery, login or testEnvironment.

## Validation evidence

Runtime: Cline build (including typecheck) PASS; tests 8/8 PASS. Antigravity
unchanged-lock npm ci, build and tests 57/57 PASS. Actual plugin-loader smoke
PASS for cline_local and agy_local; existing loader unit tests 4/4 PASS.

A separate Git archive of HEAD plus the changed manifests/lock/smoke was
extracted without copying node_modules/dist. No root or nested .git was
included. The first long-path copy fetched 763 packages, then failed with Windows
ENAMETOOLONG while applying an unrelated Claude dependency patch. Retrying
in `C:\Users\comp\Documents\Codex\work\rt1001` succeeded: frozen filtered
install, Cline build/typecheck + 8/8 tests, Antigravity npm ci/verify + 57/57
tests, actual loader smoke for both + ACPX import, and loader tests 4/4.
The retry reused the package download store, not any old node_modules/dist.
Two unrelated `.claude/skills` symlinks were excluded from the Windows tar
export after extraction errors; adapter and host sources were unchanged.
Use a short checkout path on Windows; no global Windows setting was changed.
The smoke resolved Cline utilities to the clean copy's packages/adapter-utils
and Antigravity utilities to its own clean-copy node_modules. Neither was
resolved from D:\paperclip-sensor or an external adapter checkout.

NOT_RUN: model/ACP E2E, credentials, agent launches, live sensor-pilot switch,
server startup, full repository build/typecheck/test suite. Historical E2E
results are context, not new acceptance evidence.

## Manual switch (not applied)

After reviewing/saving these changes and completing the host's normal setup:

1. Stop the existing sensor-pilot server using its existing launch procedure.
2. Back up `C:\Users\comp\.paperclip\adapter-plugins.json`. In its existing
   records, replace only the two localPath values:
   - Cline: `D:\Магазин\paperclip-worktrees\runtime\packages\adapters\cline-local`
   - Antigravity: `D:\Магазин\paperclip-worktrees\runtime\packages\adapters\antigravity-local`
3. Start through the existing sensor-pilot launch command from the runtime
   checkout, retaining the current PAPERCLIP_HOME and instance selection.
   No exact launcher command is prescribed here because it was not qualified
   in this adapter-only task; do not start a default/new instance by accident.
4. Inspect server startup for both external adapters. Live model qualification
   is a separate authorized step. If startup fails, restore the saved registry
   and restart with the old checkout and existing launch procedure.

No global registration/configuration, credentials, old adapter directories,
ACLs or ownership were changed. No commit or push was performed. The local
changes must be saved to Git through a separately authorized commit/push before
a remote clone can contain this fix. This document does not claim the existing
remote branch already contains the changes.
