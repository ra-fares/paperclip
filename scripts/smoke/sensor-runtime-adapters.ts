import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadExternalAdapterPackage, getUiParserSource } from '../../server/src/adapters/plugin-loader.js';

const root = fs.realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
function insideRoot(file: string) {
  const real = fs.realpathSync(file);
  const relative = path.relative(root, real);
  assert.ok(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `Dependency escapes repository: ${real}`);
  return real;
}
for (const [folder, name, type] of [
  ['cline-local', '@sensor/paperclip-adapter-cline-local', 'cline_local'],
  ['antigravity-local', 'agy-paperclip-adapter', 'agy_local'],
]) {
  const dir = path.join(root, 'packages/adapters', folder);
  assert.equal(fs.existsSync(path.join(dir, '.git')), false, 'Nested Git is unnecessary');
  const require = createRequire(path.join(dir, 'package.json'));
  const utilsDir = insideRoot(path.join(dir, 'node_modules/@paperclipai/adapter-utils'));
  const utilsPkg = JSON.parse(fs.readFileSync(path.join(utilsDir, 'package.json'), 'utf8'));
  const utilsExport = utilsPkg.exports['.'];
  const utils = insideRoot(path.join(utilsDir, typeof utilsExport === 'string' ? utilsExport : utilsExport.import));
  const adapter = await loadExternalAdapterPackage(name, dir);
  assert.equal(adapter.type, type);
  assert.equal(typeof adapter.execute, 'function');
  assert.equal(typeof adapter.testEnvironment, 'function');
  if (type === 'cline_local') {
    const engine = insideRoot(require.resolve('@paperclipai/adapter-utils/acpx-engine/execute'));
    insideRoot(createRequire(engine).resolve('acpx'));
    const mod = await import(pathToFileURL(engine).href);
    assert.equal(typeof mod.createAcpxEngineExecutor, 'function');
  } else {
    assert.ok(getUiParserSource(type)?.length);
  }
  console.log(JSON.stringify({ type, packageDir: dir, adapterUtils: utils, status: 'PASS' }));
}
console.log('PASS: actual Paperclip loader; no execute, model discovery, login or environment probe called.');
