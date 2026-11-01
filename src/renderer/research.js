// 资料侧边栏：从当前段落找出概念 → 查维基百科 / arXiv → 渲染卡片与阅读器。
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
  async function resolveTitles(lang, inputs) {
    const result = new Map();
    for (let i = 0; i < inputs.length; i += 50) {
      const chunk = inputs.slice(i, i + 50);
      const data = await wiki(lang, {
        action: 'query', titles: chunk.join('|'), redirects: '1', converttitles: '1',
        prop: 'pageprops', ppprop: 'disambiguation',
      });
      const q = data.query || {};
      const hop = new Map();
      for (const list of [q.normalized, q.converted, q.redirects]) {
        for (const { from, to } of list || []) hop.set(from, to);
      }
      const ok = new Set(
        (q.pages || []).filter((p) => !p.missing && !p.invalid && !(p.pageprops && 'disambiguation' in p.pageprops)).map((p) => p.title),
      );
      for (const input of chunk) {
        let t = input;
        for (let n = 0; n < 4 && hop.has(t); n++) t = hop.get(t);
        if (ok.has(t)) result.set(input, t);
      }
    }
    return result;
  }

  async function summaries(lang, titles) {
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

  async function searchWiki(lang, query, limit) {
    const data = await wiki(lang, { action: 'query', list: 'search', srsearch: query, srlimit: String(limit), srnamespace: '0' });
    return ((data.query && data.query.search) || []).map((s) => s.title);
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

  function localCandidates(text) {
    const cands = new Map(); // title -> {title, phrase, score, en}
    const add = (title, phrase, score, en) => {
      const prev = cands.get(title);
      if (!prev || prev.score < score) cands.set(title, { title, phrase, score, en });
    };

    for (const rule of window.PHRASE_RULES) {
      const m = text.match(rule.re);
      if (m) rule.titles.forEach((t, i) => add(t, m[0], 200 - i));
    }
    for (const [zh, en, ...aliases] of window.GLOSSARY) {
      const hit = aliases.find((a) => text.includes(a));
      if (hit) add(zh, hit, 100 + hit.length, en);
    }

    // 分词后拼接相邻 1~3 个词，交给维基标题匹配去筛
    const toks = [...segmenter.segment(text)];
    const freq = new Map();
    for (let i = 0; i < toks.length; i++) {
      if (!toks[i].isWordLike) continue;
      let s = '';
      for (let j = i; j < Math.min(i + 3, toks.length) && toks[j].isWordLike; j++) {
        s += toks[j].segment;
        if (s.length < 2 || s.length > 12 || STOP.has(s) || EDGE.test(s) || /^\d+$/.test(s)) continue;
        freq.set(s, (freq.get(s) || 0) + 1);
      }
    }
    for (const [s, f] of freq) {
      // 英文词组按词数算长度，避免 "the" 之类压过中文概念
      const len = /[一-鿿]/.test(s) ? s.length : s.split(/\s+/).length * 2;
      add(s, s, len * 10 + f * 3);
    }
    return [...cands.values()].sort((a, b) => b.score - a.score).slice(0, 50);
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
    if (engine === 'local') return 'local';
    return anthropicApiKey ? 'claude' : 'local';
  }

  async function findConcepts(text) {
    const engine = engineFor();
    if (engine === 'claude') {
      const res = await window.lotus.extract(text);
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
          engine: 'Claude',
          terms: res.concepts.map((c) => ({ phrase: c.phrase, title: resolved.get(c.zh) || null, en: c.en, why: c.why })),
        };
      }
      if (state.settings.engine === 'claude') throw new Error('Claude：' + res.error);
      // auto 模式下 Claude 失败就退回本地
    }
    const cands = localCandidates(text);
    const resolved = await resolveTitles('zh', cands.map((c) => c.title));
    const seen = new Set();
    const terms = [];
    for (const c of cands) {
      const t = resolved.get(c.title);
      if (!t || seen.has(t)) continue;
      seen.add(t);
      terms.push({ phrase: c.phrase, title: t, en: c.en, score: c.score });
    }
    // 两个字的泛词（“时间”“导师”）噪音大，只在强候选不足时补两个
    const strong = terms.filter((t) => t.score >= 30);
    const weak = strong.length >= 3 ? [] : terms.filter((t) => t.score < 30).slice(0, 2);
    return { engine: '本地', terms: strong.concat(weak).slice(0, 8) };
  }

  async function gather(text) {
    const src = { zh: true, en: true, arxiv: true, ...(state.settings.sources || {}) };
    const found = await findConcepts(text);
    const terms = found.terms.filter((t) => t.title);
    const active = terms.filter((t) => !state.disabledTerms.has(t.title));
    const groups = [];
    const errors = [];

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

    // 延伸阅读：用前几个概念做全文检索，补上没被直接命中的相关条目
    const tasks = [];
    if (src.zh && active.length) {
      tasks.push((async () => {
        const q = active.slice(0, 3).map((t) => t.title).join(' ');
        const titles = (await searchWiki('zh', q, 8)).filter((t) => !zhCards.some((c) => c.title === t)).slice(0, 4);
        const items = await summaries('zh', titles);
        if (items.length) groups.push({ label: '延伸阅读', items, order: 1 });
      })().catch((e) => errors.push(e.message)));
    }

    const enTitles = [...new Set(active.map((t, i) => (zhCards.find((c) => c.title === t.title) || {}).en || t.en).filter(Boolean))];
    if (src.en && enTitles.length) {
      tasks.push(summaries('en', enTitles.slice(0, 4)).then((items) => {
        if (items.length) groups.push({ label: 'Wikipedia · English', items, order: 2 });
      }).catch((e) => errors.push(e.message)));
    }
    if (src.arxiv && enTitles.length) {
      // arXiv 要求请求之间留间隔，所以逐个查询
      tasks.push((async () => {
        const items = [];
        for (const q of enTitles.slice(0, 2)) items.push(...(await arxiv(q, 2)));
        return items;
      })().then((items) => {
        if (items.length) groups.push({ label: 'arXiv 论文', items, order: 3 });
      }).catch((e) => errors.push(e.message)));
    }
    await Promise.all(tasks);
    groups.sort((a, b) => (a.order || 0) - (b.order || 0));
    return { engine: found.engine, terms, groups, errors };
  }

  async function run(text, { force = false } = {}) {
    text = (text || '').trim();
    if (!text) return;
    if (!force && text === state.lastText) return;
    state.lastText = text;
    const key = engineFor() + '|' + [...state.disabledTerms].join(',') + '|' + text;
    const seq = ++state.seq;

    if (!force && state.cache.has(key)) {
      state.current = state.cache.get(key);
      render(text);
      return;
    }
    setStatus('查询中', true);
    $('contextPreview').textContent = text;
    staleHits = 0;
    try {
      const result = await gather(text);
      result.offline = staleHits > 0;
      if (seq !== state.seq) return; // 已有更新的段落
      state.cache.set(key, result);
      if (state.cache.size > 60) state.cache.delete(state.cache.keys().next().value);
      state.current = result;
      render(text);
    } catch (e) {
      if (seq !== state.seq) return;
      setStatus('');
      $('results').replaceChildren(h('div', { class: 'error' }, '查询失败：' + e.message));
    }
  }

  // ---------------- 渲染 ----------------
  function setStatus(text, busy) {
    const el = $('researchStatus');
    el.textContent = text;
    el.classList.toggle('busy', !!busy);
  }

  function highlight(text, phrases) {
    const frag = document.createDocumentFragment();
    const ps = [...new Set(phrases.filter((p) => p && text.includes(p)))].sort((a, b) => b.length - a.length);
    if (!ps.length) { frag.append(text); return frag; }
    const re = new RegExp(ps.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
    let last = 0;
    for (const m of text.matchAll(re)) {
      frag.append(text.slice(last, m.index), h('mark', {}, m[0]));
      last = m.index + m[0].length;
    }
    frag.append(text.slice(last));
    return frag;
  }

  function render(text) {
    const r = state.current;
    const count = `${r.groups.reduce((n, g) => n + g.items.length, 0)} 条资料`;
    setStatus(r.errors.length ? '部分来源失败' : r.offline ? `离线 · ${count}（缓存）` : count);
    $('engineTag').textContent = r.engine;
    $('contextPreview').replaceChildren(highlight(text, r.terms.map((t) => t.phrase)));
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
      box.replaceChildren(h('div', { class: 'empty' }, '这一段没有找到可以查证的概念。', h('br'), '试试写到黑洞、曲速、宇宙的寿命……'));
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
      const { type, lang, title, display, extract, url, thumb, authors, published } = item;
      state.pins = [{ type, lang, title, display, extract, url, thumb, authors, published, savedAt: Date.now() }, ...state.pins];
    }
    state.onPinsChange(state.pins);
    renderPins();
  }

  function sourceLabel(item) {
    if (item.type === 'arxiv') return `arXiv · ${item.published}`;
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
        h('button', { title: '在浏览器中打开', onclick: (e) => { e.stopPropagation(); window.lotus.open(item.url); } }, '↗'),
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
      $('engineTag').textContent = engineFor() === 'claude' ? 'Claude' : '本地';
    },
    setPins(pins) { state.pins = pins || []; renderPins(); },
    run,
    refresh: () => run(state.lastText, { force: true }),
    // 供测试使用
    _localCandidates: localCandidates,
  };
})();
