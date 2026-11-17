const { app, BrowserWindow, ipcMain, shell, Menu, dialog, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { extractConcepts } = require('./ai');
const { DiskCache } = require('./cache');
const { MarkdownMirror } = require('./files');
const git = require('./git');
const { gateFor, sleep } = require('./throttle');
const dify = require('./dify');
const { DifySync } = require('./difysync');

const DATA_DIR = () => app.getPath('userData');
const PROJECT_FILE = () => path.join(DATA_DIR(), 'project.json');
const SETTINGS_FILE = () => path.join(DATA_DIR(), 'settings.json');

// Hosts the renderer may query through the main process. Everything else is refused.
const FETCH_ALLOWLIST = [/^([a-z-]+\.)?wikipedia\.org$/, /^export\.arxiv\.org$/, /^www\.wikidata\.org$/];

// 查询过的条目存在本机：7 天内直接用缓存，过期后重新拉取；网络失败时退回旧缓存
const CACHE_FRESH_MS = 7 * 24 * 60 * 60 * 1000;
let netCache = null;
let mirror = null;
let difySync = null;
let quitting = false;
app.on('before-quit', () => { quitting = true; });

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
    // 冒烟测试的窗口不抢键盘焦点，免得截走正在写作的输入
    show: !process.env.LOTUS_SMOKE,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.env.LOTUS_SMOKE) {
    win.once('ready-to-show', () => win.showInactive());
    runSmoke(win, process.env.LOTUS_SMOKE);
  }

  // 关窗前让页面把没写完的内容落盘，最多等 3 秒
  // 拦下关闭会顺带取消正在进行的退出，所以落盘后要把退出接着做完
  let flushing = false;
  win.on('close', (e) => {
    if (flushing) return;
    e.preventDefault();
    flushing = true;
    const finish = () => {
      if (win.isDestroyed()) return;
      win.destroy();
      if (quitting) app.quit();
    };
    ipcMain.once('app:flushed', finish);
    win.webContents.send('app:flush');
    setTimeout(finish, 3000);
  });

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
const SECRET_FIELDS = ['anthropicApiKey', 'difyApiKey', 'difyWorkflowKey'];
async function loadSettings() {
  const data = await readJSON(SETTINGS_FILE(), {});
  for (const key of SECRET_FIELDS) {
    if (data[key] && data[key].startsWith('encrypted:')) {
      data[key] = safeStorage.decryptString(Buffer.from(data[key].slice(10), 'base64'));
    }
  }
  return data;
}
async function saveSettings(data) {
  const stored = { ...data };
  for (const key of SECRET_FIELDS) {
    if (!stored[key]) continue;
    if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
      throw new Error('系统安全存储不可用，无法保存 API Key；请先配置系统密钥环');
    }
    stored[key] = 'encrypted:' + safeStorage.encryptString(stored[key]).toString('base64');
  }
  await writeJSON(SETTINGS_FILE(), stored);
  await fs.chmod(SETTINGS_FILE(), 0o600);
}
ipcMain.handle('settings:load', loadSettings);
ipcMain.handle('settings:save', (_e, data) => saveSettings(data));

// ---------- Markdown 文稿与 git ----------
// 世界观设定放在文稿文件夹的子目录里，和章节一样一条一个 Markdown，也一起受 git 管理
const worldDir = (dir) => path.join(dir, '世界观');

ipcMain.handle('files:prepare', async (_e, title, folder) => {
  const dir = folder || (await mirror.pickDefaultDir(title));
  await fs.mkdir(dir, { recursive: true });
  return mirror.run(async () => {
    await git.ensureRepo(dir);
    const chapters = await mirror.load(dir);
    const world = await mirror.load(worldDir(dir));
    return { dir, chapters: chapters.length ? chapters : null, world: chapters.length ? world : null };
  });
});

ipcMain.handle('files:sync', async (_e, dir, chapters, world) => {
  const res = await mirror.sync(dir, chapters);
  await mirror.sync(worldDir(dir), world || []);
  mirror.lastDir = dir; // “在 Finder 中显示文稿”打开作品根目录，而不是世界观子目录
  // 新仓库在第一次写完章节后留一个起点版本
  await mirror.run(async () => {
    if (!(await git.hasCommits(dir))) await git.commitAll(dir, '初始版本');
  });
  return res;
});

