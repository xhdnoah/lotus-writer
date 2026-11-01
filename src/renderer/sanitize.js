// 把维基百科返回的 HTML 收窄成一份只含排版标签的安全片段。
(function () {
  const ALLOWED = new Set([
    'P', 'A', 'B', 'I', 'EM', 'STRONG', 'SUB', 'SUP', 'SPAN', 'BR', 'H2', 'H3', 'H4',
    'UL', 'OL', 'LI', 'DL', 'DT', 'DD', 'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH',
    'FIGURE', 'FIGCAPTION', 'IMG', 'CODE', 'PRE', 'SMALL', 'ABBR', 'DIV', 'SECTION',
  ]);
  const DROP_SELECTORS = [
    'style', 'script', 'link', 'meta', 'noscript',
    '.mw-editsection', '.navbox', '.vertical-navbox', '.sidebar', 'table.sidebar', '.metadata', '.ambox', '.hatnote',
    '.reference', '.references', '.reflist', '.mw-references-wrap', '.noprint', '.sistersitebox',
    '.mw-empty-elt', '.portalbox', '.authority-control', '.toc', '#toc', '.shortdescription',
  ];
  // 这些小节对写作参考意义不大，截掉以免阅读器过长
  const STOP_HEADINGS = /^(参考(文献|资料)?|注释|外部链接|参见|延伸阅读|References|Notes|External links|See also|Further reading)$/;

  function sanitizeWiki(html, { lang, onWikiLink }) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    DROP_SELECTORS.forEach((sel) => doc.querySelectorAll(sel).forEach((n) => n.remove()));

    // 从“参考文献”等标题开始，后面的内容全部丢弃
    for (const h of doc.querySelectorAll('h2')) {
      if (STOP_HEADINGS.test(h.textContent.trim())) {
        const block = h.closest('.mw-heading') || h;
        let n = block;
        while (n) {
          const next = n.nextSibling || (n.parentNode !== doc.body ? n.parentNode.nextSibling : null);
          n.remove();
          n = next;
        }
        break;
      }
    }

    const out = document.createDocumentFragment();
    const walk = (src, dst) => {
      for (const child of src.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          dst.appendChild(document.createTextNode(child.textContent));
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        if (!ALLOWED.has(child.tagName)) {
          walk(child, dst); // 不认识的标签只保留其文字
          continue;
        }
        const el = document.createElement(child.tagName);
        if (child.tagName === 'A') {
          const href = child.getAttribute('href') || '';
          const m = href.match(/^(?:\.\/|\/wiki\/)([^#?]+)/);
          if (m && !/^[^:]+:/.test(decodeURIComponent(m[1]))) {
            const title = decodeURIComponent(m[1]).replace(/_/g, ' ');
            el.addEventListener('click', (e) => { e.preventDefault(); onWikiLink(title); });
            el.title = title;
          } else if (/^https?:\/\//.test(href)) {
            el.addEventListener('click', (e) => { e.preventDefault(); window.lotus.open(href); });
            el.title = href;
          }
        } else if (child.tagName === 'IMG') {
          let src = child.getAttribute('src') || '';
          if (src.startsWith('//')) src = 'https:' + src;
          if (!/^https:\/\/(upload|thumb)\.wikimedia\.org\//.test(src)) continue;
          const w = Number(child.getAttribute('width'));
          if (w && w < 40) continue; // 跳过图标
          el.src = src;
          el.alt = child.getAttribute('alt') || '';
          el.loading = 'lazy';
        } else if (child.tagName === 'TD' || child.tagName === 'TH') {
          ['colspan', 'rowspan'].forEach((a) => child.hasAttribute(a) && el.setAttribute(a, child.getAttribute(a)));
        }
        walk(child, el);
        dst.appendChild(el);
      }
    };
    walk(doc.body, out);
    return out;
  }

  window.sanitizeWiki = sanitizeWiki;
})();
