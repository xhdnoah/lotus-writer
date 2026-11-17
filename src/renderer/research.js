// 资料侧边栏：从整章内容找出概念 → 查维基百科 / arXiv → 渲染卡片与阅读器。
(function () {
  const $ = (id) => document.getElementById(id);

  // 极小的 DOM 构造器；远端文本一律走 textContent，从不拼 HTML。
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }

  // ---------------- 网络 ----------------
  let staleHits = 0; // 本轮查询里因网络失败而用了过期缓存的次数
  async function wiki(lang, params) {
    const qs = new URLSearchParams({ format: 'json', formatversion: '2', ...params });
    if (lang === 'zh') qs.set('variant', 'zh-cn');
    const res = await window.lotus.get(`https://${lang}.wikipedia.org/w/api.php?${qs}`);
    if (res.stale) staleHits++;
    if (res.status !== 200) throw new Error(`Wikipedia ${res.status}`);
    return JSON.parse(res.body);
  }

  // 把一组候选标题解析为真实存在、非消歧义的条目。返回 Map<输入, 规范标题>
  // 已核对过的词记下来（不存在的记为 null），整章重查时只问新出现的词。
  // 值是 [规范标题, 简短描述]；存进 localStorage，重启后不用重新核对。
  const MEMO_KEY = 'lotus.resolveMemo.v3';
  const MEMO_MAX = 40000;
  const resolveMemo = { zh: new Map(), en: new Map() };
  try {
    const saved = JSON.parse(localStorage.getItem(MEMO_KEY) || '{}');
    for (const lang of ['zh', 'en']) for (const [k, v] of saved[lang] || []) resolveMemo[lang].set(k, v);
  } catch {}
  let memoSaveTimer = null;
  function saveMemo() {
    clearTimeout(memoSaveTimer);
    memoSaveTimer = setTimeout(() => {
      try {
        const dump = {};
        for (const lang of ['zh', 'en']) dump[lang] = [...resolveMemo[lang]].slice(-MEMO_MAX);
        localStorage.setItem(MEMO_KEY, JSON.stringify(dump));
      } catch {}
    }, 2000);
  }
  const descOf = new Map(); // 规范标题 -> 简短描述
  const redirectedInputs = new Set(); // 经重定向才找到条目的原文词

  async function resolveTitles(lang, inputs) {
    const memo = resolveMemo[lang];
    const result = new Map();
    const unknown = [...new Set(inputs.filter((t) => !memo.has(t)))];
    for (let i = 0; i < unknown.length; i += 50) {
      const chunk = unknown.slice(i, i + 50);
      const data = await wiki(lang, {
        action: 'query', titles: chunk.join('|'), redirects: '1', converttitles: '1',
        prop: 'pageprops|description', ppprop: 'disambiguation',
      });
      const q = data.query || {};
      const hop = new Map();
      const redirectFrom = new Set(); // 真正的重定向（不算繁简转换和大小写规范化）
      for (const list of [q.normalized, q.converted, q.redirects]) {
        for (const { from, to } of list || []) hop.set(from, to);
      }
      for (const { from } of q.redirects || []) redirectFrom.add(from);
      const ok = new Map(
        (q.pages || [])
          .filter((p) => !p.missing && !p.invalid && !(p.pageprops && 'disambiguation' in p.pageprops))
          .map((p) => [p.title, p.description || '']),
      );
      for (const input of chunk) {
        let t = input;
        let redirected = false;
        for (let n = 0; n < 4 && hop.has(t); n++) {
          if (redirectFrom.has(t)) redirected = true;
          t = hop.get(t);
        }
        memo.set(input, ok.has(t) ? [t, ok.get(t), redirected] : null);
      }
    }
    if (unknown.length) saveMemo();
    for (const input of inputs) {
      const hit = memo.get(input);
      if (!hit) continue;
      result.set(input, hit[0]);
      descOf.set(hit[0], hit[1]);
      if (hit[2]) redirectedInputs.add(input);
    }
    return result;
  }

  // 摘要接口一次最多返回 20 条，所以分批
  async function summaries(lang, titles) {
    const out = [];
    for (let i = 0; i < titles.length; i += 20) out.push(...(await summaryBatch(lang, titles.slice(i, i + 20))));
    return out;
  }

  async function summaryBatch(lang, titles) {
    if (!titles.length) return [];
    const params = {
      action: 'query', titles: titles.join('|'), redirects: '1',
      prop: 'extracts|pageimages|info' + (lang === 'zh' ? '|langlinks' : ''),
      exintro: '1', explaintext: '1', exsentences: '3', exlimit: 'max',
      piprop: 'thumbnail', pithumbsize: '160', pilimit: 'max', inprop: 'url|varianttitles',
    };
    if (lang === 'zh') Object.assign(params, { lllang: 'en', lllimit: 'max' });
    const data = await wiki(lang, params);
    const pages = (data.query && data.query.pages) || [];
    const byTitle = new Map(pages.filter((p) => !p.missing).map((p) => [p.title, p]));
    // 保持调用方给定的顺序
    return titles.map((t) => byTitle.get(t)).filter(Boolean).map((p) => ({
      type: 'wiki', lang, title: p.title,
      // 中文维基的规范标题可能是繁体，展示时用简体变体
      display: (lang === 'zh' && p.varianttitles && p.varianttitles['zh-cn']) || p.title,
      extract: (p.extract || '').trim(),
      thumb: p.thumbnail && p.thumbnail.source,
      url: p.fullurl || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(p.title)}`,
      en: p.langlinks && p.langlinks[0] && p.langlinks[0].title,
    }));
  }

  async function arxiv(query, max) {
    // 先按标题匹配，没有再退到摘要匹配；全字段检索会混进只在摘要里打比方的论文
    let entries = [];
    for (const field of ['ti', 'abs']) {
      const qs = new URLSearchParams({ search_query: `${field}:"${query}"`, max_results: String(max), sortBy: 'relevance' });
      const res = await window.lotus.get(`https://export.arxiv.org/api/query?${qs}`, 'application/atom+xml');
      if (res.stale) staleHits++;
      if (res.status !== 200) throw new Error(`arXiv ${res.status}`);
      entries = [...new DOMParser().parseFromString(res.body, 'application/xml').getElementsByTagName('entry')];
      if (entries.length) break;
    }
    return entries.map((e) => {
      const text = (tag) => (e.getElementsByTagName(tag)[0] || {}).textContent || '';
      return {
        type: 'arxiv', query,
        title: text('title').replace(/\s+/g, ' ').trim(),
        extract: text('summary').replace(/\s+/g, ' ').trim(),
        url: text('id').trim().replace(/^http:/, 'https:'),
        authors: [...e.getElementsByTagName('author')].map((a) => a.textContent.trim()).slice(0, 4),
        published: text('published').slice(0, 10),
      };
    });
  }

  // ---------------- 概念识别（本地） ----------------
  const STOP = new Set((
    '我们 你们 他们 她们 它们 自己 什么 怎么 这个 那个 这些 那些 这样 那样 这里 那里 时候 已经 没有 不是 就是 还是 但是 因为 所以 如果 虽然 ' +
    '可以 可能 应该 知道 觉得 看到 看着 起来 出来 下来 过来 一个 一种 一样 一直 一切 只是 只有 然后 于是 而且 或者 然而 似乎 仿佛 突然 ' +
    '终于 依然 仍然 甚至 不过 不会 不能 不再 开始 继续 现在 以前 之后 之前 最后 所有 每个 任何 非常 十分 完全 真的 东西 事情 地方 问题 ' +
    '眼睛 声音 说道 告诉 回答 问道 微笑 点头 摇头 离开 走向 站在 坐在 看见 听见 感觉 想到 想起 发现 记得 成为 变成 那么 这么 多少 一下 一点'
  ).split(' '));
  const EDGE = /^[的了着过是在和与及或也都就还又很把被让给向从对为而之其这那我你他她它]|[的了着过是在和与及或也都就还又很把被让给向从对为而之其吗呢吧啊]$/;
  const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });

  // 单字的虚词/代词：含有它们的词组基本不会是条目名
  const PARTICLE = new Set('的了着过是在和与及或也都就还又很把被让给向从对为而之其这那我你他她它们说道就要会能想去来到上下里中'.split(''));
  const NUM = /^[0-9０-９一二三四五六七八九十百千万零〇两]+$/;
  const MAX_SINGLE = 900;
  const MAX_TERMS = 40;
  const MAX_MULTI = 400;

  function localCandidates(text) {
    const cands = new Map(); // 标题 -> {title, phrase, score, en, sure}
    const add = (title, phrase, score, en, sure) => {
      const prev = cands.get(title);
      if (!prev || prev.score < score) cands.set(title, { title, phrase, score, en, sure });
    };

    // 规则和术语表命中的，不用再看描述
    for (const rule of window.PHRASE_RULES) {
      const m = text.match(rule.re);
      if (m) rule.titles.forEach((t, i) => add(t, m[0], 1000 - i, undefined, true));
    }
    for (const [zh, en, ...aliases] of window.GLOSSARY) {
      const hit = text.includes(zh) ? zh : aliases.find((a) => text.includes(a));
      if (hit) add(zh, hit, 900 + hit.length, en, true);
    }

    // 分词：每个词本身是候选；相邻的 2~4 个词拼起来也是候选，
    // 用来接住被切碎的专名，比如“旅行 / 者 / 2 / 号”→“旅行者2号”
    const toks = [...segmenter.segment(text)];
    const single = new Map();
    const multi = new Map();
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (!t.isWordLike) continue;
      const w = t.segment;
      if (w.length >= 2 && !STOP.has(w) && !EDGE.test(w) && !NUM.test(w)) single.set(w, (single.get(w) || 0) + 1);
      let s = w;
      let short = w.length === 1 || NUM.test(w);
      if (PARTICLE.has(w)) continue;
      for (let j = i + 1; j < Math.min(i + 4, toks.length); j++) {
        const nt = toks[j];
        if (!nt.isWordLike || PARTICLE.has(nt.segment)) break;
        s += nt.segment;
        if (s.length > 10) break;
        if (nt.segment.length === 1 || NUM.test(nt.segment)) short = true;
        if (NUM.test(s) || STOP.has(s)) continue;
        // 含单字或数字的拼接更像被切开的专名，优先核对
        const m = multi.get(s) || { f: 0, short };
        m.f++;
        multi.set(s, m);
      }
    }
    const rankSingle = [...single].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, MAX_SINGLE);
    const rankMulti = [...multi].sort((a, b) => (b[1].short - a[1].short) || b[1].f - a[1].f || b[0].length - a[0].length).slice(0, MAX_MULTI);
    for (const [w, f] of rankSingle) add(w, w, w.length * 10 + Math.min(f, 5) * 3, undefined, false);
    for (const [w, m] of rankMulti) add(w, w, w.length * 10 + Math.min(m.f, 5) * 3, undefined, false);
    return [...cands.values()];
  }

  // 条目的简短描述（来自维基数据）里有这些字眼，才算“可以查证的概念”。简繁都要列。
  const SCIENCE = new RegExp([
    '行星', '恒星', '卫星', '衛星', '天体', '天體', '星系', '星云', '星雲', '星团', '星團', '彗星', '小行星', '黑洞', '宇宙', '天文', '太空', '航天', '航太',
    '探测器', '探測器', '飞船', '飛船', '飞行器', '飛行器', '火箭', '空间站', '太空站', '望远镜', '望遠鏡', '轨道', '軌道',
    '物理', '化学', '化學', '元素', '粒子', '原子', '分子', '量子', '相对论', '相對論', '热力学', '熱力學', '能量', '辐射', '輻射', '引力', '重力', '电磁', '電磁', '核',
    '理论', '理論', '假说', '假說', '定律', '效应', '效應', '方程', '定理', '悖论', '悖論', '数学', '數學', '计算', '計算', '算法', '演算法',
    '生物', '细胞', '細胞', '基因', '病毒', '细菌', '細菌', '物种', '物種', '演化', '进化', '進化', '蛋白', '器官', '疾病', '医学', '醫學', '神经', '神經', '生态', '生態',
    '技术', '技術', '工程', '机器', '機器', '人工智能', '人工智慧', '计算机', '電腦', '计算机', '武器', '引擎', '推进', '推進', '反应堆', '反應爐', '材料', '装置', '裝置',
    '地质', '地質', '矿物', '礦物', '化合物', '气体', '氣體', '液体', '液體', '等离子', '等離子', '温度', '溫度', '气候', '氣候', '大气', '大氣', '海洋', '地球',
    '假想', '科学', '科學', '实验', '實驗', '仪器', '儀器', '单位', '單位', '现象', '現象', '结构', '結構', '哲学', '哲學', '思想实验', '思想實驗',
  ].join('|'));

  // 规则/术语表命中的直接保留；其他的看描述，没有描述的只留四个字以上的
  function isConcept(c, title) {
    if (c.sure) return true;
    // 两个字的词被重定向到别的条目，多半是换了意思（“启动”→启动程式、“导师”→教师）
    if (c.title.length <= 2 && redirectedInputs.has(c.title)) return false;
    const desc = descOf.get(title) || '';
    if (desc) return SCIENCE.test(desc) && !/人物|演员|演員|歌手|电影|電影|电视剧|電視劇|小说|小說|专辑|專輯|姓氏|地名|城市|公司|乐队|樂團/.test(desc);
    return title.length >= 4;
  }

  // ---------------- 主流程 ----------------
  const state = {
    settings: {},
    seq: 0,
    cache: new Map(),
    lastText: '',
    current: null,          // { terms, groups }
    disabledTerms: new Set(),
    pins: [],
    onPinsChange: () => {},
    readerItem: null,
  };

  function engineFor() {
    const { engine = 'auto', anthropicApiKey } = state.settings;
    if (engine === 'claude') return 'claude';
    if (engine === 'dify') return 'dify';
    if (engine === 'local') return 'local';
    return anthropicApiKey ? 'claude' : 'local';
  }

  // Dify 工作流每次都要跑一遍大模型：同一章 30 秒内只跑一次，期间沿用上次的概念
  const DIFY_EXTRACT_INTERVAL = 30 * 1000;
  let difyExtractLast = { key: '', at: 0, concepts: null };

  async function difyExtract(text) {
    const key = text.slice(0, 80);
    if (difyExtractLast.concepts && key === difyExtractLast.key && Date.now() - difyExtractLast.at < DIFY_EXTRACT_INTERVAL) {
      return { ok: true, concepts: difyExtractLast.concepts };
    }
    try {
      const concepts = await window.lotus.difyExtract(text);
      difyExtractLast = { key, at: Date.now(), concepts };
      return { ok: true, concepts };
    } catch (e) {
      return { ok: false, error: e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') };
    }
  }

  async function findConcepts(text) {
    const engine = engineFor();
    let notice = null;
    if (engine === 'claude' || engine === 'dify') {
      const res = engine === 'dify' ? await difyExtract(text) : await window.lotus.extract(text);
      if (res.ok) {
        const zhTitles = res.concepts.map((c) => c.zh);
        const resolved = await resolveTitles('zh', zhTitles);
        // 中文条目不存在时，用英文条目的跨语言链接再找一次
        const missing = res.concepts.filter((c) => !resolved.has(c.zh));
        if (missing.length) {
          const data = await wiki('en', { action: 'query', titles: missing.map((c) => c.en).join('|'), redirects: '1', prop: 'langlinks', lllang: 'zh', lllimit: 'max' });
          const zhOf = new Map(((data.query && data.query.pages) || []).map((p) => [p.title, p.langlinks && p.langlinks[0] && p.langlinks[0].title]));
          const redirects = new Map(((data.query && data.query.redirects) || []).map((r) => [r.from, r.to]));
          const fallback = await resolveTitles('zh', missing.map((c) => zhOf.get(redirects.get(c.en) || c.en)).filter(Boolean));
          missing.forEach((c) => {
            const z = zhOf.get(redirects.get(c.en) || c.en);
            if (z && fallback.has(z)) resolved.set(c.zh, fallback.get(z));
          });
        }
        return {
          engine: engine === 'dify' ? 'Dify' : 'Claude',
          terms: res.concepts.map((c) => ({ phrase: c.phrase, title: resolved.get(c.zh) || null, en: c.en, why: c.why })),
        };
      }
      if (state.settings.engine === 'claude') throw new Error('Claude：' + res.error);
      // Dify 工作流失败（模型额度、服务故障）不该让侧边栏空掉：退回本地识别，并提示原因
      if (engine === 'dify') notice = `Dify 工作流识别失败，已改用本地识别：${res.error}`;
      // auto 模式下 Claude 失败就退回本地
    }
    const cands = localCandidates(text);
    const resolved = await resolveTitles('zh', cands.map((c) => c.title));
    const byTitle = new Map();
    for (const c of cands.sort((a, b) => b.score - a.score)) {
      const t = resolved.get(c.title);
      if (!t || byTitle.has(t) || !isConcept(c, t)) continue;
      byTitle.set(t, { phrase: c.phrase, title: t, en: c.en, score: c.score });
    }
    // 同一处原文被长短两种拼法同时命中时（“旅行者2号”和“旅行”），保留长的
    const terms = [...byTitle.values()].filter((t, _, all) =>
      !all.some((o) => o !== t && o.phrase.length > t.phrase.length && o.phrase.includes(t.phrase) && !text.split(o.phrase).join('').includes(t.phrase)));
    // 最多 40 个；按在章节里第一次出现的位置排，读起来和稿子的顺序一致
    const picked = terms.sort((a, b) => b.score - a.score).slice(0, MAX_TERMS)
      .sort((a, b) => text.indexOf(a.phrase) - text.indexOf(b.phrase));
    return { engine: '本地', terms: picked, notice };
  }

  async function gather(text) {
    const src = { zh: true, en: true, arxiv: true, ...(state.settings.sources || {}) };
    const found = await findConcepts(text);
    const terms = found.terms.filter((t) => t.title);
    const active = terms.filter((t) => !state.disabledTerms.has(t.title));
    const groups = [];
    const errors = found.notice ? [found.notice] : [];

    let zhCards = [];
    if (active.length) {
      zhCards = await summaries('zh', active.map((t) => t.title));
      zhCards.forEach((c) => {
        const t = active.find((x) => x.title === c.title);
        c.trigger = t && t.phrase;
        c.why = t && t.why;
        if (t) t.display = c.display;
      });
      if (src.zh) groups.push({ label: '维基百科 · 中文', items: zhCards });
    }

    const tasks = [];

    if (src.dify && state.settings.difyApiKey && state.settings.difyDatasetId) {
      tasks.push(difyCards(text, active).then((items) => {
        if (items.length) groups.push({ label: 'Dify 知识库', items, order: 1 });
      }).catch((e) => errors.push(e.message)));
    }

    const enTitles = [...new Set(active.map((t, i) => (zhCards.find((c) => c.title === t.title) || {}).en || t.en).filter(Boolean))];
    if (src.en && enTitles.length) {
      tasks.push(summaries('en', enTitles.slice(0, 8)).then((items) => {
        if (items.length) groups.push({ label: 'Wikipedia · English', items, order: 2 });
      }).catch((e) => errors.push(e.message)));
    }
    if (src.arxiv && enTitles.length) {
      // arXiv 要求请求之间留间隔，所以逐个查询
      tasks.push((async () => {
        const items = [];
        for (const q of enTitles.slice(0, 3)) items.push(...(await arxiv(q, 2)));
        return items;
      })().then((items) => {
        if (items.length) groups.push({ label: 'arXiv 论文', items, order: 3 });
      }).catch((e) => errors.push(e.message)));
    }
    await Promise.all(tasks);
    groups.sort((a, b) => (a.order || 0) - (b.order || 0));
    return { engine: found.engine, terms, groups, errors };
  }

  // Dify 知识库：一次用本章概念名拼成的查询，再加最多 3 段原文，合并去重后按相关度取前 12 条。
  // 设定集里的虚构名词维基百科查不到，所以段落本身也要拿去检索。
  // Dify 免费版有请求频率上限，所以 60 秒内只查一次，期间沿用上次的结果。
  const DIFY_INTERVAL = 60 * 1000;
  let difyLast = { at: 0, key: '', cards: [] };

  async function difyCards(text, active) {
    // 用章节开头认出“还是同一章”：写作中开头很少变，换章时会变
    const key = text.slice(0, 80);
    if (key === difyLast.key && Date.now() - difyLast.at < DIFY_INTERVAL) return difyLast.cards;
    difyLast = { at: Date.now(), key, cards: [] };
    const queries = [];
    const names = active.map((t) => t.display || t.title);
    if (names.length) queries.push({ q: names.join(' ').slice(0, 240), trigger: null });
    const paras = text.split(/\n+/).map((p) => p.trim()).filter((p) => p.length >= 12);
    const step = Math.max(1, Math.ceil(paras.length / 3)); // 段落多时均匀抽 3 段
    for (let i = 0; i < paras.length; i += step) queries.push({ q: paras[i].slice(0, 240), trigger: null });

    const best = new Map(); // segment id -> card
    let failure = null;
    for (const { q, trigger } of queries) {
      let records;
      try {
        records = await window.lotus.difyRetrieve(q);
      } catch (e) {
        failure = e;
        // 配置错误、额度用完、被限频：后面的查询也不会成功
        if (/Key|知识库|地址|拒绝|额度|频繁/.test(e.message)) break;
        continue;
      }
      for (const r of records) {
        const prev = best.get(r.id);
        if (prev && (prev.score ?? 0) >= (r.score ?? 0)) continue;
        best.set(r.id, {
          type: 'dify', title: r.docName, display: r.docName,
          extract: r.answer ? `${r.content}\n${r.answer}` : r.content,
          url: `dify:${r.id}`, score: r.score, trigger: trigger || (prev && prev.trigger),
        });
      }
    }
    if (!best.size && failure) {
      difyLast.at = 0; // 失败了下次照常重试，不沿用空结果
      throw new Error(failure.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }
    difyLast.cards = [...best.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 12);
    return difyLast.cards;
  }

  // 主进程已经按 Retry-After 退避过；仍被限流时，侧边栏再隔一段时间整体重查
  const RETRY_DELAYS = [20, 45, 90];
  let retry = { timer: null, tick: null, attempt: 0 };

  function cancelRetry() {
    clearTimeout(retry.timer);
    clearInterval(retry.tick);
    retry.timer = retry.tick = null;
  }

  function scheduleRetry(text, reason) {
    const secs = RETRY_DELAYS[retry.attempt++];
    let left = secs;
    setStatus(`${reason}，${left} 秒后重试`);
    retry.tick = setInterval(() => setStatus(`${reason}，${--left} 秒后重试`), 1000);
    retry.timer = setTimeout(() => {
      cancelRetry();
      run(text, { force: true, isRetry: true });
    }, secs * 1000);
  }

  async function run(text, { force = false, isRetry = false } = {}) {
    text = (text || '').trim();
    if (!text) return;
    if (!force && text === state.lastText) return;
    cancelRetry();
    if (!isRetry) retry.attempt = 0;
    state.lastText = text;
    const key = engineFor() + '|' + [...state.disabledTerms].join(',') + '|' + text;
    const seq = ++state.seq;

    if (!force && state.cache.has(key)) {
      state.current = state.cache.get(key);
      render(text);
      return;
    }
    setStatus('查询中', true);
    staleHits = 0;
    try {
      const result = await gather(text);
      result.offline = staleHits > 0;
      if (seq !== state.seq) return; // 已有更新的查询
      state.cache.set(key, result);
      if (state.cache.size > 60) state.cache.delete(state.cache.keys().next().value);
      state.current = result;
      retry.attempt = 0;
      render(text);
    } catch (e) {
      if (seq !== state.seq) return;
      const limited = /\b(429|503)\b|无响应/.test(e.message);
      if (limited && retry.attempt < RETRY_DELAYS.length) {
        // 保留上一次的结果，等一会儿自动重查
        scheduleRetry(text, /429/.test(e.message) ? '维基百科限流' : '网络不稳');
        return;
      }
      setStatus('查询失败');
      const err = h('div', { class: 'error' }, `查询失败：${e.message}。点 ↻ 可以重试。`);
      if (state.current) $('results').prepend(err);
      else $('results').replaceChildren(err);
    }
  }

  // ---------------- 渲染 ----------------
  function setStatus(text, busy) {
    const el = $('researchStatus');
    el.textContent = text;
    el.classList.toggle('busy', !!busy);
  }

  function render(text) {
    const r = state.current;
    const count = `${r.groups.reduce((n, g) => n + g.items.length, 0)} 条资料`;
    setStatus(r.errors.length ? '部分来源失败' : r.offline ? `离线 · ${count}（缓存）` : count);
    $('engineTag').textContent = r.engine;
    $('contextPreview').textContent = r.terms.length
      ? `从本章 ${text.length.toLocaleString()} 字里找到 ${r.terms.length} 个可以查证的概念`
      : `本章 ${text.length.toLocaleString()} 字里还没有找到可以查证的概念`;
    $('termChips').replaceChildren(...r.terms.map((t) => h('button', {
      class: 'chip' + (state.disabledTerms.has(t.title) ? '' : ' on'),
      title: t.why || (t.phrase !== t.title ? `原文：${t.phrase}` : '点击切换'),
      onclick: () => {
        state.disabledTerms.has(t.title) ? state.disabledTerms.delete(t.title) : state.disabledTerms.add(t.title);
        run(state.lastText, { force: true });
      },
    }, t.display || t.title)));

    const box = $('results');
    if (!r.groups.length) {
      box.replaceChildren(h('div', { class: 'empty' }, '这一章还没有找到可以查证的概念。', h('br'), '试试写到黑洞、曲速、宇宙的寿命……'));
      return;
    }
    box.replaceChildren(
      ...r.groups.flatMap((g) => [h('div', { class: 'group-label' }, g.label), ...g.items.map(card)]),
      ...r.errors.map((e) => h('div', { class: 'error' }, e)),
    );
  }

  const pinKey = (item) => `${item.type}:${item.lang || ''}:${item.url}`;
  const isPinned = (item) => state.pins.some((p) => pinKey(p) === pinKey(item));

  function togglePin(item) {
    if (isPinned(item)) state.pins = state.pins.filter((p) => pinKey(p) !== pinKey(item));
    else {
      const { type, lang, title, display, extract, url, thumb, authors, published, score } = item;
      state.pins = [{ type, lang, title, display, extract, url, thumb, authors, published, score, savedAt: Date.now() }, ...state.pins];
    }
    state.onPinsChange(state.pins);
    renderPins();
  }

  function sourceLabel(item) {
    if (item.type === 'arxiv') return `arXiv · ${item.published}`;
    // 关键词检索（经济索引）没有相关度分数，Dify 返回 0
    if (item.type === 'dify') return item.score ? `知识库 · 相关度 ${item.score.toFixed(2)}` : '知识库 · 关键词命中';
    return item.lang === 'zh' ? '维基百科' : 'Wikipedia EN';
  }

  function card(item) {
    const pinBtn = h('button', {
      class: isPinned(item) ? 'on' : '', title: '收藏到资料夹',
      onclick: (e) => { e.stopPropagation(); togglePin(item); pinBtn.classList.toggle('on', isPinned(item)); },
    }, '📌');
    return h('div', { class: 'card', onclick: () => openReader(item) },
      item.thumb ? h('img', { class: 'thumb', src: item.thumb, alt: '' }) : null,
      h('div', { class: 'body' },
        h('div', { class: 'src' }, sourceLabel(item), item.trigger && item.trigger !== item.title ? h('span', { class: 'trigger' }, `← “${item.trigger}”`) : null),
        h('h4', {}, item.display || item.title),
        h('p', {}, item.type === 'arxiv' ? `${item.authors.join(', ')} — ${item.extract}` : item.extract || '（无摘要）'),
        item.why ? h('div', { class: 'why' }, item.why) : null,
      ),
      h('div', { class: 'actions' },
        pinBtn,
        item.type === 'dify' ? null
          : h('button', { title: '在浏览器中打开', onclick: (e) => { e.stopPropagation(); window.lotus.open(item.url); } }, '↗'),
      ),
    );
  }

  function renderPins() {
    $('pinCount').textContent = state.pins.length;
    const box = $('pinned');
    if (!state.pins.length) {
      box.replaceChildren(h('div', { class: 'empty' }, '还没有收藏。', h('br'), '在“发现”里点 📌，把资料留给这本书。'));
      return;
    }
    box.replaceChildren(...state.pins.map(card));
  }

  // ---------------- 阅读器 ----------------
  async function openReader(item) {
    state.readerItem = item;
    $('reader').classList.remove('hidden');
    $('readerSource').textContent = sourceLabel(item);
    $('readerTitle').textContent = item.display || item.title;
    $('readerPin').textContent = isPinned(item) ? '📌 已收藏' : '📌 收藏';
    const body = $('readerBody');
    body.scrollTop = 0;

    $('readerExternal').classList.toggle('hidden', item.type === 'dify');
    if (item.type === 'dify') {
      body.replaceChildren(
        h('p', { class: 'arxiv-meta' }, `来自 Dify 知识库 · ${item.title}`),
        ...item.extract.split(/\n+/).filter(Boolean).map((line) => h('p', {}, line)),
      );
      return;
    }
    if (item.type === 'arxiv') {
      body.replaceChildren(
        h('p', { class: 'arxiv-meta' }, `${item.authors.join(', ')} · ${item.published}`),
        h('p', {}, item.extract),
        h('p', {}, h('a', { onclick: () => window.lotus.open(item.url.replace('/abs/', '/pdf/')) }, '打开 PDF ↗')),
      );
      return;
    }
    body.replaceChildren(h('div', { class: 'empty' }, '加载中…'));
    try {
      const data = await wiki(item.lang, {
        action: 'parse', page: item.title, prop: 'text', redirects: '1',
        disableeditsection: '1', disabletoc: '1',
      });
      if (state.readerItem !== item) return;
      if (data.error) throw new Error(data.error.info);
      body.replaceChildren(window.sanitizeWiki(data.parse.text, {
        lang: item.lang,
        onWikiLink: (title) => openReader({
          type: 'wiki', lang: item.lang, title,
          url: `https://${item.lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`,
          extract: '',
        }),
      }));
    } catch (e) {
      body.replaceChildren(h('div', { class: 'error' }, '加载失败：' + e.message));
    }
  }

  function initReader() {
    $('readerBack').addEventListener('click', () => { $('reader').classList.add('hidden'); state.readerItem = null; });
    $('readerExternal').addEventListener('click', () => state.readerItem && window.lotus.open(state.readerItem.url));
    $('readerPin').addEventListener('click', async () => {
      const item = state.readerItem;
      if (!item) return;
      // 从正文链接跳进来的条目没有摘要，收藏前补一份
      if (item.type === 'wiki' && !item.extract && !isPinned(item)) {
        const [s] = await summaries(item.lang, [item.title]).catch(() => []);
        if (s) Object.assign(item, { extract: s.extract, thumb: s.thumb, url: s.url, title: s.title, display: s.display });
      }
      togglePin(item);
      $('readerPin').textContent = isPinned(item) ? '📌 已收藏' : '📌 收藏';
    });
  }

  window.Research = {
    init({ pins, onPinsChange }) {
      state.pins = pins || [];
      state.onPinsChange = onPinsChange;
      initReader();
      renderPins();
    },
    setSettings(s) {
      state.settings = s;
      $('engineTag').textContent = { claude: 'Claude', dify: 'Dify' }[engineFor()] || '本地';
    },
    setPins(pins) { state.pins = pins || []; renderPins(); },
    run,
    refresh: () => run(state.lastText, { force: true }),
    // 供测试使用
    _localCandidates: localCandidates,
  };
})();
