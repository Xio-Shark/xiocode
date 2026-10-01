/**
 * Markdown → DOM for assistant replies. Model output is untrusted, so nothing
 * is ever parsed as HTML: every node is created with createElement and every
 * piece of text goes through textContent. Raw HTML in a reply shows up as text.
 *
 * Streaming: `render(container, source)` splits the source into top-level
 * blocks and keeps the DOM of blocks whose source did not change, so a delta
 * only rebuilds the block being written (usually the last one).
 */
const XioMarkdown = (() => {
  const SAFE_URL = /^(https?:|mailto:)/i;

  // ---------- Block parsing ----------

  const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
  const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  const HR = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
  const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const QUOTE = /^ {0,3}>\s?(.*)$/;
  const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

  /** Top-level blocks with their exact source text (the cache key). */
  function splitBlocks(source) {
    const lines = source.split("\n");
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i += 1; continue; }
      const start = i;
      const fence = line.match(FENCE);
      if (fence) {
        i += 1;
        while (i < lines.length && !closesFence(lines[i], fence[1])) i += 1;
        const closed = i < lines.length;
        if (closed) i += 1;
        blocks.push({ type: "code", lang: fence[2], lines: lines.slice(start + 1, closed ? i - 1 : i), closed, src: lines.slice(start, i).join("\n") });
        continue;
      }
      if (HEADING.test(line) || HR.test(line)) {
        i += 1;
        blocks.push({ type: HR.test(line) ? "hr" : "heading", lines: [line], src: line });
        continue;
      }
      if (line.includes("|") && i + 1 < lines.length && lines[i + 1].includes("|") && TABLE_SEP.test(lines[i + 1])) {
        i += 2;
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) i += 1;
        blocks.push({ type: "table", lines: lines.slice(start, i), src: lines.slice(start, i).join("\n") });
        continue;
      }
      const kind = QUOTE.test(line) ? "quote" : LIST_ITEM.test(line) ? "list" : "para";
      i += 1;
      while (i < lines.length && continues(kind, lines[i])) i += 1;
      blocks.push({ type: kind, lines: lines.slice(start, i), src: lines.slice(start, i).join("\n") });
    }
    return blocks;
  }

  function closesFence(line, open) {
    const t = line.trim();
    return t.length >= open.length && t[0] === open[0] && /^(`+|~+)$/.test(t);
  }

  function startsOtherBlock(line) {
    return FENCE.test(line) || HEADING.test(line) || HR.test(line);
  }

  function continues(kind, line) {
    if (!line.trim()) return false;
    if (startsOtherBlock(line)) return false;
    if (kind === "quote") return QUOTE.test(line);
    if (kind === "list") return LIST_ITEM.test(line) || /^\s{2,}\S/.test(line);
    return !QUOTE.test(line) && !LIST_ITEM.test(line);
  }

  // ---------- Block rendering ----------

  function renderBlock(block) {
    switch (block.type) {
      case "code": return codeBlock(block.lines.join("\n"), block.lang, block.closed);
      case "hr": return el("hr");
      case "heading": {
        const m = block.lines[0].match(HEADING);
        // Reply headings sit inside a message; keep them below the page title.
        const h = el("h" + Math.min(6, m[1].length + 2));
        h.append(...inline(m[2]));
        return h;
      }
      case "table": return table(block.lines);
      case "quote": {
        const q = el("blockquote");
        const inner = block.lines.map(l => l.match(QUOTE)[1]).join("\n");
        splitBlocks(inner).forEach(b => q.appendChild(renderBlock(b)));
        return q;
      }
      case "list": return list(block.lines);
      default: {
        const p = el("p");
        block.lines.forEach((line, idx) => {
          if (idx > 0) p.appendChild(/ {2,}$|\\$/.test(block.lines[idx - 1]) ? el("br") : document.createTextNode(" "));
          p.append(...inline(line.replace(/\\$/, "").trim()));
        });
        return p;
      }
    }
  }

  function list(lines) {
    const first = lines[0].match(LIST_ITEM);
    const baseIndent = first[1].length;
    const ordered = /\d/.test(first[2]);
    const root = el(ordered ? "ol" : "ul");
    if (ordered && parseInt(first[2], 10) !== 1) root.start = parseInt(first[2], 10);
    let item = null;
    let nested = [];
    const flush = () => {
      if (item && nested.length) item.appendChild(list(nested));
      nested = [];
    };
    for (const line of lines) {
      const m = line.match(LIST_ITEM);
      if (m && m[1].length <= baseIndent + 1) {
        flush();
        item = el("li");
        const task = m[3].match(/^\[([ xX])\]\s+(.*)$/);
        if (task) {
          item.className = "task";
          const box = el("span", "task-box" + (task[1] === " " ? "" : " done"));
          box.setAttribute("aria-hidden", "true");
          item.append(box, ...inline(task[2]));
        } else {
          item.append(...inline(m[3]));
        }
        root.appendChild(item);
      } else if (m) {
        nested.push(line);
      } else if (item) {
        if (nested.length) nested.push(line);
        else item.append(" ", ...inline(line.trim()));
      }
    }
    flush();
    return root;
  }

  function splitRow(line) {
    let row = line.trim();
    if (row.startsWith("|")) row = row.slice(1);
    if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
    return row.split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, "|"));
  }

  function table(lines) {
    const wrap = el("div", "md-table-wrap");
    const t = el("table");
    const aligns = splitRow(lines[1]).map(c => c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "");
    const head = el("thead");
    const hr = el("tr");
    splitRow(lines[0]).forEach((c, i) => {
      const th = el("th");
      if (aligns[i]) th.style.textAlign = aligns[i];
      th.append(...inline(c));
      hr.appendChild(th);
    });
    head.appendChild(hr);
    const body = el("tbody");
    lines.slice(2).forEach(line => {
      const tr = el("tr");
      splitRow(line).forEach((c, i) => {
        const td = el("td");
        if (aligns[i]) td.style.textAlign = aligns[i];
        td.append(...inline(c));
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
    t.append(head, body);
    wrap.appendChild(t);
    return wrap;
  }

  // ---------- Inline ----------

  const INLINE = [
    { re: /^`([^`]+)`/, make: m => withText("code", m[1]) },
    { re: /^\*\*([\s\S]+?)\*\*(?!\*)/, make: m => wrapInline("strong", m[1]) },
    { re: /^__([\s\S]+?)__(?!_)/, make: m => wrapInline("strong", m[1]) },
    { re: /^~~([\s\S]+?)~~/, make: m => wrapInline("del", m[1]) },
    { re: /^\*(?!\s)([^*]+?)\*(?!\*)/, make: m => wrapInline("em", m[1]) },
    { re: /^_(?!\s)([^_]+?)_(?![\w])/, make: m => wrapInline("em", m[1]) },
    { re: /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/, make: m => link(m[1], m[2]) },
    { re: /^<(https?:\/\/[^>\s]+)>/, make: m => link(m[1], m[1]) },
    { re: /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/, make: m => link(m[0], m[0]) },
  ];

  function inline(text) {
    const out = [];
    let buf = "";
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === "\\" && i + 1 < text.length && /[\\`*_[\]()#+\-.!|~<>]/.test(text[i + 1])) {
        buf += text[i + 1];
        i += 2;
        continue;
      }
      // Only try a rule where one can start; plain prose is copied in runs.
      if ("`*_~[<".includes(ch) || (ch === "h" && text.startsWith("http", i))) {
        const rest = text.slice(i);
        const prevWord = i > 0 && /\w/.test(text[i - 1]);
        let hit = null;
        for (const rule of INLINE) {
          if (ch === "_" && prevWord) break;
          const m = rest.match(rule.re);
          if (m) { hit = { node: rule.make(m), len: m[0].length }; break; }
        }
        if (hit) {
          if (buf) { out.push(document.createTextNode(buf)); buf = ""; }
          out.push(hit.node);
          i += hit.len;
          continue;
        }
      }
      buf += ch;
      i += 1;
    }
    if (buf) out.push(document.createTextNode(buf));
    return out;
  }

  function wrapInline(tag, inner) {
    const node = el(tag);
    node.append(...inline(inner));
    return node;
  }

  function link(label, href) {
    if (!SAFE_URL.test(href)) return document.createTextNode(label);
    const a = el("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.append(...inline(label));
    return a;
  }

  // ---------- Code blocks ----------

  const KEYWORDS = new Set((
    "abstract as async await break case catch class const continue def default defer del delete do elif else enum export extends " +
    "false final finally fn for from func function go if impl import in instanceof interface is let match mod module mut new nil " +
    "none not null of or package pass pub raise readonly return self static struct super switch then this throw true try type " +
    "typeof undefined use var void while with yield None True False echo fi done esac local"
  ).split(" "));

  const TOKEN = /(\/\/[^\n]*|#(?!\[)[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`|\b\d[\d_]*(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/g;
  const HASH_COMMENT_LANGS = new Set(["sh", "bash", "zsh", "shell", "py", "python", "rb", "ruby", "toml", "yaml", "yml", "dockerfile", "make", "r"]);

  /** A light tokenizer: comments, strings, numbers, keywords. Text only — never markup. */
  function highlight(code, lang) {
    const frag = document.createDocumentFragment();
    if (code.length > 20000) {
      frag.appendChild(document.createTextNode(code));
      return frag;
    }
    const hashComments = HASH_COMMENT_LANGS.has((lang || "").toLowerCase());
    let last = 0;
    for (const m of code.matchAll(TOKEN)) {
      const tok = m[0];
      let cls = "";
      if (tok.startsWith("//") || tok.startsWith("/*")) cls = "tok-comment";
      else if (tok.startsWith("#")) cls = hashComments ? "tok-comment" : "";
      else if (/^["'`]/.test(tok)) cls = "tok-string";
      else if (/^\d/.test(tok)) cls = "tok-number";
      else if (KEYWORDS.has(tok)) cls = "tok-keyword";
      else if (code[m.index + tok.length] === "(") cls = "tok-fn";
      if (!cls) continue;
      if (m.index > last) frag.appendChild(document.createTextNode(code.slice(last, m.index)));
      frag.appendChild(withText("span", tok, cls));
      last = m.index + tok.length;
    }
    if (last < code.length) frag.appendChild(document.createTextNode(code.slice(last)));
    return frag;
  }

  function codeBlock(code, lang, closed = true) {
    const wrap = el("div", "code-block");
    const head = el("div", "code-head");
    head.appendChild(withText("span", lang || "text", "code-lang"));
    const copy = el("button", "code-copy");
    copy.type = "button";
    copy.dataset.action = "copy";
    copy.setAttribute("aria-label", "复制代码");
    copy.appendChild(window.xioIcon ? window.xioIcon("copy") : document.createTextNode(""));
    copy.appendChild(withText("span", "复制"));
    head.appendChild(copy);
    const pre = el("pre");
    const c = el("code");
    // Highlight once the fence closes; while streaming, plain text is cheaper and does not flicker.
    if (closed) c.appendChild(highlight(code, lang));
    else c.textContent = code;
    pre.appendChild(c);
    wrap.append(head, pre);
    return wrap;
  }

  // ---------- Helpers & entry ----------

  function el(tag, cls) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  }

  function withText(tag, text, cls) {
    const node = el(tag, cls);
    node.textContent = text;
    return node;
  }

  /** Render `source` into `container`, reusing the DOM of unchanged leading blocks. */
  function render(container, source) {
    const blocks = splitBlocks(source || "");
    const cache = container._mdBlocks || [];
    let keep = 0;
    while (keep < cache.length && keep < blocks.length && cache[keep].src === blocks[keep].src && cache[keep].closed !== false) keep += 1;
    for (let i = cache.length - 1; i >= keep; i -= 1) cache[i].node.remove();
    const next = cache.slice(0, keep);
    for (let i = keep; i < blocks.length; i += 1) {
      const node = renderBlock(blocks[i]);
      container.appendChild(node);
      next.push({ src: blocks[i].src, closed: blocks[i].type === "code" ? blocks[i].closed : true, node });
    }
    container._mdBlocks = next;
  }

  return { render, codeBlock, highlight, splitBlocks };
})();
