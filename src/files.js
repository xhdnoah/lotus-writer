// 把每个章节镜像成一个 Markdown 文件：标题、正文、顺序一变就落盘。
// 文件夹里的 .lotus.json 记录“章节 id → 文件名”，用来处理改名、调序和删除。
const path = require('node:path');
const fs = require('node:fs/promises');
const { shell } = require('electron');

const MANIFEST = '.lotus.json';

function safeName(s) {
  return (s || '')
    .replace(/[\/\\:*?"<>|\r\n\t]/g, '-')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 80) || '未命名';
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, file);
}

function chapterMarkdown(c) {
  const title = c.title || '未命名章节';
  return `# ${title}\n\n${(c.text || '').trimEnd()}\n`;
}

class MarkdownMirror {
  constructor(defaultRoot) {
    this.defaultRoot = defaultRoot; // 例如 ~/Documents/Lotus
    this.written = new Map();       // 绝对路径 -> 最近一次写入的内容，避免重复写盘
    this.queue = Promise.resolve();  // 串行执行，防止两次保存交错改名
    this.lastDir = null;
  }

  // 给新项目挑一个不和别人冲突的文件夹
  async pickDefaultDir(title) {
    const base = path.join(this.defaultRoot, safeName(title || '未命名作品'));
    for (let i = 1; ; i++) {
      const dir = i === 1 ? base : `${base} (${i})`;
      if (!(await exists(dir))) return dir;
      if (await exists(path.join(dir, MANIFEST))) return dir; // 已经是 Lotus 的文件夹
      const entries = await fs.readdir(dir).catch(() => []);
      if (!entries.filter((n) => !n.startsWith('.')).length) return dir; // 空文件夹可以直接用
    }
  }

  // 所有改动磁盘的操作（写章节、git 切分支）都排进同一个队列，互不交错
  run(fn) {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  sync(dir, chapters) {
    return this.run(() => this._sync(dir, chapters));
  }

  // 磁盘内容被外部换掉（比如 git 切分支）后，丢掉“已写入”的记忆
  forget() {
    this.written.clear();
  }

  // 从文件夹读回章节：按 .lotus.json 认领 id，文件名前的序号决定顺序。
  // 文件夹里新出现的 .md（比如在别的编辑器里新建的）也会作为新章节读进来。
  async load(dir) {
    let manifest = {};
    try {
      manifest = JSON.parse(await fs.readFile(path.join(dir, MANIFEST), 'utf8')).files || {};
    } catch {}
    const idOf = new Map(Object.entries(manifest).map(([id, name]) => [name, id]));
    const names = (await fs.readdir(dir).catch(() => []))
      .filter((n) => n.toLowerCase().endsWith('.md') && !n.startsWith('.') && n.toLowerCase() !== 'readme.md')
      .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
    const chapters = [];
    for (const name of names) {
      const file = path.join(dir, name);
      const raw = (await fs.readFile(file, 'utf8')).replace(/\r\n/g, '\n');
      const m = raw.match(/^# (.*)\n(?:\n)?/);
      const title = m ? m[1].trim() : name.replace(/\.md$/i, '').replace(/^\d+\s+/, '');
      const text = (m ? raw.slice(m[0].length) : raw).replace(/\n+$/, '');
      const id = idOf.get(name) || 'c' + Date.now().toString(36) + chapters.length;
      chapters.push({ id, title, text });
      this.written.set(file, chapterMarkdown({ title, text }));
    }
    return chapters;
  }

  async _sync(dir, chapters) {
    await fs.mkdir(dir, { recursive: true });
    const manifestPath = path.join(dir, MANIFEST);
    let manifest = {};
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')).files || {};
    } catch {}

    // 目标文件名：“01 第一章 · 标题.md”，同名时追加序号
    const used = new Set();
    const desired = chapters.map((c, i) => {
      const stem = `${String(i + 1).padStart(2, '0')} ${safeName(c.title || '未命名章节')}`;
      let name = `${stem}.md`;
      for (let n = 2; used.has(name.toLowerCase()); n++) name = `${stem} (${n}).md`;
      used.add(name.toLowerCase());
      return { id: c.id, name, content: chapterMarkdown(c) };
    });

    // 改名分两步走（先挪到临时名，再挪到目标名），这样章节互换位置也不会互相覆盖
    const moves = desired.filter((d) => manifest[d.id] && manifest[d.id] !== d.name);
    const staged = [];
    for (const d of moves) {
      const from = path.join(dir, manifest[d.id]);
      if (!(await exists(from))) continue;
      const tmp = path.join(dir, `.${d.id}.lotus-move`);
      await fs.rename(from, tmp);
      this.written.delete(from);
      staged.push({ tmp, to: path.join(dir, d.name) });
    }
    for (const { tmp, to } of staged) {
      // 目标位置上有不归 Lotus 管的文件时，先把它送进废纸篓，不直接覆盖
      if (await exists(to)) await shell.trashItem(to);
      await fs.rename(tmp, to);
    }

    for (const d of desired) {
      const file = path.join(dir, d.name);
      if (this.written.get(file) === d.content && (await exists(file))) continue;
      await writeAtomic(file, d.content);
      this.written.set(file, d.content);
    }

    // 已删除的章节：文件移到废纸篓，可以找回
    const keep = new Set(desired.map((d) => d.id));
    for (const [id, name] of Object.entries(manifest)) {
      if (keep.has(id)) continue;
      const file = path.join(dir, name);
      if (await exists(file)) await shell.trashItem(file);
      this.written.delete(file);
    }

    await writeAtomic(manifestPath, JSON.stringify({ files: Object.fromEntries(desired.map((d) => [d.id, d.name])) }, null, 2));
    this.lastDir = dir;
    return { dir, count: desired.length };
  }
}

module.exports = { MarkdownMirror };
