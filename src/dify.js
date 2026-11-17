// Dify 知识库检索：POST {base}/datasets/{dataset_id}/retrieve，用知识库 API Key。
// 地址可以是 Dify 云（https://api.dify.ai/v1）或自部署实例。
const { gateFor, sleep } = require('./throttle');

const MAX_QUERY = 250; // Dify 对 query 的长度上限
const CACHE_MS = 10 * 60 * 1000;
const PAUSE_MS = 2 * 60 * 1000;
const cache = new Map();
let pausedUntil = 0; // 被 Dify 限频后暂停检索，把请求额度留给同步
// 知识库自己的检索设置用不了时，本次运行改用的检索设置（null 表示用知识库自己的）
let override = null;

// 重排模型额度用完：改用不重排的向量检索
const NO_RERANK = { search_method: 'semantic_search', reranking_enable: false, top_k: 3, score_threshold_enabled: false };
// 工作区没有 Embedding 模型（经济索引的知识库）：只能用关键词检索
const KEYWORD = { search_method: 'keyword_search', reranking_enable: false, top_k: 3, score_threshold_enabled: false };

function normalizeBase(base) {
  const u = new URL((base || 'https://api.dify.ai/v1').trim());
  if (u.username || u.password || u.search || u.hash) throw new Error('Dify 地址不能包含凭据、查询参数或片段');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    throw new Error('Dify 必须使用 HTTPS（仅本机 localhost 允许 HTTP）');
  }
  return u.href.replace(/\/+$/, '');
}

function explain(status, body) {
  let msg = '';
  try {
    msg = JSON.parse(body).message || '';
  } catch {}
  if (status === 401) return 'Dify API Key 无效（需要知识库 API Key，不是应用的 Key）';
  if (status === 403) return `Dify 拒绝访问：${msg || '这个 Key 没有权限访问该知识库'}`;
  if (status === 404) return 'Dify 找不到这个知识库，检查知识库 ID 和地址';
  if (status === 400 && /quota exceeded/i.test(msg)) return `Dify 的模型额度用完了（${msg}）`;
  if (status === 403 && /rate limit/i.test(msg)) return 'Dify 请求太频繁（免费版的频率上限），2 分钟后再查';
  if (status === 400) return `Dify 请求无效：${msg || status}`;
  return `Dify 错误 ${status}${msg ? '：' + msg : ''}`;
}

async function retrieve(cfg, query) {
  const { difyBaseUrl, difyApiKey, difyDatasetId } = cfg;
  if (!difyApiKey || !difyDatasetId) throw new Error('还没有填写 Dify 知识库的 API Key 和知识库 ID');
  const q = query.trim().slice(0, MAX_QUERY);
  const url = `${normalizeBase(difyBaseUrl)}/datasets/${encodeURIComponent(difyDatasetId.trim())}/retrieve`;
  const key = `${url}\n${difyApiKey}\n${q}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.records;
  if (Date.now() < pausedUntil) {
    throw new Error(`Dify 请求太频繁，${Math.ceil((pausedUntil - Date.now()) / 1000)} 秒后再查`);
  }

  const gate = gateFor(new URL(url).hostname);
  for (let attempt = 0; ; attempt++) {
    await gate.acquire();
    let res;
    try {
      // 默认不传 retrieval_model，用知识库自己配置的检索方式和阈值
      res = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: `Bearer ${difyApiKey.trim()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(override ? { query: q, retrieval_model: override } : { query: q }),
        signal: AbortSignal.timeout(20000),
      });
    } catch (err) {
      gate.release();
      if (attempt < 1) continue;
      throw new Error(`连不上 Dify（${new URL(url).host}）`);
    }
    const body = await res.text();
    gate.release();
    if (res.status === 429 && attempt < 3) {
      await sleep(2000 * 2 ** attempt);
      continue;
    }
    if (res.status === 400 && /model not found|text-embedding/i.test(body) && override !== KEYWORD) {
      override = KEYWORD;
      continue;
    }
    if (res.status === 400 && /quota exceeded/i.test(body) && !override) {
      // 多半是重排模型的额度用完了：换成不重排的向量检索再试
      override = NO_RERANK;
      continue;
    }
    if (res.status === 403 && /rate limit/i.test(body)) pausedUntil = Date.now() + PAUSE_MS;
    if (!res.ok) throw new Error(explain(res.status, body));
    const records = (JSON.parse(body).records || []).map((r) => ({
      id: r.segment.id,
      score: typeof r.score === 'number' ? r.score : null,
      content: r.segment.content || '',
      answer: r.segment.answer || '',
      keywords: r.segment.keywords || [],
      position: r.segment.position,
      docId: r.segment.document_id,
      docName: (r.segment.document && r.segment.document.name) || '未命名文档',
    }));
    cache.set(key, { at: Date.now(), records });
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    return records;
  }
}

// ---------- Dify 工作流：用你在 Dify 里配的大模型从整章里识别概念 ----------
// 应用的输入变量是 text，输出变量 result 是一段 JSON：{"concepts":[{phrase, zh, en, why}]}（见 dify/lotus-concepts.yml）
const MAX_TEXT = 30000;

function parseConcepts(raw) {
  let s = String(raw || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```(?:json)?/g, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('Dify 工作流没有返回 JSON');
  const data = JSON.parse(s.slice(a, b + 1));
  const list = Array.isArray(data.concepts) ? data.concepts : [];
  return list
    .filter((c) => c && typeof c.zh === 'string' && c.zh.trim())
    .map((c) => ({ phrase: String(c.phrase || c.zh).trim(), zh: c.zh.trim(), en: String(c.en || '').trim(), why: String(c.why || '').trim() }))
    .slice(0, 20);
}

async function extractConcepts(cfg, text) {
  if (!cfg.difyWorkflowKey) throw new Error('还没有填写 Dify 工作流应用的 API Key（app- 开头）');
  const url = `${normalizeBase(cfg.difyBaseUrl)}/workflows/run`;
  const gate = gateFor(new URL(url).hostname);
  await gate.acquire();
  let res, body;
  try {
    res = await fetch(url, {
      method: 'POST',
        redirect: 'error',
      headers: { Authorization: `Bearer ${cfg.difyWorkflowKey.trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: { text: text.slice(0, MAX_TEXT) }, response_mode: 'blocking', user: 'lotus' }),
      signal: AbortSignal.timeout(120000),
    });
    body = await res.text();
  } catch {
    throw new Error(`连不上 Dify 工作流（${new URL(url).host}）`);
  } finally {
    gate.release();
  }
  if (!res.ok) {
    if (res.status === 401) throw new Error('Dify 工作流的 API Key 无效（需要应用的 Key，以 app- 开头）');
    throw new Error(explain(res.status, body));
  }
  const d = (JSON.parse(body).data) || {};
  if (d.status !== 'succeeded') throw new Error(`Dify 工作流运行失败：${(d.error || d.status || '').slice(0, 200)}`);
  return parseConcepts(d.outputs && d.outputs.result);
}

// 知识库内容同步过后，旧的检索结果作废
function clearCache() {
  cache.clear();
}

module.exports = { normalizeBase, retrieve, clearCache, extractConcepts, parseConcepts };
