// 编辑器、章节树、世界观设定、保存与设置；正文变化时交给 Research 查询。
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
    world: [],
    activeId: 'c1',
    pins: [],
  };

  let project = null;
  let settings = {};
  let saveTimer = null;
  let researchTimer = null;
  let switching = false; // 切分支期间暂停自动保存，免得把旧稿写进新分支
  let difyTimer = null;

  const active = () => project.chapters.find((c) => c.id === project.activeId) || project.chapters[0];
  const countChars = (s) => (s.match(/[一-鿿]|[A-Za-z0-9]+/g) || []).length;

  // ---------------- 保存 ----------------
  // 每次停笔 400ms 就写一次：project.json 存应用状态，章节同时落盘成 Markdown
  function scheduleSave() {
    if (switching) return;
    $('saveState').textContent = '未保存';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 400);
  }

  async function saveNow() {
    clearTimeout(saveTimer);
    if (switching) return;
    await window.lotus.saveProject(project);
    const state = $('saveState');
    try {
      await window.lotus.files.sync(project.folder, project.chapters, project.world);
      state.textContent = '已保存';
      state.title = `已写入 ${project.folder}`;
      state.classList.remove('failed');
    } catch (e) {
      state.textContent = 'Markdown 写入失败';
      state.title = e.message;
      state.classList.add('failed');
    }
    Vcs.refresh();
    scheduleDifySync(30000);
  }

  // ---------------- 同步到 Dify 知识库 ----------------
  // 停笔 30 秒后同步一次；切换章节时把还没同步的改动立即送出。只有内容变了的项才会上传。
  function difyItems() {
    // 文档名带章节序号（和 Markdown 文件名一致）：Dify 只能按上传时间排序，序号让顺序一目了然
    const chapters = project.chapters.map((c, i) => ({
      id: c.id,
      name: `${String(i + 1).padStart(2, '0')} ${c.title || '未命名章节'}.md`,
      text: `# ${c.title || '未命名章节'}\n\n${c.text.trimEnd()}\n`,
      hasBody: !!c.text.trim(),
    }));
    // 所有世界观设定合成一个文档；设定往往一句话就写在名称里，只有名称也算。
    // 每条设定在 Dify 里单独成一个分段（按小节标题切开），各自有关键词，检索时不会互相挤占
    const entries = project.world.filter((w) => w.title.trim() || w.text.trim());
    const world = {
      id: 'world',
      name: '世界观设定.md',
      text: entries.map((w) => [
        `## 世界观设定：${w.title.trim() || '未命名设定'}`,
        w.text.trim(),
        '（本作品的虚构设定，在本作品的宇宙里成立，可能与现实不同。）',
      ].filter(Boolean).join('\n\n')).join('\n\n') + '\n',
      processRule: {
        mode: 'custom',
        rules: {
          pre_processing_rules: [{ id: 'remove_extra_spaces', enabled: true }, { id: 'remove_urls_emails', enabled: false }],
          segmentation: { separator: '\n\n## ', max_tokens: 1000, chunk_overlap: 0 },
        },
      },
      hasBody: entries.length > 0,
    };
    return chapters.concat(world);
  }

  function scheduleDifySync(delay) {
    if (!(settings.sources && settings.sources.dify) || settings.difyAutoSync !== true) return;
    clearTimeout(difyTimer);
    difyTimer = setTimeout(runDifySync, delay);
  }

  async function runDifySync() {
    clearTimeout(difyTimer);
    difyTimer = null;
    const el = $('difyState');
    el.classList.remove('hidden', 'failed');
    el.textContent = 'Dify 同步中…';
    try {
      const r = await window.lotus.difySync(difyItems());
      if (r.skipped) return el.classList.add('hidden');
      const changed = r.created + r.updated + r.deleted;
      el.textContent = 'Dify 已同步';
      el.title = changed
        ? `新增 ${r.created}、更新 ${r.updated}、删除 ${r.deleted} 个文档 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`
        : '知识库已是最新';
    } catch (e) {
      el.textContent = 'Dify 同步失败';
      el.title = e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      el.classList.add('failed');
      scheduleDifySync(120000); // 两分钟后再试
    }
  }

  // ---------------- 世界观（右侧栏标签页，直接在卡片里编辑） ----------------
  function renderWorld() {
    $('worldCount').textContent = project.world.length;
    const list = $('worldList');
    if (!project.world.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '还没有设定。点“新建设定”，写下这个宇宙和现实不一样的地方。';
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(...project.world.map((w) => {
      const card = document.createElement('div');
      card.className = 'world-card';
      const head = document.createElement('div');
      head.className = 'world-card-head';
      const title = document.createElement('input');
      title.className = 'world-title';
      title.placeholder = '设定名称，如：冰比水重';
      title.spellcheck = false;
      title.value = w.title;
      title.addEventListener('input', () => { w.title = title.value; scheduleSave(); });
      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = '×';
      del.title = '删除设定';
      del.addEventListener('click', () => {
        if (!confirm(`删除设定「${w.title || '未命名设定'}」？对应的 Markdown 文件会移到废纸篓。`)) return;
        project.world = project.world.filter((x) => x.id !== w.id);
        renderWorld();
        scheduleSave();
      });
      head.append(title, del);
      const body = document.createElement('textarea');
      body.className = 'world-text';
      body.placeholder = '在这个宇宙里，冰的密度大于水，所以海洋从底部开始结冰……';
      body.spellcheck = false;
      body.value = w.text;
      const fit = () => { body.style.height = 'auto'; body.style.height = body.scrollHeight + 'px'; };
      body.addEventListener('input', () => { w.text = body.value; fit(); scheduleSave(); });
      requestAnimationFrame(fit);
      card.append(head, body);
      return card;
    }));
  }

  // ---------------- 章节 ----------------
  function renderChapters() {
    renderList($('chapterList'), project.chapters, '未命名章节', (c) => {
      const last = project.chapters.length === 1;
      const hint = last ? '\n这是最后一章，删除后会留一个空白章节。' : '';
      if (!confirm(`删除「${c.title || '未命名章节'}」？对应的 Markdown 文件会移到废纸篓。${hint}`)) return false;
      project.chapters = project.chapters.filter((x) => x.id !== c.id);
      // 作品里至少留一章，编辑器才有地方落笔
      if (!project.chapters.length) project.chapters.push({ id: 'c' + Date.now().toString(36), title: '第一章', text: '' });
      return true;
    });
    updateStats();
  }

  function renderList(list, items, untitled, remove) {
    list.replaceChildren(...items.map((c, i) => {
      const li = document.createElement('li');
      li.className = c.id === project.activeId ? 'active' : '';
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = String(i + 1).padStart(2, '0');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = c.title || untitled;
      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = '×';
      del.title = '删除';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!remove(c)) return;
        if (!project.chapters.some((x) => x.id === project.activeId)) project.activeId = project.chapters[0].id;
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
  }

  function loadChapter() {
    const c = active();
    $('chapterTitle').value = c.title;
    editor.value = c.text;
    renderChapters();
    editor.focus();
    editor.setSelectionRange(c.text.length, c.text.length);
    researchChapter(true);
    if (difyTimer) runDifySync(); // 换到别的章节时，把上一章还没同步的改动送出去
  }

  function updateStats() {
    $('statWords').textContent = countChars(active().text).toLocaleString();
    $('statTotal').textContent = project.chapters.reduce((n, c) => n + countChars(c.text), 0).toLocaleString();
  }

  // ---------------- 资料查询：以整章为范围 ----------------
  const chapterText = () => active().text.slice(0, 30000);

  // 切换章节时立即查；写作中停笔 2.5 秒再查，避免每敲一个字就重算整章
  function researchChapter(immediate) {
    if (!settings.autoResearch) return;
    clearTimeout(researchTimer);
    researchTimer = setTimeout(() => window.Research.run(chapterText()), immediate ? 0 : 2500);
  }

  // ---------------- 设置 ----------------
  const DEFAULT_SETTINGS = { autoResearch: true, engine: 'auto', anthropicApiKey: '', sources: { zh: true, en: true, arxiv: true, dify: false }, difyBaseUrl: '', difyDatasetId: '', difyApiKey: '', difyAutoSync: false };

  function openSettings() {
    $('setAuto').checked = settings.autoResearch;
    $('setEngine').value = settings.engine;
    $('setKey').value = settings.anthropicApiKey || '';
    $('srcZh').checked = settings.sources.zh;
    $('srcEn').checked = settings.sources.en;
    $('srcArxiv').checked = settings.sources.arxiv;
    $('srcDify').checked = settings.sources.dify;
    $('difyBaseUrl').value = settings.difyBaseUrl || '';
    $('difyDatasetId').value = settings.difyDatasetId || '';
    $('difyApiKey').value = settings.difyApiKey || '';
    $('difyWorkflowKey').value = settings.difyWorkflowKey || '';
    $('difyAutoSync').checked = settings.difyAutoSync === true;
    $('difyTestResult').textContent = '';
    $('folderPath').textContent = project.folder;
    $('folderPath').title = project.folder;
    $('settingsModal').classList.remove('hidden');
    refreshCacheStats();
  }

  async function refreshCacheStats() {
    const { count, bytes } = await window.lotus.cacheStats();
    $('cacheStats').textContent = `${count} 条 · ${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  const difyForm = () => ({
    difyBaseUrl: $('difyBaseUrl').value.trim(),
    difyDatasetId: $('difyDatasetId').value.trim(),
    difyApiKey: $('difyApiKey').value.trim(),
    difyWorkflowKey: $('difyWorkflowKey').value.trim(),
  });

  async function testDify() {
    const out = $('difyTestResult');
    out.className = '';
    out.textContent = '连接中…';
    try {
      const records = await window.lotus.difyRetrieve('测试', difyForm());
      out.className = 'ok';
      out.textContent = `连接成功，测试查询命中 ${records.length} 条`;
    } catch (e) {
      out.className = 'bad';
      out.textContent = e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    }
  }

  async function saveSettings() {
    settings = {
      autoResearch: $('setAuto').checked,
      engine: $('setEngine').value,
      anthropicApiKey: $('setKey').value.trim(),
      sources: { zh: $('srcZh').checked, en: $('srcEn').checked, arxiv: $('srcArxiv').checked, dify: $('srcDify').checked },
      ...difyForm(),
      difyAutoSync: $('difyAutoSync').checked,
    };
    await window.lotus.saveSettings(settings);
    window.Research.setSettings(settings);
    $('settingsModal').classList.add('hidden');
    window.Research.run(chapterText(), { force: true });
  }

  async function changeFolder() {
    const dir = await window.lotus.files.choose();
    if (!dir || dir === project.folder) return;
    await saveNow();
    const prep = await window.lotus.files.prepare(project.title, dir);
    if (prep.chapters && !confirm(`这个文件夹里已有 ${prep.chapters.length} 个章节。\n打开它们并替换编辑器里的当前稿件？（当前稿件仍保留在原文件夹）`)) return;
    project.folder = prep.dir;
    if (prep.chapters) adoptChapters(prep.chapters, prep.world);
    $('folderPath').textContent = project.folder;
    $('folderPath').title = project.folder;
    await saveNow();
  }

  // 换了一套章节（切分支、换文件夹）：尽量停留在同一章
  function adoptChapters(chapters, world) {
    project.chapters = chapters.length ? chapters : [{ id: 'c' + Date.now().toString(36), title: '第一章', text: '' }];
    project.world = world || [];
    renderWorld();
    if (!project.chapters.some((c) => c.id === project.activeId)) project.activeId = project.chapters[0].id;
    loadChapter();
  }

  // ---------------- 分支 ----------------
  const Vcs = {
    status: null,
    async refresh() {
      if (!project || !project.folder) return;
      try {
        this.status = await window.lotus.git.status(project.folder);
      } catch {
        this.status = null;
      }
      const st = this.status;
      $('branchName').textContent = st && st.repo ? st.branch : '—';
      $('dirtyDot').classList.toggle('hidden', !(st && st.dirty));
      if (!$('branchPopover').classList.contains('hidden')) this.render();
    },
    render() {
      const st = this.status || { branches: [], log: [] };
      $('branchList').replaceChildren(...st.branches.map((b) => {
        const li = document.createElement('li');
        li.className = b === st.branch ? 'current' : '';
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = b;
        li.append(name);
        if (b === st.branch) {
          const tag = document.createElement('span');
          tag.className = 'tag';
          tag.textContent = st.dirty ? '当前 · 有未保存版本的改动' : '当前';
          li.append(tag);
        } else {
          li.title = `切换到 ${b}`;
          li.addEventListener('click', () => this.switchTo(b, false));
          const del = document.createElement('button');
          del.className = 'del';
          del.textContent = '×';
          del.title = '删除分支';
          del.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!confirm(`删除分支「${b}」？这个分支上没合并到别处的内容会丢失。`)) return;
            try {
              await window.lotus.git.remove(project.folder, b);
            } catch (err) {
              alert(err.message);
            }
            this.refresh();
          });
          li.append(del);
        }
        return li;
      }));
      $('historyList').replaceChildren(...st.log.map((c) => {
        const li = document.createElement('li');
        const subject = document.createElement('span');
        subject.className = 'subject';
        subject.textContent = c.subject;
        const when = document.createElement('span');
        when.className = 'when';
        when.textContent = c.when;
        li.append(subject, when);
        li.title = c.hash;
        return li;
      }));
    },
    async switchTo(name, create) {
      await saveNow();
      switching = true;
      try {
        const loaded = await (create ? window.lotus.git.create : window.lotus.git.switch)(project.folder, name);
        adoptChapters(loaded.chapters, loaded.world);
        await window.lotus.saveProject(project);
      } catch (e) {
        alert((create ? '新建分支失败：' : '切换分支失败：') + e.message);
      } finally {
        switching = false;
      }
      await this.refresh();
    },
    async commit() {
      await saveNow();
      const input = $('commitMessage');
      const message = input.value.trim() || `保存版本 · ${new Date().toLocaleString('zh-CN', { hour12: false })}`;
      try {
        const done = await window.lotus.git.commit(project.folder, message);
        input.value = '';
        flash($('commitBtn'), done ? '已保存 ✓' : '没有新改动');
      } catch (e) {
        alert('保存版本失败：' + e.message);
      }
      this.refresh();
    },
    toggle() {
      const pop = $('branchPopover');
      pop.classList.toggle('hidden');
      if (!pop.classList.contains('hidden')) this.refresh().then(() => this.render());
    },
  };

  function flash(el, text) {
    const old = el.textContent;
    el.textContent = text;
    setTimeout(() => { el.textContent = old; }, 1000);
  }

  function initVcs() {
    $('branchBtn').addEventListener('click', () => Vcs.toggle());
    $('commitBtn').addEventListener('click', () => Vcs.commit());
    $('commitMessage').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) Vcs.commit(); });
    const create = () => {
      const name = $('newBranch').value.trim();
      if (!name) return;
      $('newBranch').value = '';
      Vcs.switchTo(name, true);
    };
    $('createBranch').addEventListener('click', create);
    $('newBranch').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) create(); });
    document.addEventListener('mousedown', (e) => {
      if (!e.target.closest('#branchPopover, #branchBtn')) $('branchPopover').classList.add('hidden');
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('branchPopover').classList.add('hidden'); });
  }

  // ---------------- 启动 ----------------
  async function boot() {
    project = (await window.lotus.loadProject()) || structuredClone(SAMPLE);
    project.pins = project.pins || [];
    // Markdown 文件夹是章节的来源：启动时以磁盘上的为准（可能在别处改过，或切过分支）
    const prep = await window.lotus.files.prepare(project.title, project.folder);
    project.folder = prep.dir;
    project.world = project.world || [];
    if (prep.chapters) {
      project.chapters = prep.chapters;
      project.world = prep.world || [];
      if (!project.chapters.some((c) => c.id === project.activeId)) project.activeId = project.chapters[0].id;
    }
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
      researchChapter(false);
    });

    $('addWorld').addEventListener('click', () => {
      project.world.unshift({ id: 'w' + Date.now().toString(36), title: '', text: '' });
      renderWorld();
      $('worldList').querySelector('.world-title').focus();
      scheduleSave();
    });
    renderWorld();

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
      for (const name of ['discover', 'pinned', 'world']) $('pane-' + name).classList.toggle('hidden', tab.dataset.tab !== name);
    }));
    $('refreshResearch').addEventListener('click', () => window.Research.run(chapterText(), { force: true }));
    $('openSettings').addEventListener('click', openSettings);
    $('settingsCancel').addEventListener('click', () => $('settingsModal').classList.add('hidden'));
    $('settingsSave').addEventListener('click', saveSettings);
    $('changeFolder').addEventListener('click', changeFolder);
    $('difyTest').addEventListener('click', testDify);
    $('revealFolder').addEventListener('click', () => window.lotus.files.reveal(project.folder));
    window.lotus.onFlush(saveNow);
    initVcs();
    $('clearCache').addEventListener('click', async () => {
      if (!confirm('清空所有缓存的维基百科和 arXiv 内容？')) return;
      await window.lotus.clearCache();
      refreshCacheStats();
    });

    loadChapter();
    saveNow();
  }

  boot();
})();
