import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { ServerAdapterModule, AdapterExecutionContext, AdapterConfigSchema, AdapterEnvironmentTestContext, AdapterEnvironmentCheck, AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { buildClineAcpConfig, commandToken, configEnv, resolveCommand } from "./config.js";
export { buildClineAcpConfig } from "./config.js";

function assertLocal(target: AdapterExecutionContext["executionTarget"]): void {
  if (target && target.kind !== "local") throw new Error("cline_local v0.1 supports local execution only");
}

let executor: ServerAdapterModule["execute"] | undefined;
export async function execute(ctx: AdapterExecutionContext) {
  assertLocal(ctx.executionTarget);
  if (ctx.executionTransport?.remoteExecution) throw new Error("Legacy remote execution is unsupported by cline_local v0.1");
  const config = await buildClineAcpConfig(ctx.config);
  if (!executor) {
    const { createAcpxEngineExecutor } = await import("@paperclipai/adapter-utils/acpx-engine/execute");
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    executor = createAcpxEngineExecutor({ adapterType: "cline_local", moduleDir, packageRootDir: path.resolve(moduleDir, "..") });
  }
  return executor({ ...ctx, config });
}

export function getConfigSchema(): AdapterConfigSchema {
  return { fields: [
    { key: "cwd", label: "Working directory", type: "text", hint: "Existing absolute directory on the Paperclip host." },
    { key: "model", label: "Model", type: "text" },
    { key: "profileDir", label: "Cline profile directory", type: "text", hint: "Use saved OpenAI-compatible provider and model; omit model and agentCommand." },
    { key: "agentCommand", label: "ACP server command", type: "text", hint: "Optional explicit command; otherwise resolves native cline.exe --acp." },
  ] };
}

export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  async function check(code: string, probe: () => Promise<void>) {
    try { await probe(); checks.push({ code, level: "info", message: `${code}: available` }); }
    catch (error) { checks.push({ code, level: "error", message: error instanceof Error ? error.message : String(error) }); }
  }
  await check("local_target", async () => assertLocal(ctx.executionTarget));
  const cwd = typeof ctx.config.cwd === "string" && ctx.config.cwd.trim() ? ctx.config.cwd : process.cwd();
  await check("cwd", async () => {
    if (!path.isAbsolute(cwd) || !(await fs.stat(cwd)).isDirectory()) throw new Error("cwd must be an existing absolute directory");
  });
  await check("runtime", async () => {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major! < 24 || (major === 24 && minor! < 11)) throw new Error("Node.js >=24.11.0 is required");
    const require = createRequire(import.meta.url);
    const engine = require.resolve("@paperclipai/adapter-utils/acpx-engine/execute");
    createRequire(engine).resolve("acpx");
  });
  if (!checks.some(check => check.level === "error" && check.code === "local_target")) {
    await check("command", async () => {
      const config = await buildClineAcpConfig(ctx.config);
      await resolveCommand(commandToken(String(config.agentCommand)), cwd, configEnv(ctx.config));
    });
  }
  checks.push({ code: "acp_not_tested", level: "warn", message: "No process launched. ACP handshake, credentials, model calls and integration are NOT_RUN." });
  return { adapterType: "cline_local", status: checks.some(check => check.level === "error") ? "fail" : "warn", checks, testedAt: new Date().toISOString() };
}

export function createServerAdapter(): ServerAdapterModule {
  return {
    type: "cline_local", acp: { agentId: "cline", skillsMode: "unsupported", prerequisites: { nodeRange: ">=24.11.0" } },
    execute, testEnvironment, getConfigSchema,
  };
}
