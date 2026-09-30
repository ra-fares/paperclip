import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildClineAcpConfig, commandToken, resolveCommand, resolveNativeCline } from '../dist/config.js';
import { createServerAdapter, execute, testEnvironment, getConfigSchema } from '../dist/index.js';
import { profileEnv } from '../dist/profile-launcher.js';

test('saved profile credentials stay child-only; conflicts and OAuth profiles fail closed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cline-profile-'));
  const fixture = { lastUsedProvider: 'openai-compatible', providers: { 'openai-compatible': { settings: {
    provider: 'openai-compatible', apiKey: 'fixture-not-a-real-secret', model: 'fixture/nemotron', baseUrl: 'https://example.invalid/v1',
  } } } };
  try {
    await fs.mkdir(path.join(dir, 'data', 'settings'), { recursive: true });
    const file = path.join(dir, 'data', 'settings', 'providers.json');
    await fs.writeFile(file, JSON.stringify(fixture));
    await assert.rejects(profileEnv(dir, {}), /requires models.json/);
    const catalogFile = path.join(dir, 'data', 'settings', 'models.json');
    await fs.writeFile(catalogFile, JSON.stringify({ version: 1, providers: { 'openai-compatible': { models: {} } } }));
    await assert.rejects(profileEnv(dir, {}), /refusing ACP fallback/);
    await fs.writeFile(catalogFile, JSON.stringify({ version: 1, providers: { 'openai-compatible': { models: { 'fixture/nemotron': { name: 'Fixture' } } } } }));
    const inherited = { PATH: 'fixture' };
    const env = await profileEnv(dir, inherited);
    assert.equal(env.CLINE_PROVIDER, 'openai-compatible');
    assert.equal(env.CLINE_MODEL, 'fixture/nemotron');
    assert.equal(env.CLINE_API_KEY, 'fixture-not-a-real-secret');
    assert.equal(env.CLINE_SESSION_BACKEND_MODE, 'local');
    await assert.rejects(profileEnv(dir, { CLINE_SESSION_BACKEND_MODE: 'hub' }), /session backend/);
    assert.equal('CLINE_API_KEY' in inherited, false);
    await assert.rejects(profileEnv(dir, { CLINE_PROVIDER: 'cline' }), /Conflicting CLINE_PROVIDER/);
    await assert.rejects(profileEnv(dir, { CLINE_MODEL: 'paid-model' }), /Conflicting CLINE_MODEL/);
    await assert.rejects(profileEnv(dir, { CLINE_API_KEY: 'different' }), /Conflicting CLINE_API_KEY/);
    await assert.rejects(profileEnv(dir, { CLINE_DATA_DIR: dir }), /path override/);
    fixture.lastUsedProvider = 'cline';
    await fs.writeFile(file, JSON.stringify(fixture));
    await assert.rejects(profileEnv(dir, {}), /saved openai-compatible/);
    await fs.writeFile(file, '{invalid');
    await assert.rejects(profileEnv(dir, {}), /Cannot read/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('profile launcher argv contains only paths and rejects competing configuration', { skip: process.platform !== 'win32' }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cline-config-'));
  await fs.mkdir(path.join(dir, 'data', 'settings'), { recursive: true });
  await fs.writeFile(path.join(dir, 'data', 'settings', 'providers.json'), JSON.stringify({ lastUsedProvider: 'openai-compatible', providers: { 'openai-compatible': { settings: { provider: 'openai-compatible', apiKey: 'fixture-secret', model: 'fixture/nemotron', baseUrl: 'https://example.invalid/v1' } } } }));
  await fs.writeFile(path.join(dir, 'data', 'settings', 'models.json'), JSON.stringify({ version: 1, providers: { 'openai-compatible': { models: { 'fixture/nemotron': { name: 'Fixture' } } } } }));
  const input = { profileDir: dir, env: { CLINE_BIN_PATH: process.execPath } };
  try {
  const output = await buildClineAcpConfig(input);
  assert.match(output.agentCommand, /profile-launcher\.js/);
  assert.equal(JSON.stringify(output).includes('CLINE_API_KEY'), false);
  assert.equal(JSON.stringify(output).includes('fixture-secret'), false);
  assert.equal(output.model, 'fixture/nemotron');
  assert.equal(input.agentCommand, undefined);
  await assert.rejects(buildClineAcpConfig({ ...input, model: 'other' }), /saved profile/);
  await assert.rejects(buildClineAcpConfig({ ...input, agentCommand: 'other' }), /without agentCommand/);
  await assert.rejects(buildClineAcpConfig({ profileDir: 'relative' }), /absolute/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('explicit command wins; model survives; all effort aliases removed without input mutation', async () => {
  const input = { agentCommand: '"C:\\custom path\\cline.exe" --acp', model: 'provider/model', agent: 'codex', modelReasoningEffort: 'high', reasoningEffort: 'low', thinkingEffort: 'medium', effort: 'high', env: { CLINE_BIN_PATH: 'missing.exe' } };
  const output = await buildClineAcpConfig(input);
  assert.equal(output.agentCommand, input.agentCommand);
  assert.equal(output.model, input.model);
  assert.equal(output.agent, 'cline');
  for (const key of ['modelReasoningEffort', 'reasoningEffort', 'thinkingEffort', 'effort']) assert.equal(key in output, false);
  assert.equal(input.effort, 'high');
});
test('factory preserves own execution and omits runtime tool delivery/effort UI', () => {
  const adapter = createServerAdapter();
  assert.equal(adapter.type, 'cline_local');
  assert.equal(adapter.execute, execute);
  assert.equal(adapter.acp.agentId, 'cline');
  assert.equal(adapter.acp.skillsMode, 'unsupported');
  assert.equal('runtimeToolDelivery' in adapter, false);
  assert.equal(getConfigSchema().fields.some(field => /effort/i.test(field.key)), false);
});
test('quoted command path and missing command checks', async () => {
  assert.equal(commandToken('"C:\\a b\\cline.exe" --acp'), 'C:\\a b\\cline.exe');
  await assert.rejects(resolveCommand('sensor-nonexistent-cline-test', process.cwd(), { PATH: '' }));
});
test('native resolver respects override and searches unversioned global package', { skip: process.platform !== 'win32' }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cline-adapter-'));
  try {
    const binary = path.join(dir, 'custom.exe');
    await fs.writeFile(binary, 'fixture');
    assert.equal(await resolveNativeCline(dir, { CLINE_BIN_PATH: binary }), binary);
    const native = path.join(dir, 'node_modules', 'cline', 'node_modules', '@cline', 'cli-windows-x64', 'bin', 'cline.exe');
    await fs.mkdir(path.dirname(native), { recursive: true });
    await fs.writeFile(native, 'fixture');
    assert.equal(await resolveNativeCline(dir, { PATH: dir }), native);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('environment checks filesystem/runtime only, never executes fixture', async () => {
  const result = await testEnvironment({ companyId: 'test', adapterType: 'cline_local', config: { cwd: process.cwd(), agentCommand: `"${process.execPath}" --acp` } });
  assert.equal(result.checks.find(check => check.code === 'command').level, 'info');
  assert.equal(result.checks.find(check => check.code === 'cwd').level, 'info');
  assert.equal(result.checks.find(check => check.code === 'runtime').level, 'info');
  assert.equal(result.status, 'warn');
  const invalid = await testEnvironment({ companyId: 'test', adapterType: 'cline_local', config: { cwd: 'relative', agentCommand: 'nonexistent' } });
  assert.equal(invalid.status, 'fail');
});

test('remote execution is rejected before engine import or model invocation', async () => {
  await assert.rejects(execute({ executionTarget: { kind: 'remote' } }), /local execution only/);
  await assert.rejects(execute({ executionTransport: { remoteExecution: {} } }), /Legacy remote/);
});
