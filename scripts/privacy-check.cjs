// Run with: npx electron scripts/privacy-check.cjs
const { app, safeStorage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const assert = require('node:assert/strict');
app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lotus-privacy-'));
  try {
    const file = path.join(dir, 'settings.json');
    const source = await fs.readFile(path.join(__dirname, '../src/main.js'), 'utf8');
    const code = source.slice(source.indexOf('const SECRET_FIELDS'), source.indexOf("ipcMain.handle('settings:load'"));
    const context = vm.createContext({ safeStorage, fs, Buffer, process,
      SETTINGS_FILE: () => file,
      readJSON: async () => JSON.parse(await fs.readFile(file, 'utf8')),
      writeJSON: async (_, data) => fs.writeFile(file, JSON.stringify(data)),
    });
    vm.runInContext(code + ';globalThis.test = {saveSettings, loadSettings};', context);
    const settings = {anthropicApiKey:'privacy-test-anthropic', difyApiKey:'privacy-test-dataset', difyWorkflowKey:'privacy-test-workflow'};
    await context.test.saveSettings(settings);
    const raw = await fs.readFile(file, 'utf8');
    for (const value of Object.values(settings)) assert(!raw.includes(value));
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    const restored = await context.test.loadSettings();
    for (const key of Object.keys(settings)) assert.equal(restored[key], settings[key]);
    await fs.writeFile(file, JSON.stringify(settings));
    await context.test.saveSettings(await context.test.loadSettings());
    assert(!(await fs.readFile(file, 'utf8')).includes('privacy-test-'));
    const { normalizeBase } = require('../src/dify');
    assert.equal(normalizeBase('https://example.com/v1/'), 'https://example.com/v1');
    assert.equal(normalizeBase('http://localhost:8080/v1'), 'http://localhost:8080/v1');
    for (const url of ['http://example.com', 'https://user:pass@example.com', 'file:///tmp/private', 'https://example.com?key=private']) assert.throws(() => normalizeBase(url));
    console.log('PASS: system encryption, round trip, legacy migration, file permissions, Dify transport');
  } finally {
    await fs.rm(dir, {recursive:true, force:true});
  }
  app.quit();
}).catch((err) => { console.error(err); app.exit(1); });
