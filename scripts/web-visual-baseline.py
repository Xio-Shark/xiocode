#!/usr/bin/env python3
"""
Web visual baseline for the XioCode console.

Seeds a throwaway repository + session store (scripts/web-demo-fixture.ts),
starts `xio web` against it and captures every view in light, dark and
mobile layouts. Live states (streaming, a running tool, a permission
question, a dropped connection) are produced by feeding runtime events to
the page, so no provider key or real session is needed and the shots carry
no personal paths.
"""

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

CHROME_PATHS = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
]

LIVE_EVENTS = [
    {"event": "turn.start", "payload": {}},
    {"event": "thinking.delta", "payload": {"text": "先确认 server.ts 有没有别的入口直接读取 theme。"}},
    {"event": "text.delta", "payload": {"text": "我再检查一下 **server.ts** 里有没有直接读 `theme` 的地方，"}},
    {"event": "text.delta", "payload": {"text": "然后跑一遍完整测试：\n\n- 类型检查\n- 单测"}},
    {"event": "tool.call", "payload": {"toolCallId": "live1", "toolName": "grep", "args": {"pattern": "theme", "path": "src"}}},
    {"event": "tool.result", "payload": {"toolCallId": "live1", "content": "src/config.ts:1:export type Theme = ...", "isError": False}},
    {"event": "tool.call", "payload": {"toolCallId": "live2", "toolName": "bash", "args": {"command": "npm run check && npx vitest run"}}},
]

APPROVAL_EVENT = {"event": "web.approval", "payload": {
    "id": "q1",
    "question": "允许运行这条命令吗？ [y/N]",
    "detail": "git push --force origin main",
    "choices": [{"label": "允许一次", "value": "__allow"}, {"label": "拒绝", "value": "deny"}],
}}


def find_chrome():
    for p in CHROME_PATHS:
        if os.path.exists(p):
            return p
    return None


def seed_fixture(project_root, work_dir):
    out = subprocess.run(
        ["node", os.path.join(project_root, "scripts", "web-demo-fixture.ts"), work_dir],
        cwd=project_root, check=True, capture_output=True, text=True,
    )
    return json.loads(out.stdout.strip().splitlines()[-1])


def start_server(project_root, fixture, port):
    env = dict(os.environ)
    # Colour codes would wrap the printed URL; the shots must not depend on the user's shell.
    for key in ("FORCE_COLOR", "COLORTERM"):
        env.pop(key, None)
    env["NO_COLOR"] = "1"
    # A private HOME too: MCP discovery reads ~/.claude and ~/.cursor, which would put the
    # user's own servers into the shots.
    home = os.path.join(os.path.dirname(fixture["xioHome"]), "home")
    os.makedirs(home, exist_ok=True)
    env["HOME"] = home
    env["XIO_HOME"] = fixture["xioHome"]
    env["XIO_CONFIG"] = fixture["config"]
    cmd = [os.path.join(project_root, "bin", "xio"), "web", "--no-open", f"--port={port}"]
    proc = subprocess.Popen(
        cmd, cwd=fixture["repo"], env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, preexec_fn=os.setsid,
    )
    deadline = time.time() + 20
    seen = []
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            if proc.poll() is not None:
                break
            time.sleep(0.05)
            continue
        seen.append(line)
        match = re.search(r"(http://127\.0\.0\.1:\d+/\?token=[a-zA-Z0-9_-]+)", line)
        if match:
            return proc, match.group(1)
    stop_server(proc)
    raise RuntimeError("xio web did not print a launch URL:\n" + "".join(seen))


def stop_server(proc):
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except ProcessLookupError:
        pass


def open_page(browser, url, **context_args):
    context = browser.new_context(**context_args)
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda exc: errors.append(str(exc)))
    page.on("console", lambda msg: errors.append("console: " + msg.text) if msg.type == "error" else None)
    # SSE keeps the network busy: wait for the DOM, then for the transcript.
    page.goto(url, wait_until="domcontentloaded")
    page.wait_for_selector(".nav-tabs", timeout=5000)
    try:
        page.wait_for_selector(".message-row, .hero-state", timeout=5000)
    except Exception:
        raise RuntimeError("the transcript never rendered; page errors:\n  " + "\n  ".join(errors or ["(none)"]))
    page.wait_for_timeout(400)
    return page, errors


