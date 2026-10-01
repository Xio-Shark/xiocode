#!/usr/bin/env python3
"""
Behaviour checks for the XioCode web console against the demo fixture
(see web-visual-baseline.py). Each check prints PASS/FAIL; exit code 1 on
any failure.

  python3 scripts/web-behaviour-check.py
"""

import importlib.util
import os
import shutil
import sys
import tempfile
import time

# Importing the baseline module must not leave scripts/__pycache__ behind.
sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("baseline", os.path.join(HERE, "web-visual-baseline.py"))
baseline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(baseline)

XSS = "看这里 <img src=x onerror=\"window.__xss=1\"> [点我](javascript:window.__xss=2) <script>window.__xss=3</script>"
results = []

# Every visible text node: its computed font size, and its contrast against the backgrounds behind it.
AUDIT = r"""() => {
  const parse = c => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return {r:p[0],g:p[1],b:p[2],a:p.length>3?p[3]:1}; };
  const lum = ({r,g,b}) => { const f = v => { v/=255; return v<=0.03928? v/12.92 : Math.pow((v+0.055)/1.055,2.4); }; return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b); };
  const blend = (top, bot) => ({ r: top.r*top.a + bot.r*(1-top.a), g: top.g*top.a + bot.g*(1-top.a), b: top.b*top.a + bot.b*(1-top.a), a: 1 });
  const bgOf = el => { const stack = []; for (let n = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; } } let base = {r:255,g:255,b:255,a:1}; if (stack.length && stack[stack.length-1].a >= 1) base = stack.pop(); while (stack.length) base = blend(stack.pop(), base); return base; };
  const sizes = new Set(); const bad = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const t = walker.currentNode; if (!t.textContent.trim()) continue;
    const el = t.parentElement; const r = el.getBoundingClientRect();
    if (!r.width || !r.height || el.closest('[hidden],dialog:not([open]),.icon-sprite')) continue;
    const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.opacity === '0' || cs.color === 'rgba(0, 0, 0, 0)') continue;
    sizes.add(cs.fontSize);
    const fg = parse(cs.color); const bg = bgOf(el); const f = fg.a < 1 ? blend(fg, bg) : fg;
    const L1 = lum(f), L2 = lum(bg); const ratio = (Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05);
    const large = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.66 && +cs.fontWeight >= 700);
    if (ratio < (large ? 3 : 4.5)) bad.push({ text: t.textContent.trim().slice(0,30), cls: el.className, ratio: +ratio.toFixed(2), color: cs.color });
  }
  return { sizes: [...sizes].sort((a,b)=>parseFloat(a)-parseFloat(b)), bad };
}"""


def check(name, ok, detail=""):
    results.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""))


def feed(page, events):
    page.evaluate("events => events.forEach(e => handleRuntimeEvent(e))", events)
    page.wait_for_timeout(120)


def check_timeline(page):
    """Trajectory on a real time axis; sessions without a timeline say so; usage survives a reload."""
    page.click('[data-view="trajectory"]')
    page.wait_for_timeout(300)
    blocks = page.evaluate("""() => [...document.querySelectorAll('#tl-chart .tl-block')].map(b => ({
        label: b.getAttribute('aria-label'), width: b.getBoundingClientRect().width }))""")
    steps = page.evaluate("document.querySelectorAll('.traj-item').length")
    check("every step of the timed session is drawn", len(blocks) == steps, f"{len(blocks)} blocks / {steps} steps")
    width = lambda needle: next((b["width"] for b in blocks if needle in b["label"]), 0)
    check("block width follows duration (18s install > 3.3s failed run)", width("#10 ") > 3 * width("#8 "),
          f"{width('#10 '):.0f}px vs {width('#8 '):.0f}px")
    check("idle gap between turns is folded and labelled", "空闲 2 小时" in (page.text_content("#tl-chart") or ""))
    check("header separates active time from span", "活跃" in page.text_content("#traj-stat-duration"))
    page.click('[data-view="metrics"]')
    check("usage comes back from the timeline after a reload", page.text_content("#val-tokens") == "45,490")
    page.click("text=解释一下 server.ts 的启动流程")
    page.wait_for_timeout(400)
    page.click('[data-view="trajectory"]')
    page.wait_for_timeout(200)
    check("a session without a timeline falls back to step order", page.text_content("#timeline-title") == "步骤顺序"
          and "没有时间记录" in page.text_content("#timeline-note"))
    page.click("text=给 parseConfig 加上 port")
    page.wait_for_timeout(400)
    page.click('[data-view="chat"]')
    page.wait_for_timeout(200)


