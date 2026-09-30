import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Keep credentials out of Paperclip's config, invocation metadata and argv.
export async function profileEnv(profileDir: string, inherited: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  if (!path.isAbsolute(profileDir)) throw new Error("profileDir must be absolute");
  const settingsPath = path.join(profileDir, "data", "settings", "providers.json");
  let profile;
  try { profile = JSON.parse(await fs.readFile(settingsPath, "utf8")); }
  catch { throw new Error("Cannot read Cline profile providers.json"); }
  const provider = profile.lastUsedProvider;
  const settings = profile.providers?.[provider]?.settings;
  if (provider !== "openai-compatible" || settings?.provider !== provider) {
    throw new Error("profileDir requires the saved openai-compatible provider");
  }
  for (const field of ["apiKey", "model", "baseUrl"] as const) {
    if (typeof settings[field] !== "string" || !settings[field].trim()) throw new Error(`Saved provider is missing ${field}`);
  }
  const endpoint = new URL(settings.baseUrl);
  if (endpoint.username || endpoint.password) throw new Error("Provider URL must not contain credentials");
  let catalog;
  try { catalog = JSON.parse(await fs.readFile(path.join(profileDir, "data", "settings", "models.json"), "utf8")); }
  catch { throw new Error("Cline profile requires models.json containing its saved model"); }
  const entry = catalog.providers?.[provider];
  if (catalog.version !== 1 || !entry?.models?.[settings.model]) throw new Error("Saved model is missing from Cline models.json; refusing ACP fallback");
  if (entry.provider?.baseUrl && entry.provider.baseUrl !== settings.baseUrl) throw new Error("Conflicting model catalog endpoint");
  // Fail closed rather than silently replacing the saved provider or model.
  for (const [key, value] of Object.entries({ CLINE_PROVIDER: provider, CLINE_MODEL: settings.model, CLINE_API_KEY: settings.apiKey })) {
    if (inherited[key] && inherited[key] !== value) throw new Error(`Conflicting ${key} override`);
  }
  if (inherited.CLINE_DATA_DIR || inherited.CLINE_PROVIDER_SETTINGS_PATH) throw new Error("Conflicting Cline profile path override");
  if (inherited.CLINE_SESSION_BACKEND_MODE && inherited.CLINE_SESSION_BACKEND_MODE !== "local") throw new Error("Conflicting Cline session backend");
  return { ...inherited, CLINE_PROVIDER: provider, CLINE_MODEL: settings.model, CLINE_API_KEY: settings.apiKey, CLINE_SESSION_BACKEND_MODE: "local" };
}

async function main() {
  const [binary, profileDir] = process.argv.slice(2);
  if (!binary || !profileDir) throw new Error("Expected Cline executable and profileDir");
  const env = await profileEnv(profileDir, process.env);
  process.stderr.write(`[cline_local] saved provider=${env.CLINE_PROVIDER} model=${env.CLINE_MODEL}\n`);
  const child = spawn(binary, ["--config", profileDir, "--acp"], { env, stdio: "inherit", windowsHide: true });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
  child.on("error", () => { process.stderr.write("[cline_local] Cannot launch Cline\n"); process.exitCode = 1; });
  child.on("exit", (code) => { process.exitCode = code ?? 1; });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`[cline_local] ${error.message}\n`); process.exitCode = 1; });
}
