import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { profileEnv } from "./profile-launcher.js";

export function commandToken(command: string): string {
  const match = command.trim().match(/^(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  if (!match) throw new Error("Empty agentCommand");
  return match[1] ?? match[2] ?? match[3]!;
}

async function isFile(file: string): Promise<boolean> {
  try { return (await fs.stat(file)).isFile(); } catch { return false; }
}

export async function resolveCommand(token: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  const candidates = token.includes("/") || token.includes("\\")
    ? [path.resolve(cwd, token)]
    : dirs.flatMap(dir => process.platform === "win32" && !path.extname(token)
      ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")].map(ext => path.join(dir, token + ext))
      : [path.join(dir, token)]);
  for (const file of candidates) {
    if (!(await isFile(file))) continue;
    try { await fs.access(file, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK); return file; } catch { /* Try next candidate. */ }
  }
  throw new Error(`Command is not resolvable: ${token}`);
}

// Mirrors Cline's launcher priority while returning the native executable itself.
export async function resolveNativeCline(cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  if (process.platform !== "win32") throw new Error("Automatic Cline resolution currently supports Windows only; set agentCommand explicitly");
  if (env.CLINE_BIN_PATH?.trim()) {
    const file = await resolveCommand(env.CLINE_BIN_PATH.trim(), cwd, env);
    if (!file.toLowerCase().endsWith(".exe")) throw new Error("CLINE_BIN_PATH must point to a native .exe");
    return file;
  }
  const roots = new Set<string>();
  const require = createRequire(import.meta.url);
  try { roots.add(path.dirname(require.resolve("cline/package.json", { paths: [cwd] }))); } catch { /* Search global locations below. */ }
  for (const dir of (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean)) {
    roots.add(path.join(dir, "node_modules", "cline"));
  }
  if (env.APPDATA) roots.add(path.join(env.APPDATA, "npm", "node_modules", "cline"));
  for (const root of roots) {
    for (const file of [path.join(root, "bin", ".cline", "cline.exe"), path.join(root, "bin", ".cline")]) {
      if (await isFile(file)) return file;
    }
    try {
      const file = require.resolve("@cline/cli-windows-x64/bin/cline.exe", { paths: [root] });
      if (await isFile(file)) return file;
    } catch { /* Optional platform package may be nested or hoisted. */ }
    const file = path.join(root, "node_modules", "@cline", "cli-windows-x64", "bin", "cline.exe");
    if (await isFile(file)) return file;
  }
  return resolveCommand("cline.exe", cwd, env);
}

export function configEnv(config: Record<string, unknown>): NodeJS.ProcessEnv {
  const result = { ...process.env };
  if (config.env && typeof config.env === "object" && !Array.isArray(config.env)) {
    for (const [key, value] of Object.entries(config.env)) if (typeof value === "string") result[key] = value;
  }
  return result;
}

export async function buildClineAcpConfig(config: Record<string, unknown>): Promise<Record<string, unknown>> {
  const next = { ...config, agent: "cline" };
  for (const key of ["modelReasoningEffort", "reasoningEffort", "thinkingEffort", "effort"]) delete (next as Record<string, unknown>)[key];
  if (typeof config.profileDir === "string" && config.profileDir.trim()) {
    if (!path.isAbsolute(config.profileDir)) throw new Error("profileDir must be absolute");
    if (config.agentCommand) throw new Error("Use profileDir without agentCommand; CLINE_BIN_PATH selects the native executable");
    if (config.model) throw new Error("With profileDir, model is selected by the saved profile");
    const cwd = typeof config.cwd === "string" && config.cwd.trim() ? config.cwd : process.cwd();
    const binary = await resolveNativeCline(cwd, configEnv(config));
    const env = await profileEnv(config.profileDir, configEnv(config));
    const launcher = fileURLToPath(new URL("./profile-launcher.js", import.meta.url));
    const args = [process.execPath, launcher, binary, config.profileDir];
    if (args.some(value => /["\r\n]/.test(value))) throw new Error("Invalid launcher path");
    return { ...next, model: env.CLINE_MODEL, agentCommand: args.map(value => `"${value}"`).join(" ") };
  }
  if (typeof config.agentCommand === "string" && config.agentCommand.trim()) return next;
  const cwd = typeof config.cwd === "string" && config.cwd.trim() ? config.cwd : process.cwd();
  const binary = await resolveNativeCline(cwd, configEnv(config));
  return { ...next, agentCommand: `"${binary}" --acp` };
}
