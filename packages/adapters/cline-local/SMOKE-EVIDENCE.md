# Cline connector: runtime-verified

Date: 2026-09-30, Europe/Kyiv.

Paperclip sensor-pilot successfully launched native Cline CLI 3.0.66 ACP with
the existing `C:\Users\comp\.cline-sensor-act` OpenAI-compatible profile.
Provider: `openai-compatible`. Endpoint: `https://integrate.api.nvidia.com/v1`.
Actual model: `nvidia/nemotron-3-ultra-550b-a55b` (Cline request summary).

## Acceptance

- Task: SEN-12, id `47207c5d-d339-4633-94f9-5794c963e402`, now `done`.
- Task-bound run: `6bb2039b-e26b-4d68-acfa-4439c3c8462e`, `succeeded`.
- Response: `PAPERCLIP_CLINE_ACP_OK`; exit code 0.
- Additional standalone successful run: `cde207c3-fe41-42bc-bcb4-7b13c3b856b1`.
- Cwd: `D:\Магазин\sensor-blog-worktrees\T-G4-paperclip-pilot-run`.
- Tools denied (`permissionMode=deny-all`, `nonInteractivePermissions=deny`).
- No tool calls in the acceptance transcript.
- Pilot file hash comparison: 178 before, 178 after; no additions, removals or changes.
- Original `providers.json` hash unchanged; credentials/provider were not rewritten.
- SEN-9 and failed runs retained. SEN-10/SEN-11 retain failed/recovery history.

## Minimal changes

Checkout: `D:\paperclip-sensor`, branch `sensor/cline-local-adapter`.
Existing HEAD: `0f2fd1dec73fce33e5e670fe52e1f3c4658c42d5`.
Earlier adapter commit: `f8e8d3182`.
No new commits or pushes were made.

Repository files:

1. `packages/adapters/cline-local/src/config.ts`: opt-in `profileDir`, launcher command and saved model selection.
2. `packages/adapters/cline-local/src/index.ts`: profileDir configuration field.
3. `packages/adapters/cline-local/src/profile-launcher.ts`: new child-only auth bridge, catalog validation and local runtime.
4. `packages/adapters/cline-local/tests/adapter.test.mjs`: profile, conflict, catalog and secret-exclusion tests.
5. `packages/adapters/cline-local/README.md`: configuration, fit-gap and limitations.
6. `packages/adapters/cline-local/SMOKE-EVIDENCE.md`: this acceptance record.

Generated ignored build files: `dist/config.js`, `dist/config.d.ts`,
`dist/index.js`, `dist/index.d.ts`, `dist/profile-launcher.js`,
`dist/profile-launcher.d.ts` under that adapter.

Host-only configuration:

- Added `C:\Users\comp\.cline-sensor-act\data\settings\models.json` containing the saved Nemotron model catalog; no credentials.
- Updated only Cline's Paperclip adapter config: `profileDir`, 180-second timeout, oneshot, tools denied; removed old explicit agentCommand.
- Temporary summary capture env and smoke prompt removed after verification.
- Sensor-pilot restarted and remains available on `http://127.0.0.1:3100`.

## Fit-gap and reason

1. Cline ACP restores persisted auth only for its OAuth methods. The saved
   OpenAI-compatible profile needs `CLINE_API_KEY` plus `CLINE_PROVIDER` in
   the child process. Launcher reads the existing key without storing it in
   Paperclip config, argv, repository or invocation metadata.
2. Cline ACP ignores a CLINE_MODEL absent from its catalog, falling back to
   `gpt-4o`. The saved Nemotron was missing from the catalog. A supported
   models.json entry fixes startup selection on every connection.
3. ACPX can create a new Cline session for prompt after session configuration;
   a session-only model override therefore was insufficient. Summary capture
   exposed the actual gpt-4o fallback. These diagnostic requests failed with
   NVIDIA HTTP 404; no successful inference with that model occurred.
4. Local backend is pinned to avoid implicit hub runtime selection. The
   original provider settings supply the base URL in Cline core's config merge.
5. No ACPX, adapter-utils or Paperclip core patch was needed.

Official source: https://github.com/cline/cline/blob/main/apps/cli/src/acp/acpAgent.ts
Official docs: https://github.com/cline/cline/blob/main/docs/usage/acp.mdx
Installed native binary handshake confirmed Cline 3.0.66 behavior.

## Verification and limits

Adapter typecheck and build passed; 8/8 adapter tests passed; git diff --check passed.
Repo-wide typecheck/build/test suite: NOT_RUN (no shared/core code changed).
Read-only model connectivity is accepted. Writing, tool permissions, persistent
resume, recovery after a failed task and unattended task disposition are not accepted.
Windows local saved OpenAI-compatible profiles are the supported scope.
Cost/usage attribution remains the existing ACPX behavior and is not qualified.
The profile catalog must include the saved model; launcher fails before inference otherwise.

The model was deliberately forbidden from calling Paperclip to complete tasks.
Paperclip scheduled a disposition-repair follow-up; Work marked SEN-12 done
and cancelled the remaining scheduled retry. This does not prove agent-managed
task disposition. No Codex or other paid-model agent was launched by Work.
No ACL, permissions or ownership changes were made. The protected Blog checkout
was not accessed or changed. History and artifacts were preserved.

Evidence directory: `C:\Users\comp\Documents\Codex\2026-09-30\referenced-chatgpt-conversation-this-is-an-5\outputs`.
Evidence files: `smoke-run.json`, `smoke-log.ndjson`
(output/events only, thought chunks omitted), `cline-provider-summary.json`,
`cline-agent-config.json`, `preservation-check.json`, `models.json`.
