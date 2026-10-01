#!/usr/bin/env python3
"""
Web Visual Regression Baseline Generator for XioCode WebUI.
Captures baseline screenshots across Desktop (Light/Dark, 1440x900) and Mobile (390x844).
Covers: Chat, Trajectory, Code Diff, Metrics, Settings, Approval Dialog, and Mobile.
"""

import argparse
import os
import re
import signal
import subprocess
import sys
import time

CHROME_PATHS = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
]

def find_chrome():
    for p in CHROME_PATHS:
        if os.path.exists(p):
            return p
    return None

def main():
    parser = argparse.ArgumentParser(description="Generate XioCode WebUI visual baseline screenshots")
    parser.add_argument("--out-dir", default="artifacts/visual-baseline", help="Directory to save screenshots")
    parser.add_argument("--port", type=int, default=3095, help="Port to run test web server on")
    args = parser.parse_args()

    out_dir = os.path.abspath(args.out_dir)
    os.makedirs(out_dir, exist_ok=True)

    chrome_path = find_chrome()
    if not chrome_path:
        print("Error: Could not find system Chrome/Chromium for headless capture.", file=sys.stderr)
        sys.exit(1)

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("Error: python playwright not installed. Run: pip install playwright", file=sys.stderr)
        sys.exit(1)

    print(f"Starting xio web server on port {args.port}...")
    project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    cmd = [os.path.join(project_root, "bin", "xio"), "web", "--no-open", f"--port={args.port}"]
    proc = subprocess.Popen(
        cmd,
        cwd=project_root,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        preexec_fn=os.setsid,
    )

    launch_url = None
    deadline = time.time() + 15
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            time.sleep(0.05)
            continue
        # Strip ANSI escape sequences to avoid appending \x1b[0m to the token
        match = re.search(r"(http://127\.0\.0\.1:\d+/\?token=[a-zA-Z0-9_-]+)", line)
        if match:
            launch_url = match.group(1)
            break

    if not launch_url:
        print("Failed to capture xio web launch URL", file=sys.stderr)
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        sys.exit(1)

    print(f"Server ready at: {launch_url}")

    captured = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=chrome_path, headless=True)

            # 1. Desktop Light (1440x900)
            context = browser.new_context(viewport={"width": 1440, "height": 900}, color_scheme="light")
            page = context.new_page()
            # Note: Do not wait for networkidle because web SSE keeps connection open
            page.goto(launch_url, wait_until="domcontentloaded")
            page.wait_for_selector(".nav-tabs", timeout=5000)
            page.wait_for_timeout(300)

            # 01: Chat Tab Light
            p1 = os.path.join(out_dir, "01-chat-light.png")
            page.screenshot(path=p1)
            captured.append(p1)

            # 02: Diff Tab Light
            page.click('[data-view="diff"]')
            page.wait_for_timeout(200)
            p2 = os.path.join(out_dir, "02-diff-light.png")
            page.screenshot(path=p2)
            captured.append(p2)

            # 03: Metrics Tab Light
            page.click('[data-view="metrics"]')
            page.wait_for_timeout(200)
            p3 = os.path.join(out_dir, "03-metrics-light.png")
            page.screenshot(path=p3)
            captured.append(p3)

            # 04: Trajectory Tab Light
            page.click('[data-view="trajectory"]')
            page.wait_for_timeout(200)
            p4 = os.path.join(out_dir, "04-trajectory-light.png")
            page.screenshot(path=p4)
            captured.append(p4)

            # 05: Settings Modal - Models
            page.click("#btn-open-settings")
            page.wait_for_timeout(300)
            p5 = os.path.join(out_dir, "05-settings-models.png")
            page.screenshot(path=p5)
            captured.append(p5)

            # 06: Settings Modal - Plugins
            plugin_tab = page.query_selector('[data-settings-tab="plugins"]')
            if plugin_tab:
                plugin_tab.click()
                page.wait_for_timeout(200)
                p6 = os.path.join(out_dir, "06-settings-plugins.png")
                page.screenshot(path=p6)
                captured.append(p6)

            # 07: Settings Modal - Safety
            safety_tab = page.query_selector('[data-settings-tab="safety"]')
            if safety_tab:
                safety_tab.click()
                page.wait_for_timeout(200)
                p7 = os.path.join(out_dir, "07-settings-safety.png")
                page.screenshot(path=p7)
                captured.append(p7)

            # Close Settings
            page.keyboard.press("Escape")
            page.wait_for_timeout(200)

            # 2. Desktop Dark (1440x900)
            dark_context = browser.new_context(viewport={"width": 1440, "height": 900}, color_scheme="dark")
            dark_page = dark_context.new_page()
            dark_page.goto(launch_url, wait_until="domcontentloaded")
            dark_page.wait_for_selector(".nav-tabs", timeout=5000)
            dark_page.evaluate("document.documentElement.setAttribute('data-theme', 'dark')")
            dark_page.wait_for_timeout(300)

            # 08: Chat Tab Dark
            p8 = os.path.join(out_dir, "08-chat-dark.png")
            dark_page.screenshot(path=p8)
            captured.append(p8)

            # 09: Trajectory Tab Dark
            dark_page.click('[data-view="trajectory"]')
            dark_page.wait_for_timeout(200)
            p9 = os.path.join(out_dir, "09-trajectory-dark.png")
            dark_page.screenshot(path=p9)
            captured.append(p9)

            # 3. Mobile View (390x844)
            mobile_context = browser.new_context(viewport={"width": 390, "height": 844})
            mobile_page = mobile_context.new_page()
            mobile_page.goto(launch_url, wait_until="domcontentloaded")
            mobile_page.wait_for_selector(".nav-tabs", timeout=5000)
            mobile_page.wait_for_timeout(300)

            # 10: Mobile View
            p10 = os.path.join(out_dir, "10-mobile.png")
            mobile_page.screenshot(path=p10)
            captured.append(p10)

            browser.close()

    finally:
        print("Shutting down xio web server...")
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except Exception:
            pass

    print(f"\nSuccessfully generated {len(captured)} baseline screenshots in {out_dir}:")
    for shot in captured:
        print(f"  - {os.path.basename(shot)}")

if __name__ == "__main__":
    main()
