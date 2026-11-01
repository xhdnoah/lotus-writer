// 编辑器、章节树、保存与设置；段落变化时交给 Research 查询。
(function () {
  const $ = (id) => document.getElementById(id);
  const editor = $('editor');

  const SAMPLE = {
    title: '长夜航线',
    chapters: [
      {
        id: 'c1',
        title: '第一章 · 最后的恒星',
        text: [
          '“启明号”离开太阳系的第四百一十二年，林遥从冬眠舱里醒来。舷窗外，比邻星的暗红光芒像一块将熄未熄的炭。',
          '舰载智能告诉她，船上的核聚变反应堆还能维持三百年。三百年之后呢？她想起出发前导师说过的话：恒星终将燃尽，连黑洞也会通过霍金辐射慢慢蒸发。',
          '“那宇宙的寿命呢？”她当时问。导师沉默了很久，说，也许在热寂之前，我们还有足够的时间找到答案。',
          '',
        ].join('\n\n'),
      },
      { id: 'c2', title: '第二章 · 虫洞的另一边', text: '' },
    ],
    activeId: 'c1',
    pins: [],
  };

  let project = null;
  let settings = {};
  let saveTimer = null;
  let researchTimer = null;
  let lastParagraphKey = '';

  const active = () => project.chapters.find((c) => c.id === project.activeId) || project.chapters[0];
  const countChars = (s) => (s.match(/[一-鿿]|[A-Za-z0-9]+/g) || []).length;

  // ---------------- 保存 ----------------
  function scheduleSave() {
    $('saveState').textContent = '未保存';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      await window.lotus.saveProject(project);
      $('saveState').textContent = '已保存';
    }, 600);
  }

  // ---------------- 章节 ----------------
  function renderChapters() {
    const list = $('chapterList');
    list.replaceChildren(...project.chapters.map((c, i) => {
      const li = document.createElement('li');
      li.className = c.id === project.activeId ? 'active' : '';
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = String(i + 1).padStart(2, '0');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = c.title || '未命名章节';
      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = '×';
      del.title = '删除章节';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (project.chapters.length === 1) return;
        if (!confirm(`删除「${c.title || '未命名章节'}」？此操作无法撤销。`)) return;
        project.chapters = project.chapters.filter((x) => x.id !== c.id);
        if (project.activeId === c.id) project.activeId = project.chapters[0].id;
        loadChapter();
        scheduleSave();
      });
      li.append(num, name, del);
      li.addEventListener('click', () => {
        project.activeId = c.id;
        loadChapter();
        scheduleSave();
      });
      return li;
    }));
    updateStats();
  }

  function loadChapter() {
    const c = active();
    $('chapterTitle').value = c.title;
    editor.value = c.text;
    lastParagraphKey = '';
    renderChapters();
    editor.focus();
    editor.setSelectionRange(c.text.length, c.text.length);
    onCursor(true);
  }

  function updateStats() {
    $('statWords').textContent = countChars(active().text).toLocaleString();
    $('statTotal').textContent = project.chapters.reduce((n, c) => n + countChars(c.text), 0).toLocaleString();
  }

  // ---------------- 当前段落 ----------------
  function currentParagraph() {
    const text = editor.value;
    const pos = editor.selectionStart;
    const start = text.lastIndexOf('\n', pos - 1) + 1;
    let end = text.indexOf('\n', pos);
    if (end === -1) end = text.length;
    let para = text.slice(start, end).trim();
    // 光标在空行或很短的行上时，回看上一段
    if (para.length < 24) {
      const before = text.slice(0, start).trimEnd();
      const prevStart = before.lastIndexOf('\n') + 1;
      para = (before.slice(prevStart) + '\n' + para).trim();
    }
    return { key: start + ':' + para, text: para.slice(-600) };
  }

  function onCursor(immediate) {
    if (!settings.autoResearch) return;
    const p = currentParagraph();
    if (p.key === lastParagraphKey) return;
    lastParagraphKey = p.key;
    clearTimeout(researchTimer);
    researchTimer = setTimeout(() => window.Research.run(p.text), immediate ? 0 : 1200);
  }

  // ---------------- 设置 ----------------
  const DEFAULT_SETTINGS = { autoResearch: true, engine: 'auto', anthropicApiKey: '', sources: { zh: true, en: true, arxiv: true } };

  function openSettings() {
    $('setAuto').checked = settings.autoResearch;
    $('setEngine').value = settings.engine;
    $('setKey').value = settings.anthropicApiKey || '';
    $('srcZh').checked = settings.sources.zh;
    $('srcEn').checked = settings.sources.en;
    $('srcArxiv').checked = settings.sources.arxiv;
    $('settingsModal').classList.remove('hidden');
    refreshCacheStats();
  }

  async function refreshCacheStats() {
    const { count, bytes } = await window.lotus.cacheStats();
    $('cacheStats').textContent = `${count} 条 · ${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  async function saveSettings() {
    settings = {
      autoResearch: $('setAuto').checked,
      engine: $('setEngine').value,
      anthropicApiKey: $('setKey').value.trim(),
      sources: { zh: $('srcZh').checked, en: $('srcEn').checked, arxiv: $('srcArxiv').checked },
    };
    await window.lotus.saveSettings(settings);
    window.Research.setSettings(settings);
    $('settingsModal').classList.add('hidden');
    window.Research.run(currentParagraph().text, { force: true });
  }

  // ---------------- 启动 ----------------
  async function boot() {
    project = (await window.lotus.loadProject()) || structuredClone(SAMPLE);
    project.pins = project.pins || [];
    const saved = await window.lotus.loadSettings();
    settings = { ...DEFAULT_SETTINGS, ...saved, sources: { ...DEFAULT_SETTINGS.sources, ...(saved.sources || {}) } };

    window.Research.setSettings(settings);
    window.Research.init({
      pins: project.pins,
      onPinsChange: (pins) => { project.pins = pins; scheduleSave(); },
    });

    $('projectTitle').value = project.title;
    $('projectTitle').addEventListener('input', (e) => { project.title = e.target.value; scheduleSave(); });
    $('chapterTitle').addEventListener('input', (e) => { active().title = e.target.value; renderChapters(); scheduleSave(); });
    editor.addEventListener('input', () => {
      active().text = editor.value;
      updateStats();
      scheduleSave();
      lastParagraphKey = '';
      onCursor(false);
    });
    for (const ev of ['click', 'keyup']) editor.addEventListener(ev, () => onCursor(false));

    $('addChapter').addEventListener('click', () => {
      const id = 'c' + Date.now().toString(36);
      project.chapters.push({ id, title: `第${project.chapters.length + 1}章`, text: '' });
      project.activeId = id;
      loadChapter();
      $('chapterTitle').select();
      scheduleSave();
    });

    document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      $('pane-discover').classList.toggle('hidden', tab.dataset.tab !== 'discover');
      $('pane-pinned').classList.toggle('hidden', tab.dataset.tab !== 'pinned');
    }));
    $('refreshResearch').addEventListener('click', () => window.Research.run(currentParagraph().text, { force: true }));
    $('openSettings').addEventListener('click', openSettings);
    $('settingsCancel').addEventListener('click', () => $('settingsModal').classList.add('hidden'));
    $('settingsSave').addEventListener('click', saveSettings);
    $('clearCache').addEventListener('click', async () => {
      if (!confirm('清空所有缓存的维基百科和 arXiv 内容？')) return;
      await window.lotus.clearCache();
      refreshCacheStats();
    });

    loadChapter();
  }

  boot();
})();