def feed(page, events):
    page.evaluate("events => events.forEach(e => handleRuntimeEvent(e))", events)
    page.wait_for_timeout(250)


def main():
    parser = argparse.ArgumentParser(description="Generate XioCode WebUI visual baseline screenshots")
    parser.add_argument("--out-dir", default="artifacts/visual-baseline", help="Directory to save screenshots")
    parser.add_argument("--port", type=int, default=3095, help="Port to run the test web server on")
    parser.add_argument("--only", default="", help="Comma-separated shot name prefixes to capture")
    args = parser.parse_args()

    out_dir = os.path.abspath(args.out_dir)
    os.makedirs(out_dir, exist_ok=True)
    only = [s for s in args.only.split(",") if s]

    chrome_path = find_chrome()
    if not chrome_path:
        print("Error: no system Chrome/Chromium for headless capture.", file=sys.stderr)
        sys.exit(1)
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("Error: python playwright not installed. Run: pip install playwright", file=sys.stderr)
        sys.exit(1)

    project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    work_dir = tempfile.mkdtemp(prefix="xio-web-shots-")
    fixture = seed_fixture(project_root, work_dir)
    proc, launch_url = start_server(project_root, fixture, args.port)
    print(f"Server ready (fixture in {work_dir})")

    captured = []
    page_errors = []

    def shot(page, name):
        if only and not any(name.startswith(p) for p in only):
            return
        path = os.path.join(out_dir, name + ".png")
        page.screenshot(path=path)
        captured.append(path)

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=chrome_path, headless=True)
            desktop = {"viewport": {"width": 1440, "height": 900}}

            page, errors = open_page(browser, launch_url, color_scheme="light", **desktop)
            page_errors.extend(errors)
            shot(page, "01-chat-light")
            page.click('[data-view="diff"]')
            page.wait_for_timeout(400)
            shot(page, "02-diff-light")
            page.click('[data-view="metrics"]')
            page.wait_for_timeout(200)
            shot(page, "03-metrics-light")
            page.click('[data-view="trajectory"]')
            page.wait_for_timeout(300)
            shot(page, "04-trajectory-light")
            page.click("#btn-open-settings")
            page.wait_for_timeout(400)
            shot(page, "05-settings-models")
            for tab, name in (("plugins", "06-settings-plugins"), ("safety", "07-settings-safety")):
                page.click(f'[data-settings-tab="{tab}"]')
                page.wait_for_timeout(250)
                shot(page, name)
            page.keyboard.press("Escape")
            page.wait_for_timeout(200)

            page.click('[data-view="chat"]')
            feed(page, LIVE_EVENTS)
            shot(page, "08-chat-live")
            feed(page, [APPROVAL_EVENT])
            shot(page, "09-approval")
            page.keyboard.press("Escape")
            page.wait_for_timeout(200)
            feed(page, [{"event": "web.idle", "payload": {}}])

            page.click("#btn-new-session")
            page.wait_for_timeout(400)
            shot(page, "10-new-session")

            dark, errors = open_page(browser, launch_url, color_scheme="dark", **desktop)
            page_errors.extend(errors)
            shot(dark, "11-chat-dark")
            dark.click('[data-view="diff"]')
            dark.wait_for_timeout(400)
            shot(dark, "12-diff-dark")
            dark.click('[data-view="trajectory"]')
            dark.wait_for_timeout(300)
            shot(dark, "13-trajectory-dark")
            dark.click('[data-view="chat"]')
            feed(dark, LIVE_EVENTS)
            shot(dark, "14-chat-live-dark")

            mobile, errors = open_page(browser, launch_url, viewport={"width": 390, "height": 844},
                                       is_mobile=True, has_touch=True, color_scheme="light")
            page_errors.extend(errors)
            shot(mobile, "15-mobile")

            browser.close()
    finally:
        stop_server(proc)
        shutil.rmtree(work_dir, ignore_errors=True)

    print(f"\nCaptured {len(captured)} screenshots in {out_dir}:")
    for path in captured:
        print(f"  - {os.path.basename(path)}")
    if page_errors:
        print("\nPage errors:", file=sys.stderr)
        for err in page_errors:
            print("  " + err, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
