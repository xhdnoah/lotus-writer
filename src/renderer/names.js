// 角色随机取名。入口故意藏起来：点左栏的“章节”二字，或按 ⌘⇧N / Ctrl+Shift+N。
(function () {
  const $ = (id) => document.getElementById(id);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const split = (s) => s.split(' ');

  const DATA = {
    zh: {
      label: '中文',
      surname: split('林 陈 李 张 王 赵 周 吴 郑 孙 沈 韩 杨 叶 许 顾 江 程 苏 陆 秦 方 白 温 宋 夏 唐 萧 闻 季 纪 简 黎 尹 傅 钟 罗 邵 姜 谢 庄 卫 阮 楚 霍 慕容 欧阳 司马 上官 诸葛 闻人 东方 南宫'),
      m: split('远 澈 骁 衡 舟 渊 岑 珩 屿 川 默 恒 霁 晏 岳 曜 辰 凛 朔 弈 承 野 砚 峥 澜 钧 戈'),
      f: split('遥 岚 汐 绮 霓 璃 茵 筠 瑶 婧 芷 歆 漪 菁 苒 黛 鸢 玥 沅 熹 绫 姝 宁 清 澄 素'),
      n: split('星 夜 野 一 川 安 白 朝 青 雨 弦 墨 微 时 未 晞 宇 晴 原'),
    },
    west: {
      label: '西式',
      m: split('卡洛斯 伊万 马库斯 尤里 雷纳德 西奥 亚当 凯恩 埃利亚斯 维克多 塞巴斯蒂安 诺亚 奥斯卡 德米特里 卢西恩'),
      f: split('艾琳 索菲娅 薇拉 伊莉莎 诺拉 克拉拉 奥罗拉 米拉 塔莉亚 茱莉亚 赛琳娜 阿德里安娜 露西 伊芙 卡珊德拉'),
      n: split('艾瑞斯 乔丹 罗宾 卡西 诺瓦 里弗 萨格 埃隆'),
      surname: split('沃森 科瓦尔斯基 斯特恩 奥康纳 冯·布劳恩 哈珀 阿什福德 雷耶斯 伊凡诺夫 布莱克伍德 莫罗 霍尔顿 卡特 索恩 莱特'),
    },
    ja: {
      label: '日式',
      surname: split('佐藤 高桥 神崎 九条 一之濑 雨宫 冰室 白石 鸣海 天野 朝仓 久远 桐生 结城 东云 早乙女'),
      m: split('凉介 拓海 苍 湊 莲 健 真琴 朔也 凛太郎 悠真 隼人 透'),
      f: split('凛 美月 千寻 遥 雫 葵 纱织 绫乃 栞 真白 花音 澪'),
      n: split('真琴 光 薰 渚 步 翼 司'),
    },
    code: {
      label: '星际代号',
      // 代号类名字按模板生成，不分性别
      gen() {
        const greek = split('阿尔法 贝塔 伽马 德尔塔 西格玛 欧米伽 厄普西隆');
        const myth = split('阿特拉斯 赫利俄斯 织女 刑天 夸父 墨丘利 伊卡洛斯 女娲 普罗米修斯 后羿 塞勒涅 奥丁');
        const L = 'ABCDEFGHJKLMNPRSTVXYZ';
        const letters = () => L[Math.floor(Math.random() * L.length)] + (Math.random() < 0.5 ? L[Math.floor(Math.random() * L.length)] : '');
        const num = () => String(Math.floor(Math.random() * (Math.random() < 0.5 ? 10 : 1000)));
        return pick([
          () => `${letters()}-${num()}`,
          () => `${pick(myth)}-${num()}`,
          () => `${pick(greek)}·${num()}`,
          () => `${pick(myth)}`,
          () => `${letters()}${num()}「${pick(myth)}」`,
        ])();
      },
    },
  };

  function oneName(style, gender) {
    const d = DATA[style];
    if (d.gen) return d.gen();
    const g = gender === 'any' ? pick(['m', 'f', 'n']) : gender;
    const pool = g === 'n' ? d.n : d[g].concat(d.n.slice(0, 4));
    if (style === 'zh') {
      // 单字名与双字名大约各半；复姓配单字名
      const sur = pick(d.surname);
      const given = sur.length === 1 && Math.random() < 0.55 ? pick(pool) + pick(pool.concat(d.n)) : pick(pool);
      return sur + given;
    }
    if (style === 'west') return `${pick(pool)}·${pick(d.surname)}`;
    return pick(d.surname) + pick(pool);
  }

  function batch(style, gender, n = 8) {
    const out = new Set();
    for (let i = 0; out.size < n && i < n * 10; i++) {
      const name = oneName(style, gender);
      if (!/(.)\1$/.test(name)) out.add(name); // 避开“林林”这种叠字结尾
    }
    return [...out];
  }

  const state = { style: 'zh', gender: 'any' };

  function render() {
    document.querySelectorAll('#namePopover [data-style]').forEach((b) => b.classList.toggle('on', b.dataset.style === state.style));
    document.querySelectorAll('#namePopover [data-gender]').forEach((b) => b.classList.toggle('on', b.dataset.gender === state.gender));
    $('nameGender').classList.toggle('hidden', state.style === 'code');
    $('nameList').replaceChildren(...batch(state.style, state.gender).map((name) => {
      const b = document.createElement('button');
      b.className = 'name-item';
      b.textContent = name;
      b.title = '点击插入到光标处 · ⌥ 点击复制';
      b.addEventListener('click', (e) => {
        if (e.altKey) {
          navigator.clipboard.writeText(name);
          flash(b, '已复制');
        } else insert(name);
      });
      return b;
    }));
  }

  function flash(el, text) {
    const old = el.textContent;
    el.textContent = text;
    setTimeout(() => { el.textContent = old; }, 700);
  }

  function insert(name) {
    const ed = $('editor');
    const start = ed.selectionStart;
    ed.setRangeText(name, start, ed.selectionEnd, 'end');
    ed.dispatchEvent(new Event('input'));
    close();
    ed.focus();
  }

  const isOpen = () => !$('namePopover').classList.contains('hidden');
  function open() { $('namePopover').classList.remove('hidden'); render(); }
  function close() { $('namePopover').classList.add('hidden'); }
  const toggle = () => (isOpen() ? close() : open());

  document.querySelector('.name-trigger').addEventListener('click', toggle);
  $('nameReroll').addEventListener('click', render);
  document.querySelectorAll('#namePopover [data-style]').forEach((b) => b.addEventListener('click', () => { state.style = b.dataset.style; render(); }));
  document.querySelectorAll('#namePopover [data-gender]').forEach((b) => b.addEventListener('click', () => { state.gender = b.dataset.gender; render(); }));
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); toggle(); }
    else if (e.key === 'Escape' && isOpen()) close();
  });
  document.addEventListener('mousedown', (e) => {
    if (isOpen() && !e.target.closest('#namePopover, .name-trigger')) close();
  });

  window.Names = { batch };
})();
