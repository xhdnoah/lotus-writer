# Lotus

Lotus 是一款基于 Electron 的科幻小说写作桌面软件。左边是章节树，中间是正文，右边是**资料侧边栏**：它会读取光标所在的段落，找出值得查证的科学概念，然后列出维基百科等可信来源的条目，可以直接在侧边栏里阅读。

## 运行

```bash
npm install
npm start
```

## 侧边栏怎么找资料

1. **识别概念**（光标停留约 1.2 秒，或者切换到别的段落时触发）
   - **本地模式**（默认，不需要任何密钥）
     - 描述性说法规则：“宇宙的寿命” → 宇宙的终极命运 / 热寂 / 宇宙年龄
     - 科幻术语表：约 90 个常用概念及其别称（`src/renderer/glossary.js`）
     - `Intl.Segmenter` 中文分词，把相邻词拼成候选词，再用中文维基的标题、重定向和繁简转换核对是否真有这个条目，并去掉消歧义页
   - **Claude 模式**（在设置里填 Anthropic API Key）：由 `claude-opus-5-5` 把口语化的描述映射成规范的词条名，同时给出英文条目名和一句关联说明
2. **查询来源**
   - 维基百科 · 中文：命中的条目，附摘要和缩略图
   - 延伸阅读：用排名靠前的几个概念做全文检索，补上没有直接命中的相关条目
   - Wikipedia · English：通过跨语言链接找到对应的英文条目
   - arXiv：先按标题、再按摘要检索相关论文
3. **阅读与收藏**：点卡片在侧边栏里打开清理过的条目正文，正文里的维基链接也在侧边栏里跳转；📌 把条目收进本书的“资料夹”。

点上方的概念标签可以暂时排除这个概念，↻ 会重新查询当前段落。

## 缓存

查过的维基百科和 arXiv 内容都会存到本机（`~/Library/Application Support/Lotus/lotus-cache/`），包括条目摘要、搜索结果和阅读器里的正文：

- 7 天内再查同样的内容，直接用缓存，不发请求，重启后也有效
- 过了 7 天会重新拉取；如果这时断网或被限流，就退回旧缓存，状态栏显示“离线 · 缓存”
- 设置里可以看缓存条数和大小，也可以一键清空；超过 5000 条时自动删掉最旧的

## 角色取名（隐藏功能）

点左上角的 “Lotus” 字样，或者按 `⌘⇧N`（Windows/Linux 上是 `Ctrl+Shift+N`），会弹出取名面板：

- 风格：中文、西式、日式、星际代号
- 性别：随机、男、女、中性
- 点名字插入到光标处，按住 ⌥ 点击则复制，↻ 换一批，Esc 关闭

## 结构

```
src/main.js            主进程：窗口、存储、受限的网络代理（只允许访问 wikipedia.org / arxiv.org）、响应缓存与限流重试
src/ai.js              Claude 概念识别（结构化 JSON 输出）
src/cache.js           维基百科 / arXiv 响应的磁盘缓存
src/preload.js         contextBridge 接口
src/renderer/          界面：app.js（编辑器/章节）、research.js（侧边栏）、sanitize.js（维基 HTML 白名单清洗）、names.js（取名）
```

数据保存在 `~/Library/Application Support/Lotus/`（`project.json`、`settings.json`）。

## 冒烟测试

```bash
LOTUS_SMOKE=/tmp/lotus-smoke LOTUS_SMOKE_TEXT='舰长下令启动曲速引擎……' npx electron .
```

这条命令会用独立的数据目录启动应用，等侧边栏查出结果后打印侧边栏文字，打开第一张卡片，然后把截图存成 `smoke.png` 和 `reader.png`；接着测试取名面板（截图 `names.png`）。加上 `LOTUS_SMOKE_OFFLINE=1` 可以模拟断网，用来检查缓存。
