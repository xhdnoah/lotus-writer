// 把章节和世界观设定同步进 Dify 知识库：每一项是一个文档，项目由调用方给出 {id, name, text}。
// 只同步内容有变化的项；项目删掉后，对应文档也从知识库删除。
// 记录（项目 id → Dify 文档 id + 内容哈希）存在 userData/dify-sync.json，按知识库分开。
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { gateFor, sleep } = require('./throttle');

const { normalizeBase } = require('./dify');
const base = (cfg) => normalizeBase(cfg.difyBaseUrl);

async function call(cfg, method, route, body) {
  const url = `${base(cfg)}/datasets/${encodeURIComponent(cfg.difyDatasetId.trim())}${route}`;
  const gate = gateFor(new URL(url).hostname);
  for (let attempt = 0; ; attempt++) {
    await gate.acquire();
    let res;
    try {
      res = await fetch(url, {
        method,
        redirect: 'error',
        headers: { Authorization: `Bearer ${cfg.difyApiKey.trim()}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      gate.release();
      if (attempt < 1) continue;
      throw new Error('连不上 Dify');
    }
    const text = await res.text();
    gate.release();
    // 429 限流；503 是 Sandbox 套餐的“稍后再试”
    if ((res.status === 429 || res.status === 503) && attempt < 3) {
      await sleep(3000 * 2 ** attempt);
      continue;
    }
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {}
    return { status: res.status, data };
  }
}

function failure(res, what) {
  const msg = (res.data && res.data.message) || '';
  if (res.status === 401) return new Error('Dify API Key 无效');
  if (res.status === 403) return new Error(`Dify 拒绝${what}：${msg}`);
  return new Error(`Dify ${what}失败（${res.status}）${msg ? '：' + msg : ''}`);
}

const hashOf = (name, text) => crypto.createHash('sha1').update(name + '\0' + text).digest('hex');

class DifySync {
  constructor(stateFile) {
    this.stateFile = stateFile;
    this.queue = Promise.resolve();
  }

  async loadState() {
    try {
      return JSON.parse(await fs.readFile(this.stateFile, 'utf8'));
    } catch {
      return {};
    }
  }

  async saveState(state) {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    const tmp = this.stateFile + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(tmp, this.stateFile);
  }

  sync(cfg, items) {
    const run = this.queue.then(() => this._sync(cfg, items));
    this.queue = run.catch(() => {});
    return run;
  }

  // 知识库里已有的文档，按名字认领（比如之前手动上传的“旅行者的故事.md”），避免重复
  async listDocs(cfg) {
    const docs = [];
    for (let page = 1; page < 50; page++) {
      const res = await call(cfg, 'GET', `/documents?page=${page}&limit=100`);
      if (res.status !== 200) throw failure(res, '读取文档列表');
      docs.push(...res.data.data);
      if (!res.data.has_more) break;
    }
    return docs;
  }

  async _sync(cfg, items) {
    const all = await this.loadState();
    const ds = cfg.difyDatasetId.trim();
    const firstTime = !all[ds];
    const state = (all[ds] = all[ds] || {});
    const save = () => this.saveState(all);
    const summary = { created: 0, updated: 0, deleted: 0, unchanged: 0 };

    if (firstTime) {
      const byName = new Map((await this.listDocs(cfg)).map((d) => [d.name, d.id]));
      for (const it of items) {
        // 也认没有序号的旧名字（比如手动上传的“旅行者的故事.md”）
        const bare = it.name.replace(/^\d+ /, '');
        const id = byName.get(it.name) || byName.get(bare) || byName.get(bare.replace(/\.md$/, ''));
        if (id) state[it.id] = { docId: id, hash: null, name: it.name };
      }
      await save();
    }

    for (const it of items) {
      const { name, text } = it;
      if (!it.hasBody) continue; // 没有正文的不上传
      const hash = hashOf(name, text + JSON.stringify(it.processRule || null)); // 分段规则变了也要重新上传
      const rec = state[it.id];
      if (rec && rec.hash === hash) {
        summary.unchanged++;
        continue;
      }
      if (rec) {
        const res = await call(cfg, 'POST', `/documents/${rec.docId}/update-by-text`, { name, text, ...(it.processRule && { process_rule: it.processRule }) });
        if (res.status === 200) {
          state[it.id] = { docId: rec.docId, hash, name };
          summary.updated++;
          await save();
          continue;
        }
        if (res.status !== 404) throw failure(res, `更新「${name}」`);
        // 文档在 Dify 里被删了：重新创建
      }
      const body = { name, text, process_rule: it.processRule || { mode: 'automatic' } };
      let res = await call(cfg, 'POST', '/document/create-by-text', body);
      // 空知识库的第一个文档必须指定索引方式；之后的文档沿用知识库的设置。
      // 先试高质量（向量）索引；工作区没配 Embedding 模型时退回经济（关键词）索引，以后可在 Dify 里升级
      const needsTechnique = (r) => r.status === 400 && /indexing_technique/.test(JSON.stringify(r.data || ''));
      const noEmbedding = (r) => r.status === 400 && /model not found|text-embedding/i.test(JSON.stringify(r.data || ''));
      if (needsTechnique(res)) res = await call(cfg, 'POST', '/document/create-by-text', { ...body, indexing_technique: 'high_quality' });
      if (noEmbedding(res)) res = await call(cfg, 'POST', '/document/create-by-text', { ...body, indexing_technique: 'economy' });
      if (res.status !== 200) throw failure(res, `上传「${name}」`);
      state[it.id] = { docId: res.data.document.id, hash, name };
      summary.created++;
      await save();
    }

    const live = new Set(items.map((it) => it.id));
    for (const [chapterId, rec] of Object.entries(state)) {
      if (live.has(chapterId)) continue;
      const res = await call(cfg, 'DELETE', `/documents/${rec.docId}`);
      if (res.status !== 204 && res.status !== 200 && res.status !== 404) throw failure(res, `删除「${rec.name}」`);
      delete state[chapterId];
      summary.deleted++;
      await save();
    }
    return summary;
  }
}

module.exports = { DifySync };
