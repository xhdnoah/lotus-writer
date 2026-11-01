// 维基百科 / arXiv 响应的磁盘缓存：查询过的内容存到本机，重启后也能复用，断网时退回旧数据。
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');

const MAX_FILES = 5000;
const MEMORY_ITEMS = 300;

class DiskCache {
  constructor(dir) {
    this.dir = dir;
    this.memory = new Map();
  }

  file(url) {
    const hash = crypto.createHash('sha1').update(url).digest('hex');
    return path.join(this.dir, hash.slice(0, 2), hash + '.json');
  }

  remember(url, entry) {
    this.memory.delete(url);
    this.memory.set(url, entry);
    if (this.memory.size > MEMORY_ITEMS) this.memory.delete(this.memory.keys().next().value);
  }

  // 返回 { at, res } 或 null
  async get(url) {
    if (this.memory.has(url)) return this.memory.get(url);
    try {
      const entry = JSON.parse(await fs.readFile(this.file(url), 'utf8'));
      if (entry.url !== url) return null; // 哈希碰撞
      this.remember(url, entry);
      return entry;
    } catch {
      return null;
    }
  }

  async set(url, res) {
    const entry = { url, at: Date.now(), res };
    this.remember(url, entry);
    const file = this.file(url);
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(entry), 'utf8');
      await fs.rename(tmp, file);
    } catch (err) {
      console.warn('cache write failed:', err.message);
    }
  }

  async list() {
    const out = [];
    let shards = [];
    try {
      shards = await fs.readdir(this.dir);
    } catch {
      return out;
    }
    for (const shard of shards) {
      const sub = path.join(this.dir, shard);
      let names = [];
      try {
        names = await fs.readdir(sub);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const file = path.join(sub, name);
        try {
          const st = await fs.stat(file);
          out.push({ file, size: st.size, mtime: st.mtimeMs });
        } catch {}
      }
    }
    return out;
  }

  async stats() {
    const files = await this.list();
    return { count: files.length, bytes: files.reduce((n, f) => n + f.size, 0) };
  }

  // 文件数超过上限时删掉最旧的
  async prune() {
    const files = await this.list();
    if (files.length <= MAX_FILES) return;
    files.sort((a, b) => a.mtime - b.mtime);
    await Promise.all(files.slice(0, files.length - MAX_FILES).map((f) => fs.rm(f.file, { force: true })));
  }

  async clear() {
    this.memory.clear();
    await fs.rm(this.dir, { recursive: true, force: true });
  }
}

module.exports = { DiskCache };
