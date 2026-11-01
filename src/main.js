const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { extractConcepts } = require('./ai');
const { DiskCache } = require('./cache');

const DATA_DIR = () => app.getPath('userData');
const PROJECT_FILE = () => path.join(DATA_DIR(), 'project.json');
const SETTINGS_FILE = () => path.join(DATA_DIR(), 'settings.json');

// Hosts the renderer may query through the main process. Everything else is refused.
const FETCH_ALLOWLIST = [/^([a-z-]+\.)?wikipedia\.org$/, /^export\.arxiv\.org$/, /^www\.wikidata\.org$/];

// 查询过的条目存在本机：7 天内直接用缓存，过期后重新拉取；网络失败时退回旧缓存
const CACHE_FRESH_MS = 7 * 24 * 60 * 60 * 1000;
let netCache = null;

async function readJSON(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJSON(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    title: 'Lotus',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#fbfbf8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.env.LOTUS_SMOKE) runSmoke(win, process.env.LOTUS_SMOKE);

  // Links inside the app never navigate the window; they open in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });
}

ipcMain.handle('project:load', () => readJSON(PROJECT_FILE(), null));
ipcMain.handle('project:save', (_e, data) => writeJSON(PROJECT_FILE(), data));
ipcMain.handle('settings:load', () => readJSON(SETTINGS_FILE(), {}));
ipcMain.handle('settings:save', (_e, data) => writeJSON(SETTINGS_FILE(), data));

ipcMain.handle('net:get', async (_e, url, accept) => {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !FETCH_ALLOWLIST.some((re) => re.test(u.hostname))) {
    throw new Error('host not allowed: ' + u.hostname);
  }
  const hit = await netCache.get(u.href);
  if (hit && Date.now() - hit.at < CACHE_FRESH_MS) return { ...hit.res, cached: true };
  let out;
  try {
    out = await fetchWithRetry(u, accept);
  } catch (err) {
    if (hit) return { ...hit.res, cached: true, stale: true };
    throw err;
  }
  if (out.status === 200) await netCache.set(u.href, out);
  else if (hit) return { ...hit.res, cached: true, stale: true };
  return out;
});

ipcMain.handle('cache:stats', () => netCache.stats());
ipcMain.handle('cache:clear', () => netCache.clear());

async function fetchWithRetry(u, accept) {
  if (process.env.LOTUS_SMOKE_OFFLINE) throw new Error('offline (smoke test)');
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(u, {
        headers: {
          'User-Agent': 'LotusWriter/0.1 (sci-fi writing desktop app)',
          Accept: accept || 'application/json',
        },
        signal: AbortSignal.timeout(12000),
      });
    } catch (err) {
      if (attempt < 2) continue; // 超时或断网：重试
      throw new Error(`${u.hostname} 无响应`);
    }
    // 被限流时按 Retry-After 退避，最多重试两次
    if ((res.status === 429 || res.status === 503) && attempt < 2) {
      const wait = Math.min(Number(res.headers.get('retry-after')) || 2 ** attempt * 1.5, 8);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    return { status: res.status, body: await res.text() };
  }
}

ipcMain.handle('ai:extract', async (_e, text) => {
  const settings = await readJSON(SETTINGS_FILE(), {});
  return extractConcepts(text, settings.anthropicApiKey);
});