def run(page, server_proc):
    # 1. Markdown is rendered, model-supplied HTML/JS is not.
    feed(page, [{"event": "turn.start", "payload": {}},
                {"event": "text.delta", "payload": {"text": XSS + "\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n**粗体** `code`"}}])
    page.wait_for_timeout(200)
    state = page.evaluate("""() => {
        const last = [...document.querySelectorAll('.prose')].pop();
        return {
          imgs: last.querySelectorAll('img').length,
          scripts: last.querySelectorAll('script').length,
          jsLinks: [...last.querySelectorAll('a')].filter(a => a.href.startsWith('javascript')).length,
          table: last.querySelectorAll('table td').length,
          strong: last.querySelectorAll('strong').length,
          xss: window.__xss || 0,
          text: last.textContent,
        };
    }""")
    check("XSS sample stays text", state["imgs"] == 0 and state["scripts"] == 0 and state["jsLinks"] == 0 and state["xss"] == 0, str(state["xss"]))
    check("markdown table and bold render", state["table"] == 2 and state["strong"] >= 1)
    check("raw tag shown as text", "<img src=x" in state["text"])

    # 2. Scrolling up while streaming is not undone by the next delta.
    for i in range(40):
        feed(page, [{"event": "text.delta", "payload": {"text": f"\n\n第 {i} 段：持续输出，用来把页面撑高。"}}])
    page.evaluate("document.getElementById('chat-messages').scrollTop = 0")
    page.wait_for_timeout(150)
    feed(page, [{"event": "text.delta", "payload": {"text": "\n\n还在输出……"}}])
    page.wait_for_timeout(200)
    top = page.evaluate("document.getElementById('chat-messages').scrollTop")
    jump_visible = page.is_visible("#btn-jump-bottom")
    check("scrolled-up reader is not pulled down", top < 50, f"scrollTop={top}")
    check("jump-to-bottom button appears", jump_visible)
    page.click("#btn-jump-bottom")
    page.wait_for_timeout(150)
    gap = page.evaluate("(() => { const s = document.getElementById('chat-messages'); return s.scrollHeight - s.scrollTop - s.clientHeight; })()")
    check("jump button returns to bottom and re-sticks", gap < 4 and not page.is_visible("#btn-jump-bottom"), f"gap={gap}")

    # 3. Esc on a permission question declines it (posts approve=false).
    posted = []
    page.on("request", lambda r: posted.append(r.post_data) if r.url.endswith("/approval") else None)
    feed(page, [{"event": "web.approval", "payload": {"id": "q9", "question": "允许运行吗？ [y/N]", "detail": "rm -rf build"}}])
    focused = page.evaluate("document.activeElement.textContent")
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)
    check("decline is focused when the question opens", focused.startswith("拒绝"), focused)
    check("Esc answers the question with a denial", any(p and '"approve":false' in p for p in posted), str(posted))
    check("approval dialog closes", not page.evaluate("document.getElementById('approval-modal').open"))

    # 4. Tabs work from the keyboard.
    page.focus(".nav-tab.active")
    page.keyboard.press("ArrowRight")
    page.wait_for_timeout(150)
    check("ArrowRight moves to the next tab", page.evaluate("document.querySelector('.nav-tab.active').dataset.view") == "trajectory")
    page.keyboard.press("End")
    page.wait_for_timeout(150)
    check("End jumps to the last tab", page.evaluate("document.querySelector('.nav-tab.active').dataset.view") == "metrics")
    page.keyboard.press("Home")

    # 5. Theme switch sets and clears data-theme.
    page.click('[data-theme-choice="dark"]')
    dark = page.evaluate("document.documentElement.dataset.theme")
    bg = page.evaluate("getComputedStyle(document.body).backgroundColor")
    page.click('[data-theme-choice="system"]')
    cleared = page.evaluate("document.documentElement.dataset.theme === undefined")
    check("theme switch applies dark and returns to system", dark == "dark" and bg == "rgb(15, 17, 21)" and cleared, bg)

    # 6. Idle settles a tool that never returned.
    feed(page, [{"event": "tool.call", "payload": {"toolCallId": "z1", "toolName": "bash", "args": {"command": "sleep 100"}}},
                {"event": "web.idle", "payload": {}}])
    page.wait_for_timeout(300)
    check("no spinner survives the end of a turn", page.evaluate("document.querySelectorAll('.tool-row.running').length") == 0)
    check("send button disabled while the composer is empty", page.is_disabled("#btn-send"))

    # 7. Stopping the server shows the outage within 5 seconds.
    baseline.stop_server(server_proc)
    started = time.time()
    seen = False
    while time.time() - started < 5:
        if page.is_visible("#connection-banner"):
            seen = True
            break
        page.wait_for_timeout(100)
    check("connection loss is visible within 5s", seen, f"{time.time() - started:.1f}s")
    check("status pill reads 已断开", page.text_content("#status-text") == "已断开")
    return started


