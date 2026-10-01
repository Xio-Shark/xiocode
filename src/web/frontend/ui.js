/**
 * Shared helpers for the console scripts: DOM building, icons, the JSON API,
 * toasts, the confirm dialog and formatting. Loaded first; every other script
 * may use these globals.
 */

/** `el("div", "cls", child, "text")` — strings become text nodes, never markup. */
function el(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** An icon from the sprite in index.html. */
function xioIcon(name, className) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "icon" + (className ? " " + className : ""));
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", "#i-" + name);
  svg.appendChild(use);
  return svg;
}
window.xioIcon = xioIcon;

function iconButton(name, label, className) {
  const b = el("button", className || "icon-btn", xioIcon(name));
  b.type = "button";
  b.setAttribute("aria-label", label);
  b.title = label;
  return b;
}

const $ = (id) => document.getElementById(id);

/** Same-origin JSON call; the session cookie authenticates it. Errors carry the server's message. */
async function api(url, options = {}) {
  let res;
  try {
    res = await fetch(url, {
      method: options.method || "GET",
      headers: options.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new Error("连不上本地服务，确认 xio web 还在运行");
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      if (res.ok) throw new Error("服务返回了无法解析的响应（HTTP " + res.status + "）");
    }
  }
  if (!res.ok) {
    const err = new Error(res.status === 401
      ? "访问凭据已失效，请重新打开 xio web 打印的链接"
      : (data && data.error) || ("HTTP " + res.status));
    err.status = res.status;
    throw err;
  }
  return data;
}

const TOAST_ICONS = { success: "check", error: "alert", info: "info" };

function showToast(message, type = "success") {
  const toast = el("div", "toast " + type, xioIcon(TOAST_ICONS[type] || "info"), el("span", null, message));
  if (type === "error") toast.setAttribute("role", "alert");
  $("toast-container").appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 300);
  }, type === "error" ? 6000 : 3000);
}

/** Resolves true only when the user picks the confirm button; Esc and Cancel resolve false. */
function confirmDialog({ title, description, confirmLabel = "确认" }) {
  const dialog = $("confirm-modal");
  $("confirm-title").textContent = title;
  $("confirm-desc").textContent = description || "";
  $("confirm-ok").textContent = confirmLabel;
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
  });
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    showToast("复制失败：" + (err && err.message ? err.message : "浏览器拒绝访问剪贴板"), "error");
    return;
  }
  const label = button.querySelector("span");
  button.classList.add("copied");
  if (label) label.textContent = "已复制";
  setTimeout(() => {
    button.classList.remove("copied");
    if (label) label.textContent = "复制";
  }, 1500);
}

// ---------- Formatting ----------

/** 45 秒 · 12 分 5 秒 · 3 小时 20 分 · 2 天 4 小时 — units carry over, never "26717m". */
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const sec = Math.round(ms / 1000);
  if (sec < 1) return "不到 1 秒";
  if (sec < 60) return sec + " 秒";
  const min = Math.floor(sec / 60);
  if (min < 60) return min + " 分" + (sec % 60 ? " " + (sec % 60) + " 秒" : "");
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + " 小时" + (min % 60 ? " " + (min % 60) + " 分" : "");
  const day = Math.floor(hr / 24);
  return day + " 天" + (hr % 24 ? " " + (hr % 24) + " 小时" : "");
}

/** Compact live timer: 8s · 1:05 · 1:02:03. */
function formatElapsed(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return sec + "s";
  const s = String(sec % 60).padStart(2, "0");
  const min = Math.floor(sec / 60);
  if (min < 60) return min + ":" + s;
  return Math.floor(min / 60) + ":" + String(min % 60).padStart(2, "0") + ":" + s;
}

function formatRelativeTime(dateStr) {
  if (!dateStr) return "";
  const then = new Date(dateStr).getTime();
  const min = Math.floor((Date.now() - then) / 60000);
  if (!Number.isFinite(min)) return "";
  if (min < 1) return "刚刚";
  if (min < 60) return min + " 分钟前";
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + " 小时前";
  const day = Math.floor(hr / 24);
  if (day < 7) return day + " 天前";
  const d = new Date(then);
  return (d.getMonth() + 1) + "月" + d.getDate() + "日";
}

function formatNumber(n) {
  return Number(n || 0).toLocaleString("zh-CN");
}

function lastPathSegment(p) {
  return (p || "").split(/[\\/]/).filter(Boolean).pop() || "";
}
