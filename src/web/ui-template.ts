/**
 * XioCode Web Console - Modern Minimalist Warm Light UI.
 * Inspired by Claude.ai, Notion, and Linear Light.
 * Features warm paper off-white backgrounds, deep charcoal typography, and refined clean aesthetics.
 */

export function renderWebUiHtml(options: { version: string; defaultSessionId?: string }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>XioCode Web</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-base: #fbfbfa;
      --bg-sidebar: #f1f1ef;
      --bg-surface: #ffffff;
      --bg-surface-elevated: #ffffff;
      --bg-surface-hover: #ebebe9;
      
      --border-subtle: #e5e5e3;
      --border-medium: #d4d4d0;
      --border-focus: #1a1a18;
      
      --text-primary: #1a1a18;
      --text-secondary: #64645f;
      --text-tertiary: #93938c;
      
      --accent-primary: #1a1a18;
      --accent-status: #15803d;
      --accent-running: #2563eb;
      --accent-error: #b91c1c;
      
      --font-sans: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      --font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
      
      --radius-sm: 6px;
      --radius-md: 10px;
      --radius-lg: 14px;
      --radius-full: 9999px;
      
      --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.04);
      --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.05);
      --shadow-lg: 0 10px 25px -3px rgba(0, 0, 0, 0.06), 0 4px 6px -2px rgba(0, 0, 0, 0.03);
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: var(--font-sans);
      background-color: var(--bg-base);
      color: var(--text-primary);
      height: 100vh;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      -webkit-font-smoothing: antialiased;
    }

    /* Clean Scrollbar */
    ::-webkit-scrollbar {
      width: 5px;
      height: 5px;
    }
    ::-webkit-scrollbar-track {
      background: transparent;
    }
    ::-webkit-scrollbar-thumb {
      background: #d4d4d0;
      border-radius: var(--radius-full);
    }
    ::-webkit-scrollbar-thumb:hover {
      background: #b8b8b3;
    }

    /* Top Navigation Bar */
    header {
      height: 54px;
      background: var(--bg-sidebar);
      border-bottom: 1px solid var(--border-subtle);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 20px;
      z-index: 40;
      flex-shrink: 0;
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: 14px;
    }

    .btn-toggle-sidebar {
      background: transparent;
      border: 1px solid var(--border-subtle);
      color: var(--text-secondary);
      width: 30px;
      height: 30px;
      border-radius: var(--radius-sm);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .btn-toggle-sidebar:hover {
      background: var(--bg-surface-hover);
      color: var(--text-primary);
      border-color: var(--border-medium);
    }

    .brand-link {
      display: flex;
      align-items: center;
      gap: 8px;
      text-decoration: none;
      color: var(--text-primary);
    }

    .brand-logo-icon {
      width: 24px;
      height: 24px;
      background: #1a1a18;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .brand-logo-icon svg {
      width: 14px;
      height: 14px;
      fill: #ffffff;
    }

    .brand-name {
      font-size: 14px;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--text-primary);
    }

    .version-tag {
      font-size: 11px;
      font-family: var(--font-mono);
      color: var(--text-tertiary);
      background: rgba(0, 0, 0, 0.04);
      border: 1px solid var(--border-subtle);
      padding: 1px 6px;
      border-radius: 4px;
      font-weight: 500;
    }

    /* Tabs */
    .nav-tabs {
      display: flex;
      align-items: center;
      gap: 2px;
      background: rgba(0, 0, 0, 0.04);
      padding: 3px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-subtle);
    }

    .nav-tab-btn {
      background: transparent;
      border: none;
      color: var(--text-secondary);
      padding: 5px 14px;
      font-size: 12.5px;
      font-weight: 500;
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .nav-tab-btn:hover {
      color: var(--text-primary);
    }
    .nav-tab-btn.active {
      color: var(--text-primary);
      background: #ffffff;
      font-weight: 600;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
    }

    /* Right Controls */
    .header-right {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .permission-select {
      background: #ffffff;
      border: 1px solid var(--border-subtle);
      color: var(--text-secondary);
      padding: 5px 10px;
      border-radius: var(--radius-sm);
      font-size: 12px;
      font-weight: 500;
      outline: none;
      cursor: pointer;
      box-shadow: var(--shadow-sm);
      transition: border-color 0.15s ease;
    }
    .permission-select:hover {
      border-color: var(--border-medium);
      color: var(--text-primary);
    }

    .status-badge {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 500;
      color: var(--text-secondary);
      padding: 4px 10px;
      border-radius: var(--radius-sm);
      background: #ffffff;
      border: 1px solid var(--border-subtle);
      box-shadow: var(--shadow-sm);
    }

    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--accent-status);
    }

    .status-badge.running .status-dot {
      background: var(--accent-running);
    }

    .btn-settings-trigger {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 12px;
      border: 1px solid var(--border-subtle);
      background: #ffffff;
      border-radius: var(--radius-sm);
      font-size: 12px;
      font-weight: 500;
      color: var(--text-secondary);
      cursor: pointer;
      box-shadow: var(--shadow-sm);
      transition: all 0.15s ease;
    }
    .btn-settings-trigger:hover {
      border-color: var(--border-medium);
      color: var(--text-primary);
      background: var(--bg-surface-hover);
    }

    /* Settings Modal */
    .settings-modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(26, 26, 24, 0.4);
      backdrop-filter: blur(4px);
      z-index: 1000;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .settings-modal-overlay.open {
      opacity: 1;
      pointer-events: auto;
    }
    .settings-modal-container {
      width: 880px;
      max-width: 95vw;
      height: 640px;
      max-height: 90vh;
      background: var(--bg-surface);
      border-radius: var(--radius-lg);
      border: 1px solid var(--border-subtle);
      box-shadow: var(--shadow-lg);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      transform: scale(0.97) translateY(8px);
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .settings-modal-overlay.open .settings-modal-container {
      transform: scale(1) translateY(0);
    }

    .settings-modal-header {
      padding: 16px 22px;
      border-bottom: 1px solid var(--border-subtle);
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: var(--bg-sidebar);
    }
    .settings-header-title-group {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .settings-modal-title {
      font-size: 15px;
      font-weight: 700;
      color: var(--text-primary);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .settings-modal-desc {
      font-size: 12px;
      color: var(--text-secondary);
    }
    .btn-modal-close {
      border: none;
      background: transparent;
      color: var(--text-tertiary);
      font-size: 18px;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: var(--radius-sm);
      line-height: 1;
      transition: all 0.15s ease;
    }
    .btn-modal-close:hover {
      background: var(--bg-surface-hover);
      color: var(--text-primary);
    }

    .settings-modal-body {
      display: flex;
      flex: 1;
      overflow: hidden;
    }
    .settings-sidebar {
      width: 220px;
      background: var(--bg-sidebar);
      border-right: 1px solid var(--border-subtle);
      padding: 14px 10px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      flex-shrink: 0;
    }
    .settings-tab-link {
      padding: 9px 12px;
      border-radius: var(--radius-sm);
      border: none;
      background: transparent;
      text-align: left;
      font-size: 12.5px;
      font-weight: 500;
      color: var(--text-secondary);
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 9px;
      transition: all 0.15s ease;
    }
    .settings-tab-link:hover {
      background: var(--bg-surface-hover);
      color: var(--text-primary);
    }
    .settings-tab-link.active {
      background: #ffffff;
      color: var(--text-primary);
      font-weight: 600;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
    }

    .settings-main-pane {
      flex: 1;
      padding: 24px 28px;
      overflow-y: auto;
      background: var(--bg-surface);
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    .settings-tab-content {
      display: none;
      flex-direction: column;
      gap: 18px;
    }
    .settings-tab-content.active {
      display: flex;
    }

    .setting-group-title {
      font-size: 14px;
      font-weight: 700;
      color: var(--text-primary);
      margin-bottom: 2px;
    }
    .setting-group-desc {
      font-size: 12px;
      color: var(--text-secondary);
      margin-bottom: 12px;
      line-height: 1.4;
    }

    .form-grid-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
    }
    .form-field {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .form-field label {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .form-field input, .form-field select {
      padding: 8px 12px;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      font-family: inherit;
      font-size: 12.5px;
      background: #fafafa;
      color: var(--text-primary);
      outline: none;
      transition: all 0.15s ease;
    }
    .form-field input:focus, .form-field select:focus {
      border-color: var(--border-focus);
      background: #ffffff;
    }

    .provider-status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 11.5px;
      padding: 4px 10px;
      border-radius: var(--radius-full);
      font-weight: 500;
      background: #f0fdf4;
      color: #166534;
      border: 1px solid #bbf7d0;
    }
    .provider-status-badge.missing {
      background: #fef2f2;
      color: #991b1b;
      border-color: #fecaca;
    }

    .segmented-picker {
      display: flex;
      background: var(--bg-sidebar);
      padding: 3px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-subtle);
      gap: 2px;
    }
    .segmented-btn {
      flex: 1;
      padding: 5px 6px;
      border: none;
      background: transparent;
      font-size: 11px;
      font-weight: 500;
      color: var(--text-secondary);
      border-radius: 4px;
      cursor: pointer;
      text-align: center;
      transition: all 0.15s ease;
    }
    .segmented-btn:hover {
      color: var(--text-primary);
    }
    .segmented-btn.active {
      background: #ffffff;
      color: var(--text-primary);
      font-weight: 600;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
    }

    /* Plugin Grid */
    .plugin-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 10px;
    }
    .plugin-card {
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: 12px;
      background: #fafafa;
      display: flex;
      flex-direction: column;
      gap: 6px;
      transition: all 0.15s ease;
    }
    .plugin-card:hover {
      border-color: var(--border-medium);
      background: #ffffff;
    }
    .plugin-card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .plugin-name {
      font-size: 12.5px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .plugin-tag {
      font-size: 10px;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 4px;
      background: #eef2ff;
      color: #3730a3;
    }
    .plugin-desc {
      font-size: 11px;
      color: var(--text-secondary);
      line-height: 1.4;
    }

    /* Permission mode cards */
    .perm-cards-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
    }
    .perm-card {
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: 14px;
      background: #fafafa;
      cursor: pointer;
      transition: all 0.15s ease;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .perm-card:hover {
      border-color: var(--border-medium);
    }
    .perm-card.active {
      border-color: var(--accent-primary);
      background: #ffffff;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
    }
    .perm-card-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .perm-card-desc {
      font-size: 11.5px;
      color: var(--text-secondary);
      line-height: 1.4;
    }

    /* Rules editor */
    .rules-box-wrap {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .rules-editor-textarea {
      width: 100%;
      height: 280px;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      font-family: var(--font-mono);
      font-size: 12px;
      line-height: 1.5;
      padding: 12px;
      background: #fdfdfc;
      color: var(--text-primary);
      resize: vertical;
      outline: none;
    }
    .rules-editor-textarea:focus {
      border-color: var(--border-focus);
    }

    .settings-modal-footer {
      padding: 12px 22px;
      border-top: 1px solid var(--border-subtle);
      background: var(--bg-sidebar);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .config-path-hint {
      font-size: 11px;
      color: var(--text-tertiary);
      font-family: var(--font-mono);
    }
    .footer-actions {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .btn-save-settings {
      padding: 6px 16px;
      border: none;
      background: var(--accent-primary);
      color: #ffffff;
      border-radius: var(--radius-sm);
      font-size: 12.5px;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.15s ease;
    }
    .btn-save-settings:hover {
      opacity: 0.9;
    }
    .btn-cancel-settings {
      padding: 6px 14px;
      border: 1px solid var(--border-subtle);
      background: #ffffff;
      color: var(--text-secondary);
      border-radius: var(--radius-sm);
      font-size: 12.5px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .btn-cancel-settings:hover {
      background: var(--bg-surface-hover);
      color: var(--text-primary);
    }

    /* Toast */
    .toast-container {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 2000;
      display: flex;
      flex-direction: column;
      gap: 8px;
      pointer-events: none;
    }
    .toast {
      padding: 10px 16px;
      border-radius: var(--radius-sm);
      background: #1a1a18;
      color: #ffffff;
      font-size: 12.5px;
      font-weight: 500;
      box-shadow: var(--shadow-lg);
      transform: translateY(16px);
      opacity: 0;
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      pointer-events: auto;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .toast.show {
      transform: translateY(0);
      opacity: 1;
    }
    .toast.success {
      border-left: 3px solid #22c55e;
    }
    .toast.error {
      border-left: 3px solid #ef4444;
    }

    /* App Layout */
    .app-layout {
      display: flex;
      flex: 1;
      overflow: hidden;
      position: relative;
    }

    /* Sidebar */
    aside {
      width: 270px;
      background: var(--bg-sidebar);
      border-right: 1px solid var(--border-subtle);
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
      transition: width 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      z-index: 20;
    }

    aside.collapsed {
      width: 0;
      overflow: hidden;
      border-right: none;
    }

    .sidebar-header {
      padding: 14px 12px 10px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      border-bottom: 1px solid var(--border-subtle);
    }

    .btn-new-session {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      width: 100%;
      padding: 8px 12px;
      background: #1a1a18;
      color: #ffffff;
      border: none;
      border-radius: var(--radius-sm);
      font-size: 12.5px;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
      transition: background 0.15s ease;
    }
    .btn-new-session:hover {
      background: #2e2e2a;
    }

    .search-input-wrap {
      position: relative;
    }
    .search-input {
      width: 100%;
      background: #ffffff;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      padding: 6px 8px 6px 28px;
      font-size: 12px;
      color: var(--text-primary);
      outline: none;
      box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.02);
      transition: border-color 0.15s ease;
    }
    .search-input:focus {
      border-color: var(--border-focus);
    }
    .search-icon {
      position: absolute;
      left: 9px;
      top: 8px;
      width: 12px;
      height: 12px;
      fill: var(--text-tertiary);
    }

    .session-list-container {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .session-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 10px;
      border-radius: var(--radius-sm);
      background: transparent;
      cursor: pointer;
      transition: all 0.12s ease;
    }
    .session-item:hover {
      background: var(--bg-surface-hover);
    }
    .session-item.active {
      background: #ffffff;
      box-shadow: var(--shadow-sm);
    }

    .session-title {
      font-size: 12.5px;
      font-weight: 500;
      color: var(--text-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1;
    }
    .session-item.active .session-title {
      color: var(--text-primary);
      font-weight: 600;
    }

    .btn-delete-session {
      opacity: 0;
      background: transparent;
      border: none;
      color: var(--text-tertiary);
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 3px;
      font-size: 11px;
    }
    .session-item:hover .btn-delete-session {
      opacity: 1;
    }
    .btn-delete-session:hover {
      color: var(--accent-error);
    }

    .sidebar-footer {
      padding: 10px 14px;
      border-top: 1px solid var(--border-subtle);
      font-size: 11.5px;
      color: var(--text-tertiary);
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: rgba(0, 0, 0, 0.01);
    }

    /* Main Area */
    main {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      position: relative;
      background: var(--bg-base);
    }

    .view-panel {
      display: none;
      flex: 1;
      flex-direction: column;
      overflow: hidden;
      height: 100%;
    }
    .view-panel.active {
      display: flex;
    }

    /* Chat View */
    .chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 28px 20px;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    .chat-inner-wrap {
      max-width: 780px;
      width: 100%;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 22px;
    }

    /* Clean Hero Welcome */
    .hero-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 50px 16px 20px;
      text-align: center;
      gap: 24px;
    }

    .hero-title {
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--text-primary);
    }

    .hero-subtitle {
      font-size: 13.5px;
      color: var(--text-secondary);
      max-width: 500px;
      line-height: 1.55;
    }

    .starter-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
      width: 100%;
      max-width: 640px;
    }

    .starter-item {
      background: #ffffff;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: 14px 16px;
      text-align: left;
      cursor: pointer;
      box-shadow: var(--shadow-sm);
      transition: all 0.15s ease;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .starter-item:hover {
      border-color: var(--border-medium);
      box-shadow: var(--shadow-md);
      transform: translateY(-1px);
    }
    .starter-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .starter-desc {
      font-size: 12px;
      color: var(--text-secondary);
      line-height: 1.4;
    }

    /* Message Bubbles */
    .msg-user-container {
      display: flex;
      justify-content: flex-end;
      width: 100%;
    }

    .msg-user-card {
      background: #f1f1ef;
      border: 1px solid var(--border-subtle);
      color: var(--text-primary);
      padding: 12px 18px;
      border-radius: 16px 16px 4px 16px;
      max-width: 82%;
      font-size: 14px;
      line-height: 1.6;
      box-shadow: var(--shadow-sm);
    }

    .msg-assistant-container {
      display: flex;
      flex-direction: column;
      gap: 14px;
      width: 100%;
    }

    /* Thought Drawer */
    .thought-drawer {
      background: #f5f5f3;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      overflow: hidden;
      font-size: 12.5px;
    }

    .thought-drawer-header {
      padding: 8px 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: pointer;
      color: var(--text-secondary);
      user-select: none;
      background: rgba(0, 0, 0, 0.02);
      font-weight: 500;
    }
    .thought-drawer-header:hover {
      color: var(--text-primary);
    }

    .thought-drawer-body {
      padding: 12px 14px;
      color: #52524e;
      line-height: 1.6;
      border-top: 1px solid var(--border-subtle);
      white-space: pre-wrap;
      max-height: 320px;
      overflow-y: auto;
      font-size: 12.5px;
      background: #fafaf8;
    }

    .thought-drawer.collapsed .thought-drawer-body {
      display: none;
    }

    /* Tool Call Card */
    .tool-box {
      background: #ffffff;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      overflow: hidden;
      font-size: 12px;
      font-family: var(--font-mono);
      box-shadow: var(--shadow-sm);
    }

    .tool-box-header {
      padding: 8px 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: #f8f8f6;
      border-bottom: 1px solid var(--border-subtle);
      cursor: pointer;
    }

    .tool-name-tag {
      color: var(--text-primary);
      font-weight: 600;
    }

    .tool-status-pill {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      padding: 2px 7px;
      border-radius: 4px;
      background: #f1f1ef;
      color: var(--text-secondary);
    }
    .tool-status-pill.done { color: var(--accent-status); background: #dcfce7; }
    .tool-status-pill.error { color: var(--accent-error); background: #fee2e2; }

    .tool-box-body {
      padding: 10px 12px;
      background: #fdfdfc;
      color: #4b5563;
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 260px;
      overflow-y: auto;
      border-top: 1px solid rgba(0, 0, 0, 0.03);
    }
    .tool-box.collapsed .tool-box-body {
      display: none;
    }

    /* Markdown Text */
    .prose {
      font-size: 14px;
      line-height: 1.75;
      color: var(--text-primary);
    }
    .prose p { margin-bottom: 12px; }
    .prose p:last-child { margin-bottom: 0; }
    .prose code {
      font-family: var(--font-mono);
      background: #f1f1ef;
      border: 1px solid var(--border-subtle);
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 12.5px;
      color: #1a1a18;
    }
    .prose pre {
      background: #f8f8f6;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      padding: 14px;
      overflow-x: auto;
      margin: 12px 0;
    }
    .prose pre code {
      background: transparent;
      border: none;
      padding: 0;
      color: #1a1a18;
    }

    /* Composer */
    .composer-section {
      padding: 14px 20px 20px;
      display: flex;
      justify-content: center;
      background: var(--bg-base);
    }

    .composer-card {
      max-width: 780px;
      width: 100%;
      background: #ffffff;
      border: 1px solid var(--border-medium);
      border-radius: var(--radius-lg);
      padding: 12px 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      box-shadow: var(--shadow-md);
      transition: all 0.15s ease;
    }
    .composer-card:focus-within {
      border-color: var(--border-focus);
      box-shadow: var(--shadow-lg);
    }

    .composer-input {
      background: transparent;
      border: none;
      outline: none;
      color: var(--text-primary);
      font-family: var(--font-sans);
      font-size: 14px;
      line-height: 1.55;
      resize: none;
      min-height: 48px;
      max-height: 180px;
    }
    .composer-input::placeholder {
      color: var(--text-tertiary);
    }

    .composer-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-top: 8px;
      border-top: 1px solid var(--border-subtle);
    }

    .chip-list {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .filter-chip {
      background: #f8f8f6;
      border: 1px solid var(--border-subtle);
      color: var(--text-secondary);
      padding: 3px 10px;
      border-radius: var(--radius-sm);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.12s ease;
    }
    .filter-chip:hover {
      color: var(--text-primary);
      background: #f1f1ef;
      border-color: var(--border-medium);
    }

    .action-group {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .key-tip {
      font-size: 11.5px;
      color: var(--text-tertiary);
      font-family: var(--font-mono);
    }

    .btn-abort {
      background: transparent;
      border: 1px solid var(--border-subtle);
      color: var(--accent-error);
      padding: 6px 14px;
      border-radius: var(--radius-sm);
      font-size: 12.5px;
      font-weight: 600;
      cursor: pointer;
      display: none;
    }

    .btn-send {
      background: #1a1a18;
      color: #ffffff;
      border: none;
      padding: 6px 16px;
      border-radius: var(--radius-sm);
      font-size: 12.5px;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
      transition: background 0.15s ease;
    }
    .btn-send:hover {
      background: #2e2e2a;
    }
    .btn-send:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    /* Views: Metrics & Diff */
    .clean-deck {
      flex: 1;
      overflow-y: auto;
      padding: 28px 20px;
      display: flex;
      flex-direction: column;
      gap: 18px;
      max-width: 860px;
      width: 100%;
      margin: 0 auto;
    }

    .metrics-row {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 14px;
    }

    .metric-box {
      background: #ffffff;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      box-shadow: var(--shadow-sm);
    }
    .metric-heading {
      font-size: 11.5px;
      font-weight: 600;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .metric-digit {
      font-size: 26px;
      font-weight: 700;
      font-family: var(--font-mono);
      color: var(--text-primary);
    }
    .metric-foot {
      font-size: 11.5px;
      color: var(--text-tertiary);
    }

    .diff-panel {
      background: #ffffff;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      overflow: hidden;
      box-shadow: var(--shadow-sm);
    }
    .diff-panel-header {
      padding: 12px 16px;
      background: #f8f8f6;
      border-bottom: 1px solid var(--border-subtle);
      font-size: 13px;
      font-weight: 600;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .diff-panel-body {
      padding: 16px;
      font-family: var(--font-mono);
      font-size: 12.5px;
      line-height: 1.65;
      white-space: pre;
      overflow-x: auto;
      background: #fdfdfc;
      color: #374151;
    }
  </style>
</head>
<body>
  <header>
    <div class="header-left">
      <button id="btn-toggle-sidebar" class="btn-toggle-sidebar" title="Toggle Sidebar">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="3" x2="9" y2="21"></line></svg>
      </button>
      <a href="#" class="brand-link">
        <div class="brand-logo-icon">
          <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
        </div>
        <span class="brand-name">XioCode Web</span>
      </a>
      <span class="version-tag">v${options.version}</span>
    </div>

    <nav class="nav-tabs">
      <button class="nav-tab-btn active" data-view="chat">Chat</button>
      <button class="nav-tab-btn" data-view="trajectory">Trajectory</button>
      <button class="nav-tab-btn" data-view="metrics">Metrics</button>
      <button class="nav-tab-btn" data-view="diff">Diff</button>
    </nav>

    <div class="header-right">
      <button id="btn-open-settings" class="btn-settings-trigger" title="设置 / Settings">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
        <span>设置</span>
      </button>

      <select id="permission-select" class="permission-select">
        <option value="auto">Permission: Auto</option>
        <option value="strict">Permission: Strict</option>
        <option value="full">Permission: Full</option>
      </select>

      <div id="status-pill" class="status-badge">
        <span class="status-dot"></span>
        <span id="status-text">Ready</span>
      </div>
    </div>
  </header>

  <div class="app-layout">
    <aside id="sidebar">
      <div class="sidebar-header">
        <button id="btn-new-session" class="btn-new-session">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          New Session
        </button>
        <div class="search-input-wrap">
          <svg class="search-icon" viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
          <input type="text" id="session-search" class="search-input" placeholder="Search sessions...">
        </div>
      </div>

      <div id="session-list" class="session-list-container">
        <!-- Sessions dynamic -->
      </div>

      <div class="sidebar-footer">
        <span id="active-workspace-chip">Workspace: local</span>
        <span id="session-count-badge">0 sessions</span>
      </div>
    </aside>

    <main>
      <!-- Chat View -->
      <section id="view-chat" class="view-panel active">
        <div id="chat-messages" class="chat-messages">
          <div class="chat-inner-wrap" id="chat-flow-container">
            <!-- Hero State -->
            <div class="hero-state" id="hero-state">
              <h1 class="hero-title">What would you like to build?</h1>
              <p class="hero-subtitle">XioCode runs as an autonomous agent in your workspace with verified safety boundaries.</p>

              <div class="starter-grid">
                <div class="starter-item" onclick="insertPrompt('Run the full test suite and verify current workspace integrity')">
                  <span class="starter-title">Run test suite</span>
                  <span class="starter-desc">Execute unit tests and regression assertions</span>
                </div>
                <div class="starter-item" onclick="insertPrompt('Inspect git diff and check for unstaged changes')">
                  <span class="starter-title">Inspect git diff</span>
                  <span class="starter-desc">Review working tree modifications</span>
                </div>
                <div class="starter-item" onclick="insertPrompt('Run xio doctor to check system health and keys')">
                  <span class="starter-title">Doctor check</span>
                  <span class="starter-desc">Verify local config, keys, and provider status</span>
                </div>
                <div class="starter-item" onclick="insertPrompt('Audit codebase performance and execution overhead')">
                  <span class="starter-title">Performance audit</span>
                  <span class="starter-desc">Check latency, token estimate, and tracer</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="composer-section">
          <div class="composer-card">
            <textarea id="composer-input" class="composer-input" placeholder="Ask XioCode to build, fix, refactor, or test..."></textarea>
            <div class="composer-bar">
              <div class="chip-list">
                <span class="filter-chip" onclick="insertPrompt('Run tests')">Tests</span>
                <span class="filter-chip" onclick="insertPrompt('Git diff')">Diff</span>
                <span class="filter-chip" onclick="insertPrompt('Doctor')">Doctor</span>
              </div>
              <div class="action-group">
                <span class="key-tip">↵ Send · ⇧↵ Line</span>
                <button id="btn-abort" class="btn-abort">Abort</button>
                <button id="btn-send" class="btn-send">Send</button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Trajectory View -->
      <section id="view-trajectory" class="view-panel">
        <div class="clean-deck">
          <div class="diff-panel">
            <div class="diff-panel-header"><span>Execution Trace</span></div>
            <div class="diff-panel-body" id="trajectory-log">No execution trace recorded yet. Start a session in the chat view.</div>
          </div>
        </div>
      </section>

      <!-- Metrics View -->
      <section id="view-metrics" class="view-panel">
        <div class="clean-deck">
          <div class="metrics-row">
            <div class="metric-box">
              <span class="metric-heading">Total Tokens</span>
              <span class="metric-digit" id="val-tokens">0</span>
              <span class="metric-foot">Prompt + Completion</span>
            </div>
            <div class="metric-box">
              <span class="metric-heading">Cache Hit</span>
              <span class="metric-digit" id="val-cache">94.2%</span>
              <span class="metric-foot">Cold-start aware</span>
            </div>
            <div class="metric-box">
              <span class="metric-heading">Est. Cost</span>
              <span class="metric-digit" id="val-cost">$0.00</span>
              <span class="metric-foot">Standard rate table</span>
            </div>
            <div class="metric-box">
              <span class="metric-heading">Tool Calls</span>
              <span class="metric-digit" id="val-turns">0</span>
              <span class="metric-foot">Executed in turn</span>
            </div>
          </div>
        </div>
      </section>

      <!-- Diff View -->
      <section id="view-diff" class="view-panel">
        <div class="clean-deck">
          <div class="diff-panel">
            <div class="diff-panel-header">
              <span>Working Tree Changes</span>
              <button class="filter-chip" onclick="fetchDiff()">Refresh</button>
            </div>
            <div class="diff-panel-body" id="diff-output-body">Loading workspace diff...</div>
          </div>
        </div>
      </section>
    </main>
  </div>

  <!-- Settings Modal (Claude Warm Paper style) -->
  <div id="settings-modal" class="settings-modal-overlay">
    <div class="settings-modal-container">
      <div class="settings-modal-header">
        <div class="settings-header-title-group">
          <div class="settings-modal-title">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
            <span>XioCode 控制台设置 (Settings)</span>
          </div>
          <span class="settings-modal-desc">管理模型供应商、思维链策略、工作区规则、扩展插件与安全护栏</span>
        </div>
        <button id="btn-close-settings" class="btn-modal-close" title="关闭 (Esc)">✕</button>
      </div>

      <div class="settings-modal-body">
        <div class="settings-sidebar">
          <button class="settings-tab-link active" data-settings-tab="models">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2 2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM4 12a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2 2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zm12 0a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2zM9 19a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2v-1z"/><circle cx="12" cy="12" r="3"/></svg>
            <span>模型与推理 (Models)</span>
          </button>
          <button class="settings-tab-link" data-settings-tab="rules">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
            <span>规则与规范 (Rules)</span>
          </button>
          <button class="settings-tab-link" data-settings-tab="plugins">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>
            <span>插件与扩展 (Plugins)</span>
          </button>
          <button class="settings-tab-link" data-settings-tab="safety">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
            <span>安全与权限 (Safety)</span>
          </button>
        </div>

        <div class="settings-main-pane">
          <!-- Tab 1: Models & Inference -->
          <div id="settings-pane-models" class="settings-tab-content active">
            <div>
              <h3 class="setting-group-title">模型供应商与推理引擎</h3>
              <p class="setting-group-desc">配置默认 Provider、模型标识、思维链深度 (Thinking Ladder) 与 Token 压缩预算。</p>
            </div>

            <div class="form-grid-2">
              <div class="form-field">
                <label for="setting-provider-select">默认 Provider</label>
                <select id="setting-provider-select">
                  <option value="deepseek">DeepSeek (默认)</option>
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic (Claude)</option>
                  <option value="ollama">Local Ollama</option>
                </select>
              </div>

              <div class="form-field">
                <label for="setting-model-input">默认模型名称 (Model ID)</label>
                <input type="text" id="setting-model-input" placeholder="deepseek-chat">
              </div>
            </div>

            <div class="form-field">
              <label>思维链深度梯度 (Thinking Level Ladder)</label>
              <div class="segmented-picker" id="setting-thinking-picker">
                <button type="button" class="segmented-btn" data-level="off">Off</button>
                <button type="button" class="segmented-btn" data-level="minimal">Minimal</button>
                <button type="button" class="segmented-btn" data-level="low">Low</button>
                <button type="button" class="segmented-btn" data-level="medium">Medium</button>
                <button type="button" class="segmented-btn active" data-level="high">High</button>
                <button type="button" class="segmented-btn" data-level="max">Max</button>
                <button type="button" class="segmented-btn" data-level="ultra">Ultra</button>
              </div>
            </div>

            <div class="form-grid-2">
              <div class="form-field">
                <label for="setting-max-turns">单轮最大 Turn 限制 (Max Turns, 1–40)</label>
                <input type="number" id="setting-max-turns" min="1" max="40" value="24">
              </div>

              <div class="form-field">
                <label for="setting-max-tokens">上下文压缩阈值 (Token Budget)</label>
                <input type="number" id="setting-max-tokens" min="1024" step="1024" value="48000">
              </div>
            </div>

            <div class="form-field">
              <label>API Key 凭据检测与更新 (安全加密存储)</label>
              <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 6px;">
                <span id="provider-key-status" class="provider-status-badge">
                  <span class="status-dot"></span>
                  <span id="provider-key-status-text">检测中...</span>
                </span>
                <span style="font-size: 11.5px; color: var(--text-tertiary);" id="provider-key-env-name">DEEPSEEK_API_KEY</span>
              </div>
              <input type="password" id="setting-api-key-input" placeholder="输入新的 API Key（留空则保持现有凭据不变）">
            </div>
          </div>

          <!-- Tab 2: Rules & Prompts -->
          <div id="settings-pane-rules" class="settings-tab-content">
            <div>
              <h3 class="setting-group-title">工作区规则与系统规范 (Rules & Directives)</h3>
              <p class="setting-group-desc">定义 Agent 在当前工作区内的改码纪律、执行守卫与禁止项（映射本地 <code>AGENTS.md</code>）。</p>
            </div>

            <div style="display: flex; gap: 8px; flex-wrap: wrap;">
              <span class="filter-chip" onclick="appendRulePreset('Surgical')">+ Surgical Diff 最小改动规范</span>
              <span class="filter-chip" onclick="appendRulePreset('TestFirst')">+ Test-First 严格测试验证</span>
              <span class="filter-chip" onclick="appendRulePreset('Security')">+ A3 零凭证硬编码安全基线</span>
            </div>

            <div class="rules-box-wrap">
              <div style="display: flex; align-items: center; justify-content: space-between;">
                <span style="font-size: 12px; font-weight: 600; color: var(--text-secondary);" id="rules-file-indicator">AGENTS.md</span>
                <button type="button" class="filter-chip" onclick="loadRules(true)">重载本地文件</button>
              </div>
              <textarea id="setting-rules-editor" class="rules-editor-textarea" placeholder="# 工作区 Agent 规则定义..."></textarea>
            </div>
          </div>

          <!-- Tab 3: Plugins & Extensions -->
          <div id="settings-pane-plugins" class="settings-tab-content">
            <div>
              <h3 class="setting-group-title">微内核扩展与插件中心 (Plugins & MCP)</h3>
              <p class="setting-group-desc">参考 deepseek-harness 插件生态：管理 XioCode 7 大内置扩展与外部 Model Context Protocol 服务。</p>
            </div>

            <div class="plugin-grid" id="plugins-container">
              <!-- Dynamically populated -->
            </div>
          </div>

          <!-- Tab 4: Safety & Permissions -->
          <div id="settings-pane-safety" class="settings-tab-content">
            <div>
              <h3 class="setting-group-title">安全门禁与权限模式 (Safety & Permissions)</h3>
              <p class="setting-group-desc">控制 Agent 在工作区内修改文件、执行 Shell 与调用危险命令的审批级别。</p>
            </div>

            <div class="perm-cards-grid">
              <div class="perm-card active" data-perm-mode="auto" onclick="selectPermCard('auto')">
                <div class="perm-card-title">
                  <span style="color: #15803d;">●</span> Workspace-Only (推荐)
                </div>
                <div class="perm-card-desc">自动放行工作区内安全读写与常规单测；高危命令 (rm/reset/push) 需确认。</div>
              </div>

              <div class="perm-card" data-perm-mode="strict" onclick="selectPermCard('strict')">
                <div class="perm-card-title">
                  <span style="color: #ca8a04;">●</span> Strict / Ask-Always
                </div>
                <div class="perm-card-desc">任何文件写入修改、Shell 命令与外部调用均须在控制台手动审批。</div>
              </div>

              <div class="perm-card" data-perm-mode="full" onclick="selectPermCard('full')">
                <div class="perm-card-title">
                  <span style="color: #dc2626;">●</span> Full-Auto (沙箱模式)
                </div>
                <div class="perm-card-desc">全自主执行无需干预；推荐仅在 Git Worktree 或 Docker 沙箱中启用。</div>
              </div>
            </div>

            <div class="form-grid-2">
              <div class="form-field">
                <label for="setting-repeat-tool-limit">工具连续重复调用熔断上限 (Repeat Limit)</label>
                <input type="number" id="setting-repeat-tool-limit" min="0" max="20" value="3">
              </div>

              <div class="form-field">
                <label>高危操作拦截名单 (Blocked High-Risk)</label>
                <div style="display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px;">
                  <span class="extension-tag" style="background:#fee2e2; color:#991b1b;">rm -rf</span>
                  <span class="extension-tag" style="background:#fee2e2; color:#991b1b;">git reset --hard</span>
                  <span class="extension-tag" style="background:#fee2e2; color:#991b1b;">git push --force</span>
                  <span class="extension-tag" style="background:#fee2e2; color:#991b1b;">drop database</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="settings-modal-footer">
        <span class="config-path-hint" id="setting-config-path">~/.xiocode/config.toml</span>
        <div class="footer-actions">
          <button type="button" class="btn-cancel-settings" id="btn-cancel-settings">取消</button>
          <button type="button" class="btn-save-settings" id="btn-save-settings">保存配置</button>
        </div>
      </div>
    </div>
  </div>

  <div id="toast-container" class="toast-container"></div>

  <script>
    let activeSessionId = "${options.defaultSessionId || ''}";
    let isRunning = false;
    let eventSource = null;
    let allSessions = [];
    let metricsState = { turns: 0, tokens: 0 };
    let currentSettingsData = null;
    let selectedThinkingLevel = "high";
    let selectedPermMode = "auto";

    const chatFlowContainer = document.getElementById("chat-flow-container");
    const chatScrollArea = document.getElementById("chat-messages");
    const composerInput = document.getElementById("composer-input");
    const btnSend = document.getElementById("btn-send");
    const btnAbort = document.getElementById("btn-abort");
    const statusPill = document.getElementById("status-pill");
    const statusText = document.getElementById("status-text");
    const sessionList = document.getElementById("session-list");
    const btnNewSession = document.getElementById("btn-new-session");
    const btnToggleSidebar = document.getElementById("btn-toggle-sidebar");
    const sidebar = document.getElementById("sidebar");
    const sessionSearch = document.getElementById("session-search");

    document.addEventListener("DOMContentLoaded", async () => {
      initTabs();
      initSidebar();
      initComposer();
      initSettingsModal();
      await fetchStatus();
      await loadSessions();
      if (activeSessionId) {
        selectSession(activeSessionId);
      }
    });

    function initTabs() {
      document.querySelectorAll(".nav-tab-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          document.querySelectorAll(".nav-tab-btn").forEach(b => b.classList.remove("active"));
          document.querySelectorAll(".view-panel").forEach(v => v.classList.remove("active"));
          btn.classList.add("active");
          const viewId = "view-" + btn.dataset.view;
          const target = document.getElementById(viewId);
          if (target) target.classList.add("active");
          if (btn.dataset.view === "diff") fetchDiff();
        });
      });
    }

    function initSidebar() {
      btnToggleSidebar.addEventListener("click", () => {
        sidebar.classList.toggle("collapsed");
      });
      sessionSearch.addEventListener("input", (e) => {
        renderSessionList(e.target.value.trim().toLowerCase());
      });
    }

    function initComposer() {
      composerInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          handleSend();
        }
      });
      btnSend.addEventListener("click", handleSend);
      btnAbort.addEventListener("click", handleAbort);
      btnNewSession.addEventListener("click", handleNewSession);
    }

    function initSettingsModal() {
      const btnOpen = document.getElementById("btn-open-settings");
      const btnClose = document.getElementById("btn-close-settings");
      const btnCancel = document.getElementById("btn-cancel-settings");
      const btnSave = document.getElementById("btn-save-settings");
      const modal = document.getElementById("settings-modal");

      btnOpen.addEventListener("click", openSettingsModal);
      btnClose.addEventListener("click", closeSettingsModal);
      btnCancel.addEventListener("click", closeSettingsModal);
      btnSave.addEventListener("click", saveSettings);

      modal.addEventListener("click", (e) => {
        if (e.target === modal) closeSettingsModal();
      });

      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && modal.classList.contains("open")) {
          closeSettingsModal();
        }
      });

      // Settings tab switching
      document.querySelectorAll(".settings-tab-link").forEach(btn => {
        btn.addEventListener("click", () => {
          document.querySelectorAll(".settings-tab-link").forEach(b => b.classList.remove("active"));
          document.querySelectorAll(".settings-tab-content").forEach(c => c.classList.remove("active"));
          btn.classList.add("active");
          const tabId = "settings-pane-" + btn.dataset.settingsTab;
          const pane = document.getElementById(tabId);
          if (pane) pane.classList.add("active");
        });
      });

      // Thinking level buttons
      document.querySelectorAll("#setting-thinking-picker .segmented-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          document.querySelectorAll("#setting-thinking-picker .segmented-btn").forEach(b => b.classList.remove("active"));
          btn.classList.add("active");
          selectedThinkingLevel = btn.dataset.level;
        });
      });

      // Provider change listener
      const provSelect = document.getElementById("setting-provider-select");
      provSelect.addEventListener("change", () => {
        const val = provSelect.value;
        const modelInput = document.getElementById("setting-model-input");
        const envName = document.getElementById("provider-key-env-name");
        if (val === "deepseek") {
          modelInput.placeholder = "deepseek-chat";
          envName.textContent = "DEEPSEEK_API_KEY";
        } else if (val === "openai") {
          modelInput.placeholder = "gpt-4.1";
          envName.textContent = "OPENAI_API_KEY";
        } else if (val === "anthropic") {
          modelInput.placeholder = "claude-3-7-sonnet";
          envName.textContent = "ANTHROPIC_API_KEY";
        } else if (val === "ollama") {
          modelInput.placeholder = "llama3:8b";
          envName.textContent = "OLLAMA_HOST (Optional)";
        }
        updateKeyStatusBadge(val);
      });

      // Permission selector sync
      const permSelect = document.getElementById("permission-select");
      permSelect.addEventListener("change", () => {
        selectPermCard(permSelect.value);
      });
    }

    async function openSettingsModal() {
      const modal = document.getElementById("settings-modal");
      modal.classList.add("open");
      await loadSettings();
      await loadRules();
      await loadExtensions();
    }

    function closeSettingsModal() {
      const modal = document.getElementById("settings-modal");
      modal.classList.remove("open");
    }

    function selectPermCard(mode) {
      selectedPermMode = mode;
      document.querySelectorAll(".perm-card").forEach(card => {
        card.classList.toggle("active", card.dataset.permMode === mode);
      });
      const permSelect = document.getElementById("permission-select");
      if (permSelect) permSelect.value = mode;
    }

    function updateKeyStatusBadge(providerName) {
      if (!currentSettingsData || !currentSettingsData.providers) return;
      const match = currentSettingsData.providers.find(p => p.name === providerName);
      const statusBadge = document.getElementById("provider-key-status");
      const statusText = document.getElementById("provider-key-status-text");
      if (match && match.hasKey) {
        statusBadge.className = "provider-status-badge";
        statusText.textContent = "已就绪 (检测到凭据)";
      } else {
        statusBadge.className = "provider-status-badge missing";
        statusText.textContent = "未检测到环境变量 / 密钥";
      }
    }

    async function loadSettings() {
      try {
        const res = await fetch("/api/settings");
        if (!res.json) return;
        const data = await res.json();
        currentSettingsData = data;

        if (data.configPath) {
          document.getElementById("setting-config-path").textContent = data.configPath;
        }

        if (data.general) {
          const provSelect = document.getElementById("setting-provider-select");
          if (data.general.defaultProvider) {
            provSelect.value = data.general.defaultProvider;
          }
          if (data.general.defaultModel) {
            document.getElementById("setting-model-input").value = data.general.defaultModel;
          }
          if (data.general.maxTurns) {
            document.getElementById("setting-max-turns").value = data.general.maxTurns;
          }
          if (data.general.maxSessionTokens) {
            document.getElementById("setting-max-tokens").value = data.general.maxSessionTokens;
          }
          if (data.general.repeatToolLimit !== undefined) {
            document.getElementById("setting-repeat-tool-limit").value = data.general.repeatToolLimit;
          }
          if (data.general.defaultThinkingLevel) {
            selectedThinkingLevel = data.general.defaultThinkingLevel;
            document.querySelectorAll("#setting-thinking-picker .segmented-btn").forEach(b => {
              b.classList.toggle("active", b.dataset.level === selectedThinkingLevel);
            });
          }
        }

        updateKeyStatusBadge(document.getElementById("setting-provider-select").value);
      } catch (err) {
        console.error("loadSettings error", err);
      }
    }

    async function loadRules(force = false) {
      try {
        const res = await fetch("/api/rules");
        const data = await res.json();
        const editor = document.getElementById("setting-rules-editor");
        if (editor) {
          editor.value = data.content || "";
          document.getElementById("rules-file-indicator").textContent = (data.filename || "AGENTS.md") + (data.exists ? " (本地已加载)" : " (新建)");
        }
        if (force) showToast("已重新读取工作区规则文件", "success");
      } catch (err) {
        console.error("loadRules error", err);
      }
    }

    async function loadExtensions() {
      try {
        const res = await fetch("/api/extensions");
        const data = await res.json();
        const container = document.getElementById("plugins-container");
        if (!container || !data.extensions) return;

        container.innerHTML = data.extensions.map(ext => \`
          <div class="plugin-card">
            <div class="plugin-card-header">
              <span class="plugin-name">\${escapeHtml(ext.name)}</span>
              <span class="plugin-tag">\${escapeHtml(ext.category || 'plugin')}</span>
            </div>
            <p class="plugin-desc">\${escapeHtml(ext.description)}</p>
          </div>
        \`).join("");
      } catch (err) {
        console.error("loadExtensions error", err);
      }
    }

    function appendRulePreset(type) {
      const editor = document.getElementById("setting-rules-editor");
      let snippet = "";
      if (type === "Surgical") {
        snippet = "\\n## Surgical Diff 最小修改原则\\n- 只改动实现意图所必需的文件与代码行。\\n- 严禁无关格式化、顺手重构或清理已有代码。\\n";
      } else if (type === "TestFirst") {
        snippet = "\\n## Test-First 严格测试交付\\n- 交付前须执行并通过受影响模块的单元测试。\\n- 输出中必须附带明确的测试执行状态证据。\\n";
      } else if (type === "Security") {
        snippet = "\\n## A3 凭据安全基线\\n- 源码与日志中绝不硬编码任何 API Key 或敏感凭据。\\n- 数据库与命令调用一律强制参数化。\\n";
      }
      editor.value = (editor.value.trim() + snippet).trim() + "\\n";
      showToast("已插入规则预设模板", "success");
    }

    async function saveSettings() {
      const btnSave = document.getElementById("btn-save-settings");
      btnSave.textContent = "保存中...";
      btnSave.disabled = true;

      try {
        const providerName = document.getElementById("setting-provider-select").value;
        const modelName = document.getElementById("setting-model-input").value.trim();
        const maxTurns = parseInt(document.getElementById("setting-max-turns").value, 10) || 24;
        const maxTokens = parseInt(document.getElementById("setting-max-tokens").value, 10) || 48000;
        const repeatLimit = parseInt(document.getElementById("setting-repeat-tool-limit").value, 10) || 3;
        const apiKey = document.getElementById("setting-api-key-input").value.trim();
        const rulesContent = document.getElementById("setting-rules-editor").value;

        // 1. Save general settings & provider
        const payload = {
          general: {
            defaultProvider: providerName,
            ...(modelName ? { defaultModel: modelName } : {}),
            defaultThinkingLevel: selectedThinkingLevel,
            maxTurns,
            maxSessionTokens: maxTokens,
            repeatToolLimit: repeatLimit,
          },
          provider: {
            name: providerName,
            ...(modelName ? { model: modelName } : {}),
            ...(apiKey ? { apiKey } : {}),
          },
          permissions: {
            allowHighRisk: selectedPermMode === "full",
          },
        };

        const res1 = await fetch("/api/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        // 2. Save rules content
        const res2 = await fetch("/api/rules", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: rulesContent }),
        });

        if (res1.ok && res2.ok) {
          showToast("配置与规则已成功保存生效！", "success");
          document.getElementById("setting-api-key-input").value = "";
          closeSettingsModal();
        } else {
          showToast("保存失败，请检查控制台输出", "error");
        }
      } catch (err) {
        showToast("保存异常: " + err.message, "error");
      } finally {
        btnSave.textContent = "保存配置";
        btnSave.disabled = false;
      }
    }

    function showToast(message, type = "success") {
      const container = document.getElementById("toast-container");
      const toast = document.createElement("div");
      toast.className = "toast " + type;
      toast.innerHTML = (type === "success" ? "✓ " : "✕ ") + escapeHtml(message);
      container.appendChild(toast);

      requestAnimationFrame(() => {
        toast.classList.add("show");
      });

      setTimeout(() => {
        toast.classList.remove("show");
        setTimeout(() => toast.remove(), 300);
      }, 3000);
    }

    function insertPrompt(text) {
      composerInput.value = text;
      composerInput.focus();
    }

    async function fetchStatus() {
      try {
        const res = await fetch("/api/status");
        const data = await res.json();
        const wsName = data.cwd ? data.cwd.split("/").pop() : "Workspace";
        document.getElementById("active-workspace-chip").textContent = "Workspace: " + wsName;
      } catch (err) {
        console.error("fetchStatus err", err);
      }
    }

    async function loadSessions() {
      try {
        const res = await fetch("/api/sessions");
        allSessions = await res.json();
        document.getElementById("session-count-badge").textContent = allSessions.length + " sessions";
        renderSessionList();
      } catch (err) {
        console.error("loadSessions err", err);
      }
    }

    function formatSessionTitle(sess, index) {
      if (sess.first_prompt) return sess.first_prompt.slice(0, 30);
      if (sess.metadata && sess.metadata.id) {
        return "Session " + sess.metadata.id.slice(0, 8);
      }
      return "Session #" + (index + 1);
    }

    function renderSessionList(query = "") {
      sessionList.innerHTML = "";
      const filtered = query
        ? allSessions.filter(s => {
            const title = formatSessionTitle(s, 0).toLowerCase();
            const id = (s.metadata?.id || "").toLowerCase();
            return title.includes(query) || id.includes(query);
          })
        : allSessions;

      if (filtered.length === 0) {
        sessionList.innerHTML = \`<div class="empty-state-list">No sessions found</div>\`;
        return;
      }

      filtered.forEach((sess, idx) => {
        const id = sess.metadata?.id || sess.id;
        const item = document.createElement("div");
        item.className = "session-item" + (id === activeSessionId ? " active" : "");
        item.innerHTML = \`
          <div class="session-item-text">
            <span class="session-title">\${escapeHtml(formatSessionTitle(sess, idx))}</span>
            <span class="session-time">\${id.slice(0, 8)}</span>
          </div>
          <button class="session-del-btn" title="Delete Session" onclick="event.stopPropagation(); deleteSession('\${id}')">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
          </button>
        \`;
        item.addEventListener("click", () => selectSession(id));
        sessionList.appendChild(item);
      });
    }

    async function handleNewSession() {
      try {
        const res = await fetch("/api/sessions", { method: "POST" });
        const data = await res.json();
        await loadSessions();
        selectSession(data.id);
      } catch (err) {
        console.error("handleNewSession err", err);
      }
    }

    async function deleteSession(id) {
      if (!confirm("Are you sure you want to delete this session?")) return;
      try {
        await fetch("/api/sessions/" + id, { method: "DELETE" });
        if (activeSessionId === id) {
          activeSessionId = "";
          clearChat();
        }
        await loadSessions();
      } catch (err) {
        console.error("deleteSession err", err);
      }
    }

    function selectSession(id) {
      activeSessionId = id;
      document.querySelectorAll(".session-item").forEach(el => el.classList.remove("active"));
      renderSessionList();
      connectSse(id);
      loadSessionDetail(id);
    }

    async function loadSessionDetail(id) {
      try {
        const res = await fetch("/api/sessions/" + id);
        if (!res.ok) return;
        const detail = await res.json();
        renderMessages(detail.messages || []);
      } catch (err) {
        console.error("loadSessionDetail err", err);
      }
    }

    function clearChat() {
      chatFlowContainer.innerHTML = "";
    }

    function renderMessages(messages) {
      clearChat();
      if (messages.length === 0) {
        chatFlowContainer.innerHTML = \`
          <div class="hero-state" id="hero-state">
            <h1 class="hero-title">What would you like to build?</h1>
            <p class="hero-subtitle">XioCode runs as an autonomous agent in your workspace with verified safety boundaries.</p>
            <div class="starter-grid">
              <div class="starter-item" onclick="insertPrompt('Run the full test suite and verify current workspace integrity')">
                <span class="starter-title">Run test suite</span>
                <span class="starter-desc">Execute unit tests and regression assertions</span>
              </div>
              <div class="starter-item" onclick="insertPrompt('Inspect git diff and check for unstaged changes')">
                <span class="starter-title">Inspect git diff</span>
                <span class="starter-desc">Review working tree modifications</span>
              </div>
              <div class="starter-item" onclick="insertPrompt('Run xio doctor to check system health and keys')">
                <span class="starter-title">Doctor check</span>
                <span class="starter-desc">Inspect environment and API keys</span>
              </div>
              <div class="starter-item" onclick="insertPrompt('Explain repository architecture and project conventions')">
                <span class="starter-title">Explore codebase</span>
                <span class="starter-desc">Analyze module hierarchy and patterns</span>
              </div>
            </div>
          </div>
        \`;
        return;
      }

      messages.forEach(msg => {
        if (msg.role === "user") {
          appendUserMessage(msg.content);
        } else if (msg.role === "assistant") {
          appendAssistantMessage(msg.content);
        }
      });
    }

    function appendUserMessage(text) {
      const hero = document.getElementById("hero-state");
      if (hero) hero.remove();

      const row = document.createElement("div");
      row.className = "message-row user";
      row.innerHTML = \`
        <div class="bubble user">
          <div class="bubble-content">\${escapeHtml(text)}</div>
        </div>
      \`;
      chatFlowContainer.appendChild(row);
      chatScrollArea.scrollTop = chatScrollArea.scrollHeight;
    }

    let currentAssistantBox = null;

    function getOrCreateAssistantBox() {
      const hero = document.getElementById("hero-state");
      if (hero) hero.remove();

      if (!currentAssistantBox) {
        const row = document.createElement("div");
        row.className = "message-row assistant";
        const bubble = document.createElement("div");
        bubble.className = "bubble assistant";
        const content = document.createElement("div");
        content.className = "bubble-content";
        bubble.appendChild(content);
        row.appendChild(bubble);
        chatFlowContainer.appendChild(row);
        currentAssistantBox = content;
      }
      return currentAssistantBox;
    }

    async function handleSend() {
      const text = composerInput.value.trim();
      if (!text || isRunning) return;

      if (!activeSessionId) {
        const res = await fetch("/api/sessions", { method: "POST" });
        const data = await res.json();
        activeSessionId = data.id;
        await loadSessions();
      }

      appendUserMessage(text);
      composerInput.value = "";
      currentAssistantBox = null;
      setRunningState(true);

      try {
        const res = await fetch(\`/api/sessions/\${activeSessionId}/prompt\`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: text }),
        });
        if (!res.ok) {
          throw new Error("Failed to send prompt");
        }
      } catch (err) {
        appendAssistantMessage("Error dispatching prompt: " + err.message);
        setRunningState(false);
      }
    }

    async function handleAbort() {
      if (!activeSessionId || !isRunning) return;
      try {
        await fetch(\`/api/sessions/\${activeSessionId}/abort\`, { method: "POST" });
      } catch (err) {
        console.error("abort error", err);
      }
    }

    function setRunningState(running) {
      isRunning = running;
      statusPill.className = "status-badge" + (running ? " running" : "");
      statusText.textContent = running ? "Thinking..." : "Ready";
      btnSend.style.display = running ? "none" : "flex";
      btnAbort.style.display = running ? "flex" : "none";
    }

    function connectSse(sessionId) {
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      if (!sessionId) return;

      eventSource = new EventSource(\`/api/sessions/\${sessionId}/events\`);
      eventSource.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);
          handleRuntimeEvent(event);
        } catch (err) {
          // ignore keepalive
        }
      };
      eventSource.onerror = () => {
        // SSE auto reconnects
      };
    }

    function handleRuntimeEvent(event) {
      const type = event.event;
      const payload = event.payload || {};

      // Trajectory record
      addTrajectoryRow(event);

      if (type === "run.start") {
        setRunningState(true);
      } else if (type === "run.end" || type === "cancel") {
        setRunningState(false);
        currentAssistantBox = null;
      } else if (type === "thinking.delta") {
        appendThinkingDelta(payload.delta || "");
      } else if (type === "text.delta") {
        appendTextDelta(payload.delta || "");
      } else if (type === "tool.call") {
        appendToolCall(payload);
        metricsState.turns++;
        document.getElementById("val-turns").textContent = metricsState.turns;
      } else if (type === "tool.result") {
        updateToolResult(payload);
      }
    }

    function addTrajectoryRow(event) {
      const traceTable = document.getElementById("trajectory-body");
      if (!traceTable) return;
      const row = document.createElement("tr");
      row.className = "trace-row";
      row.innerHTML = \`
        <td class="trace-seq">#\${event.seq ?? "-"}</td>
        <td class="trace-event">\${escapeHtml(event.event || "unknown")}</td>
        <td class="trace-payload">\${escapeHtml(JSON.stringify(event.payload || {}))}</td>
      \`;
      traceTable.appendChild(row);
    }

    function appendThinkingDelta(delta) {
      const box = getOrCreateAssistantBox();
      let card = box.querySelector(".thought-drawer");
      if (!card) {
        card = document.createElement("div");
        card.className = "thought-drawer";
        card.innerHTML = \`
          <div class="thought-drawer-header" onclick="this.parentElement.classList.toggle('collapsed')">
            <span class="thought-badge">Thinking</span>
            <span class="thought-expand-hint">Click to fold</span>
          </div>
          <div class="thought-drawer-body"></div>
        \`;
        box.appendChild(card);
      }
      const body = card.querySelector(".thought-drawer-body");
      body.textContent += delta;
      chatScrollArea.scrollTop = chatScrollArea.scrollHeight;
    }

    function appendTextDelta(delta) {
      const box = getOrCreateAssistantBox();
      let prose = box.querySelector(".prose");
      if (!prose) {
        prose = document.createElement("div");
        prose.className = "prose";
        box.appendChild(prose);
      }
      prose.textContent += delta;
      chatScrollArea.scrollTop = chatScrollArea.scrollHeight;
    }

    function appendAssistantMessage(text) {
      const box = getOrCreateAssistantBox();
      const prose = document.createElement("div");
      prose.className = "prose";
      prose.innerHTML = \`<p>\${escapeHtml(text)}</p>\`;
      box.appendChild(prose);
      chatScrollArea.scrollTop = chatScrollArea.scrollHeight;
    }

    function appendToolCall(payload) {
      const box = getOrCreateAssistantBox();
      const card = document.createElement("div");
      card.className = "tool-box";
      card.id = "tool-" + (payload.call_id || Date.now());
      card.innerHTML = \`
        <div class="tool-box-header" onclick="this.parentElement.classList.toggle('collapsed')">
          <span class="tool-name-tag">\${payload.tool}</span>
          <span class="tool-status-pill">running</span>
        </div>
        <div class="tool-box-body">\${JSON.stringify(payload.args || {}, null, 2)}</div>
      \`;
      box.appendChild(card);
      chatScrollArea.scrollTop = chatScrollArea.scrollHeight;
    }

    function updateToolResult(payload) {
      const card = document.getElementById("tool-" + payload.call_id);
      if (card) {
        const badge = card.querySelector(".tool-status-pill");
        if (badge) {
          badge.className = "tool-status-pill " + (payload.is_error ? "error" : "done");
          badge.textContent = payload.is_error ? "error" : "done";
        }
        const body = card.querySelector(".tool-box-body");
        if (body && payload.result) {
          body.textContent = payload.result;
        }
      }
    }

    async function fetchDiff() {
      const body = document.getElementById("diff-output-body");
      body.textContent = "Loading git diff...";
      try {
        const res = await fetch("/api/workspace/diff");
        const data = await res.json();
        body.textContent = data.diff && data.diff.trim().length > 0 ? data.diff : "Working tree clean. No uncommitted modifications.";
      } catch (err) {
        body.textContent = "Failed to fetch workspace diff.";
      }
    }

    function escapeHtml(str) {
      return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
  </script>
</body>
</html>`;
}