ipcMain.handle('shell:open', (_e, url) => {
  if (/^https?:\/\//.test(url)) return shell.openExternal(url);
});

// 冒烟测试：用独立数据目录启动，等侧边栏出结果后截图并打印侧边栏文字。
async function runSmoke(win, outDir) {
  win.webContents.on('console-message', (e) => console.log('[renderer]', e.message));
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  if (process.env.LOTUS_SMOKE_TEXT) {
    await new Promise((r) => setTimeout(r, 1000));
    await win.webContents.executeJavaScript(`(() => {
      const ed = document.getElementById('editor');
      ed.value = ${JSON.stringify(process.env.LOTUS_SMOKE_TEXT)};
      ed.setSelectionRange(ed.value.length, ed.value.length);
      ed.dispatchEvent(new Event('input'));
    })()`);
  }
  const t0 = Date.now();
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    const expect = JSON.stringify((process.env.LOTUS_SMOKE_TEXT || '').slice(0, 6));
    const done = await win.webContents.executeJavaScript(
      `!!document.querySelector('#results .card, #results .empty, #results .error')
        && !document.getElementById('researchStatus').classList.contains('busy')
        && document.getElementById('contextPreview').textContent.includes(${expect})`,
    );
    if (done) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await new Promise((r) => setTimeout(r, 1500));
  const text = await win.webContents.executeJavaScript("document.getElementById('sidebar').innerText");
  console.log(`----- SIDEBAR (${Date.now() - t0} ms) -----\n` + text);
  console.log('----- CACHE -----', JSON.stringify(await netCache.stats()));
  const img = await win.webContents.capturePage();
  await fs.writeFile(path.join(outDir, 'smoke.png'), img.toPNG());

  // 打开第一张卡片，确认阅读器能渲染正文
  await win.webContents.executeJavaScript("document.querySelector('#results .card')?.click()");
  await new Promise((r) => setTimeout(r, 5000));
  const reader = await win.webContents.executeJavaScript("document.getElementById('readerBody').innerText.slice(0, 400)");
  console.log('----- READER -----\n' + reader);
  await fs.writeFile(path.join(outDir, 'reader.png'), (await win.webContents.capturePage()).toPNG());

  // 取名面板：每种风格各生成一批，再点第一个名字插入正文
  const names = await win.webContents.executeJavaScript(`(() => {
    document.getElementById('readerBack').click();
    document.querySelector('.wordmark').click();
    const out = {};
    for (const s of ['zh', 'west', 'ja', 'code']) out[s] = window.Names.batch(s, 'any').join(' / ');
    return out;
  })()`);
  console.log('----- NAMES -----\n' + Object.entries(names).map(([k, v]) => `${k}: ${v}`).join('\n'));
  await new Promise((r) => setTimeout(r, 300));
  await fs.writeFile(path.join(outDir, 'names.png'), (await win.webContents.capturePage()).toPNG());
  const inserted = await win.webContents.executeJavaScript(`(() => {
    const first = document.querySelector('#nameList .name-item');
    const name = first.textContent;
    first.click();
    return { name, tail: document.getElementById('editor').value.slice(-12),
             closed: document.getElementById('namePopover').classList.contains('hidden') };
  })()`);
  console.log('----- INSERT -----', JSON.stringify(inserted));
  app.quit();
}

if (process.env.LOTUS_SMOKE) app.setPath('userData', path.join(process.env.LOTUS_SMOKE, 'userdata'));

// 产品原名“Stellar 星图”：首次以 Lotus 启动时，把旧目录里的稿件、设置和缓存搬过来
async function migrateFromStellar() {
  const oldDir = path.join(app.getPath('appData'), 'Stellar 星图');
  const newDir = DATA_DIR();
  if (oldDir === newDir) return;
  try {
    await fs.access(path.join(oldDir, 'project.json'));
  } catch {
    return; // 没有旧数据
  }
  try {
    await fs.access(path.join(newDir, 'project.json'));
    return; // 已经迁移过或已有新稿件，不覆盖
  } catch {}
  await fs.mkdir(newDir, { recursive: true });
  for (const name of ['project.json', 'settings.json']) {
    await fs.copyFile(path.join(oldDir, name), path.join(newDir, name)).catch(() => {});
  }
  await fs.cp(path.join(oldDir, 'stellar-cache'), path.join(newDir, 'lotus-cache'), { recursive: true }).catch(() => {});
}

app.whenReady().then(async () => {
  await migrateFromStellar();
  netCache = new DiskCache(path.join(DATA_DIR(), 'lotus-cache'));
  netCache.prune();
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'fileMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  );
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