def check_restart(page, project_root, fixture):
    """A restarted server has a new token: the page must say so instead of retrying forever."""
    proc, _ = baseline.start_server(project_root, fixture, 3096)
    try:
        expired = False
        deadline = time.time() + 12
        while time.time() < deadline:
            if "凭据已失效" in (page.text_content("#connection-text") or ""):
                expired = True
                break
            page.wait_for_timeout(200)
        check("after a restart the page asks for the new link", expired, page.text_content("#connection-text"))
        check("no pointless retry button for an expired link", not page.is_visible("#btn-reconnect"))
    finally:
        baseline.stop_server(proc)


def audit_typography(browser, url):
    """WCAG 1.4.3 contrast for all visible text, and the six-size type scale, in both themes."""
    for scheme in ("light", "dark"):
        page, _ = baseline.open_page(browser, url, viewport={"width": 1440, "height": 900}, color_scheme=scheme)
        feed(page, baseline.LIVE_EVENTS)
        sizes, bad = set(), {}
        def take():
            r = page.evaluate(AUDIT)
            sizes.update(r["sizes"])
            for x in r["bad"]:
                bad[(x["text"], x["cls"])] = x["ratio"]
        take()
        for view in ("trajectory", "diff", "metrics"):
            page.click(f'[data-view="{view}"]')
            page.wait_for_timeout(400)
            take()
        page.click("#btn-open-settings")
        for tab in ("models", "rules", "plugins", "safety"):
            page.click(f'[data-settings-tab="{tab}"]')
            page.wait_for_timeout(200)
            take()
        check(f"{scheme}: at most 6 font sizes", len(sizes) <= 6, ", ".join(sorted(sizes, key=lambda v: float(v[:-2]))))
        check(f"{scheme}: all text meets contrast", not bad, "; ".join(f"{t}({c}) {r}" for (t, c), r in list(bad.items())[:5]))
        page.context.close()


def main():
    from playwright.sync_api import sync_playwright
    project_root = os.path.abspath(os.path.join(HERE, ".."))
    work_dir = tempfile.mkdtemp(prefix="xio-web-check-")
    fixture = baseline.seed_fixture(project_root, work_dir)
    proc, url = baseline.start_server(project_root, fixture, 3096)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=baseline.find_chrome(), headless=True)
            page, errors = baseline.open_page(browser, url, viewport={"width": 1280, "height": 800})
            audit_typography(browser, url)
            check_timeline(page)
            run(page, proc)
            check_restart(page, project_root, fixture)
            check("no uncaught page errors", not [e for e in errors if not e.startswith("console:")], "; ".join(errors))
            browser.close()
    finally:
        baseline.stop_server(proc)
        shutil.rmtree(work_dir, ignore_errors=True)
    failed = results.count(False)
    print(f"\n{len(results) - failed}/{len(results)} checks passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
