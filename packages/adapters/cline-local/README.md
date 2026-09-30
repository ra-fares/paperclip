# cline_local 0.1

External Paperclip adapter: createServerAdapter() → execute() → buildClineAcpConfig() → shared ACPX executor. No core registration changes.

Local Windows automatic launch resolves CLINE_BIN_PATH, installed Cline cached native binary/platform package, then cline.exe in PATH. Explicit agentCommand wins and is passed through unchanged. No versioned installation path is embedded. config.env is included in resolver lookup. Remote targets are unsupported in this version.

Cline ACP 3.0.66 supports model; all four effort aliases are removed. Skills are unsupported; runtimeToolDelivery is deliberately absent.

Package requires @paperclipai/adapter-utils 0.3.1 and Node >=24.11.0. Build produces dist/index.js, the external loader entry. Register this package through the existing external-adapter localPath mechanism in a separately authorized integration step. It is not automatically registered or activated by adding these files.

testEnvironment reads cwd, executable availability, Node version and ACPX dependency resolution. It never spawns Cline or probes credentials/ACP; success remains warn with explicit NOT_RUN evidence. Tests use temporary fake executables and do not invoke execute(). Real model calls and Paperclip integration remain NOT_RUN.

Commands: npm run typecheck; npm run build; npm test (after build).
