# cline_local 0.1

External Paperclip adapter: createServerAdapter() → execute() → buildClineAcpConfig() → shared ACPX executor. No core registration changes.

Local Windows automatic launch resolves CLINE_BIN_PATH, installed Cline cached native binary/platform package, then cline.exe in PATH. Explicit agentCommand wins and is passed through unchanged. No versioned installation path is embedded. config.env is included in resolver lookup. Remote targets are unsupported in this version.

Cline ACP 3.0.66 supports model; all four effort aliases are removed. Skills are unsupported; runtimeToolDelivery is deliberately absent.

Package requires @paperclipai/adapter-utils 0.3.1 and Node >=24.11.0. Build produces dist/index.js, the external loader entry. Register this package through the existing external-adapter localPath mechanism in a separately authorized integration step. It is not automatically registered or activated by adding these files.

testEnvironment reads cwd, executable availability, Node version and ACPX dependency resolution. It never spawns Cline or probes credentials/ACP; success remains warn with explicit NOT_RUN evidence. Tests use temporary fake executables and do not invoke execute(). Live verification is documented separately in connector smoke evidence.

Commands: npm run typecheck; npm run build; npm test (after build).

## Saved OpenAI-compatible profile

Set `profileDir` to an existing absolute Cline configuration directory. Omit
`agentCommand` and `model`; `CLINE_BIN_PATH` can select a native executable.
The launcher reads `data/settings/providers.json`, requires the saved
`lastUsedProvider` and settings provider to be `openai-compatible`, and uses
that provider's saved API key, model and base URL. It supplies `CLINE_API_KEY`,
`CLINE_PROVIDER` and `CLINE_MODEL` only to the Cline child process. The key is
never included in Paperclip adapter config, command arguments or invocation env.
The same `--config` directory lets Cline load its persisted base URL/settings.
The launcher selects `CLINE_SESSION_BACKEND_MODE=local` to keep runtime settings
in that profile. The adapter also supplies the saved model through the existing
ACPX session configuration path: Cline 3.0.66 silently falls back to `gpt-4o`
when `CLINE_MODEL` is absent from its advertised OpenAI-compatible catalog.
The profile must therefore also have `data/settings/models.json` (version 1),
with `providers.openai-compatible.models` containing the saved model ID.
The launcher refuses to start without that catalog entry. This is necessary
because ACPX can reconnect/start a fresh Cline session between session config
and prompt; the catalog preserves the model across those connections.
Conflicting provider, model, key or profile path environment overrides fail closed.
No OAuth authentication or fallback provider is requested; no profile is rewritten.

Example: `{ "profileDir": "C:\\Users\\comp\\.cline-sensor-act",
"cwd": "D:\\Магазин\\sensor-blog-worktrees\\T-G4-paperclip-pilot-run",
"permissionMode": "deny-all", "nonInteractivePermissions": "deny" }`.

This bridge is local Windows only, matching automatic native binary resolution.
Rebuild and restart Paperclip after updating this adapter. Existing explicit
`agentCommand` configurations remain unchanged when `profileDir` is absent.
Read-only smoke uses `deny-all` and a prompt that forbids tools; this does not
qualify file editing, session recovery, other providers or unattended operation.

Fit-gap: Cline ACP's persisted auth restore checks OAuth methods, not the saved
OpenAI-compatible provider. Supported child environment variables bridge auth;
the existing ACP model setting bypasses the incomplete catalog. Neither change
requires ACPX runtime auth, adapter-utils or Paperclip core modifications.
Upstream reference: https://github.com/cline/cline/blob/main/apps/cli/src/acp/acpAgent.ts