ipcMain.handle('files:choose', async (e) => {
  const res = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
    title: '选择存放 Markdown 文稿的文件夹',
    properties: ['openDirectory', 'createDirectory'],
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('files:reveal', (_e, dir) => shell.openPath(dir));

ipcMain.handle('git:status', (_e, dir) => mirror.run(() => git.status(dir)));
ipcMain.handle('git:commit', (_e, dir, message) => mirror.run(() => git.commitAll(dir, message || '保存版本')));
ipcMain.handle('git:delete', (_e, dir, name) => mirror.run(() => git.deleteBranch(dir, name)));
// 切换或新建分支后，磁盘上的稿件换了一套，把章节重新读回来
for (const [channel, op] of [['git:switch', git.switchBranch], ['git:create', git.createBranch]]) {
  ipcMain.handle(channel, (_e, dir, name) => mirror.run(async () => {
    await op(dir, name);
    mirror.forget();
    return { chapters: await mirror.load(dir), world: await mirror.load(worldDir(dir)) };
  }));
}

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

// 被限流（429/503）时按 Retry-After 或指数退避重试，最多等约一分钟；超时/断网也重试
const MAX_ATTEMPTS = 6;
let fakeLimited = Number(process.env.LOTUS_SMOKE_429 || 0); // 测试用：前 N 次请求假装被限流

async function fetchWithRetry(u, accept) {
  if (process.env.LOTUS_SMOKE_OFFLINE) throw new Error('offline (smoke test)');
  const gate = gateFor(u.hostname);
  for (let attempt = 0; ; attempt++) {
    await gate.acquire();
    let res;
    try {
      if (fakeLimited > 0) {
        fakeLimited--;
        res = new Response('', { status: 429, headers: { 'retry-after': '1' } });
      } else {
        res = await fetch(u, {
          headers: {
            // 维基媒体要求 User-Agent 带上项目信息，否则更容易被限流
            'User-Agent': 'LotusWriter/0.1 (https://github.com/xhdnoah/lotus-writer; sci-fi writing desktop app)',
            'Api-User-Agent': 'LotusWriter/0.1 (https://github.com/xhdnoah/lotus-writer)',
            Accept: accept || 'application/json',
          },
          signal: AbortSignal.timeout(15000),
        });
      }
    } catch (err) {
      gate.release();
      if (attempt < 2) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw new Error(`${u.hostname} 无响应`);
    }
    if ((res.status === 429 || res.status === 503) && attempt < MAX_ATTEMPTS - 1) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const wait = Math.min(retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt, 30000);
      gate.cooldown(wait); // 同站的其他请求也一起等
      gate.release();
      console.warn(`[net] ${u.hostname} ${res.status}，${wait / 1000}s 后重试（第 ${attempt + 1} 次）`);
      continue;
    }
    try {
      return { status: res.status, body: await res.text() };
    } finally {
      gate.release();
    }
  }
}

ipcMain.handle('dify:retrieve', async (_e, query, override) => {
  // override 用于设置里的“测试连接”：还没保存的配置也能先试
  const cfg = override || (await loadSettings());
  return dify.retrieve(cfg, query);
});

// 章节和世界观设定同步进 Dify 知识库（设置里开启了 Dify 且没关自动同步时）
ipcMain.handle('dify:sync', async (_e, items) => {
  const cfg = await loadSettings();
  const on = cfg.sources && cfg.sources.dify && cfg.difyApiKey && cfg.difyDatasetId && cfg.difyAutoSync === true;
  if (!on) return { skipped: true };
  if (!difySync) difySync = new DifySync(path.join(DATA_DIR(), 'dify-sync.json'));
  console.log(`[dify-sync] ${items.length} 项开始同步`);
  const summary = await difySync.sync(cfg, items).catch((err) => {
    console.warn('[dify-sync] 失败：', err.message);
    throw err;
  });
  console.log('[dify-sync] 完成', JSON.stringify(summary));
  if (summary.created || summary.updated || summary.deleted) dify.clearCache();
  return summary;
});

ipcMain.handle('dify:extract', async (_e, text) => {
  const cfg = await loadSettings();
  return dify.extractConcepts(cfg, text);
});

ipcMain.handle('ai:extract', async (_e, text) => {
  const settings = await loadSettings();
  return extractConcepts(text, settings.anthropicApiKey);
});

ipcMain.handle('shell:open', (_e, url) => {
  if (/^https?:\/\//.test(url)) return shell.openExternal(url);
});

// 冒烟测试（分支）：主线写一句 → 新建分支改稿 → 切回主线，检查编辑器内容随分支变化
async function smokeGit(win) {
  const js = (code) => win.webContents.executeJavaScript(code);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const type = (text) => js(`(() => { const ed = document.getElementById('editor');
    ed.value = ${JSON.stringify(text)}; ed.dispatchEvent(new Event('input')); })()`);
  const editorText = () => js("document.getElementById('editor').value");
  const branch = () => js("document.getElementById('branchName').textContent");

  await type('主线：飞船抵达比邻星。');
  await wait(1500);
  console.log('----- GIT 1 main -----', await branch(), JSON.stringify(await editorText()));
  await js(`(() => { document.getElementById('newBranch').value = '结局B';
    document.getElementById('createBranch').click(); })()`);
  await wait(2000);
  await type('结局B：飞船在虫洞里迷失。');
  await wait(1500);
  console.log('----- GIT 2 branch -----', await branch(), JSON.stringify(await editorText()));
  await js(`(() => { document.getElementById('branchBtn').click(); })()`);
  await wait(1000);
  await js(`[...document.querySelectorAll('#branchList li')].find((li) => li.textContent.startsWith('main')).click()`);
  await wait(2000);
  console.log('----- GIT 3 back to main -----', await branch(), JSON.stringify(await editorText()));
  await js(`document.getElementById('branchPopover').classList.contains('hidden') && document.getElementById('branchBtn').click()`);
  await wait(800);
  await fs.writeFile(path.join(process.env.LOTUS_SMOKE, 'branches.png'), (await win.webContents.capturePage()).toPNG());
  console.log('----- GIT DIR -----', mirror.lastDir);
}

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
      document.getElementById('refreshResearch').click();
    })()`);
    await new Promise((r) => setTimeout(r, 500));
  }
  const t0 = Date.now();
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    const expect = JSON.stringify((process.env.LOTUS_SMOKE_TEXT || '').slice(0, 6));
    const done = await win.webContents.executeJavaScript(
      `!!document.querySelector('#results .card, #results .empty, #results .error')
        && !document.getElementById('researchStatus').classList.contains('busy')
        && document.getElementById('editor').value.startsWith(${expect})`,
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
    document.querySelector('.name-trigger').click();
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

  if (process.env.LOTUS_SMOKE_SETTINGS) {
    // 打开设置，用 Dify 的“测试连接”试一次，截图
    const result = await win.webContents.executeJavaScript(`(async () => {
      document.getElementById('openSettings').click();
      document.getElementById('difyTest').click();
      for (let i = 0; i < 40 && /连接中|^$/.test(document.getElementById('difyTestResult').textContent); i++)
        await new Promise((r) => setTimeout(r, 250));
      return document.getElementById('difyTestResult').textContent;
    })()`);
    console.log('----- DIFY TEST -----', result);
    await fs.writeFile(path.join(outDir, 'settings.png'), (await win.webContents.capturePage()).toPNG());
  }
  if (process.env.LOTUS_SMOKE_SAVE_SETTINGS) {
    // 打开设置直接点保存，检查 settings.json 是否写出
    const err = await win.webContents.executeJavaScript(`(async () => {
      try {
        document.getElementById('openSettings').click();
        await new Promise((r) => setTimeout(r, 300));
        document.getElementById('difyDatasetId').value = 'probe';
        document.getElementById('settingsSave').click();
        await new Promise((r) => setTimeout(r, 1500));
        return 'modal hidden: ' + document.getElementById('settingsModal').classList.contains('hidden');
      } catch (e) { return 'ERR ' + e.message; }
    })()`);
    const saved = await readJSON(SETTINGS_FILE(), null);
    console.log('----- SAVE SETTINGS -----', err, saved ? 'file ok, dataset=' + saved.difyDatasetId : 'NO FILE');
  }
  if (process.env.LOTUS_SMOKE_WORLD) {
    // 新建一条世界观设定 → 切回第一章触发 Dify 同步 → 再删掉设定、触发一次同步
    const js = (code) => win.webContents.executeJavaScript(code);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await js(`(() => {
      document.querySelector('.tab[data-tab="world"]').click();
      document.getElementById('addWorld').click();
      const t = document.querySelector('.world-title');
      t.value = '冰比水重'; t.dispatchEvent(new Event('input'));
      const ed = document.querySelector('.world-text');
      ed.value = '在这个宇宙里，冰的密度大于水，所以海洋从底部开始结冰。'; ed.dispatchEvent(new Event('input'));
    })()`);
    await wait(1500);
    await fs.writeFile(path.join(outDir, 'world.png'), (await win.webContents.capturePage()).toPNG());
    await js(`document.querySelector('#chapterList li').click()`);
    await wait(4000);
    console.log('----- WORLD SYNC 1 -----', await js(`document.getElementById('difyState').textContent + ' | ' + document.getElementById('difyState').title`));
    await js(`(() => { window.confirm = () => true; document.querySelector('.world-card .del').click(); })()`);
    await wait(1500);
    await js(`document.querySelector('#chapterList li:nth-child(2)').click()`);
    await wait(4000);
    console.log('----- WORLD SYNC 2 -----', await js(`document.getElementById('difyState').textContent + ' | ' + document.getElementById('difyState').title`));
    console.log('----- WORLD FILES -----', JSON.stringify(await fs.readdir(path.join(mirror.lastDir, '世界观')).catch((e) => e.message)));
  }
  if (process.env.LOTUS_SMOKE_IDLE) {
    // 什么都不做，等自动同步的定时器触发
    await new Promise((r) => setTimeout(r, Number(process.env.LOTUS_SMOKE_IDLE) * 1000));
    console.log('----- IDLE DONE -----', await win.webContents.executeJavaScript(`document.getElementById('difyState').textContent`));
  }
  if (process.env.LOTUS_SMOKE_GIT) await smokeGit(win);
  if (process.env.LOTUS_SMOKE_DELETE) {
    // 一章一章删到底，包括最后一章
    const titles = await win.webContents.executeJavaScript(`(async () => {
      window.confirm = () => true;
      for (let i = 0; i < 4; i++) {
        document.querySelector('#chapterList li .del').click();
        await new Promise((r) => setTimeout(r, 300));
      }
      await new Promise((r) => setTimeout(r, 1200));
      return [...document.querySelectorAll('#chapterList li .name')].map((n) => n.textContent);
    })()`);
    console.log('----- DELETE -----', JSON.stringify(titles), JSON.stringify(await fs.readdir(mirror.lastDir)));
  }
  app.quit();
}

if (process.env.LOTUS_SMOKE) app.setPath('userData', path.join(process.env.LOTUS_SMOKE, 'userdata'));

// 产品原名“Stellar 星图”：首次以 Lotus 启动时，把旧目录里的稿件、设置和缓存搬过来
async function migrateFromStellar() {
  if (process.env.LOTUS_SMOKE) return; // 测试用独立目录，不搬真实数据
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
  // 将旧版本的明文密钥迁移至系统安全存储，不把密钥写入日志。
  const oldSettings = await readJSON(SETTINGS_FILE(), {});
  if (SECRET_FIELDS.some((key) => oldSettings[key] && !oldSettings[key].startsWith('encrypted:'))) {
    await saveSettings(await loadSettings());
  }
  netCache = new DiskCache(path.join(DATA_DIR(), 'lotus-cache'));
  const docsRoot = process.env.LOTUS_SMOKE ? path.join(process.env.LOTUS_SMOKE, 'Documents') : app.getPath('documents');
  mirror = new MarkdownMirror(path.join(docsRoot, 'Lotus'));
  netCache.prune();
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      {
        label: '文件',
        submenu: [
          { label: '在 Finder 中显示文稿', click: () => mirror && mirror.lastDir && shell.openPath(mirror.lastDir) },
          { type: 'separator' },
          { role: 'close' },
        ],
      },
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
