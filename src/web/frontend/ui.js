/**
 * Shared helpers for the console scripts: DOM building, icons, the JSON API,
 * toasts, the confirm dialog and formatting. Loaded first; every other script
 * may use these globals.
 */

// Interface copy for the configured language, filled in by the server (src/i18n).
const MESSAGES = {};

/** `t("web.key", { n: 3 })` — `{n}` placeholders are filled; a missing key shows the key. */
function t(key, vars) {
  const template = Object.prototype.hasOwnProperty.call(MESSAGES, key) ? MESSAGES[key] : key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}

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
    throw new Error(t("web.unreachable"));
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      if (res.ok) throw new Error(t("web.badResponse", { status: res.status }));
    }
  }
  if (!res.ok) {
    const err = new Error(res.status === 401
      ? t("web.expired")
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
function confirmDialog({ title, description, confirmLabel = t("web.confirm") }) {
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
    showToast(t("web.copyFailed", { error: err && err.message ? err.message : t("web.clipboardDenied") }), "error");
    return;
  }
  const label = button.querySelector("span");
  button.classList.add("copied");
  if (label) label.textContent = t("web.copied");
  setTimeout(() => {
    button.classList.remove("copied");
    if (label) label.textContent = t("web.copy");
  }, 1500);
}

// ---------- Formatting ----------

/** 45s · 12m 5s · 3h 20m · 2d 4h (in the page language) — units carry over, never "26717m". */
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const sec = Math.round(ms / 1000);
  const part = (key, n) => t(key, { n });
  if (sec < 1) return t("web.lessThanSecond");
  if (sec < 60) return part("web.seconds", sec);
  const min = Math.floor(sec / 60);
  if (min < 60) return part("web.minutes", min) + (sec % 60 ? " " + part("web.seconds", sec % 60) : "");
  const hr = Math.floor(min / 60);
  if (hr < 24) return part("web.hours", hr) + (min % 60 ? " " + part("web.minutes", min % 60) : "");
  const day = Math.floor(hr / 24);
  return part("web.days", day) + (hr % 24 ? " " + part("web.hours", hr % 24) : "");
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
  if (min < 1) return t("web.justNow");
  if (min < 60) return t("web.minutesAgo", { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t("web.hoursAgo", { n: hr });
  const day = Math.floor(hr / 24);
  if (day < 7) return t("web.daysAgo", { n: day });
  const d = new Date(then);
  return t("web.monthDay", { month: d.getMonth() + 1, day: d.getDate() });
}

function formatNumber(n) {
  return Number(n || 0).toLocaleString("zh-CN");
}

function lastPathSegment(p) {
  return (p || "").split(/[\\/]/).filter(Boolean).pop() || "";
}
