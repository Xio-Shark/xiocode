/**
 * Centralized layout metrics and viewport calculation for TUI fullscreen windows.
 * Replaces scattered magic numbers (11 / 18 / 19) with unified, measured metrics.
 */

/** Brand header height including top/bottom margins (default fallback). */
export const HEADER_CHROME_ROWS = 5;

/** Composer card height with borders and single-line input (default fallback). */
export const COMPOSER_CHROME_ROWS = 4;

/** Quiet footer bar height with margins (default fallback). */
export const FOOTER_CHROME_ROWS = 2;

/** Baseline frame chrome rows: header (5) + composer (4) + footer (2) = 11 rows. */
export const BASE_CHROME_ROWS = HEADER_CHROME_ROWS + COMPOSER_CHROME_ROWS + FOOTER_CHROME_ROWS;

/** Chrome rows for Ctrl+O transcript viewer overlay (borders, title, hints). */
export const VIEWER_OVERLAY_EXTRA_ROWS = 7;

/** Total chrome rows around viewer overlay: base (11) + viewer extra (7) = 18. */
export const VIEWER_CHROME_ROWS = BASE_CHROME_ROWS + VIEWER_OVERLAY_EXTRA_ROWS;

/** Chrome rows for shortcuts sheet overlay (borders, title, indicators). */
export const SHORTCUTS_OVERLAY_EXTRA_ROWS = 8;

/** Total chrome rows around shortcuts sheet: base (11) + shortcuts extra (8) = 19. */
export const SHORTCUTS_CHROME_ROWS = BASE_CHROME_ROWS + SHORTCUTS_OVERLAY_EXTRA_ROWS;

/** Minimum usable viewport height for any scrollable content band. */
export const MIN_VIEWPORT_LINES = 4;

/**
 * Compute the visible content band height given terminal rows and extra chrome.
 * Clamped to at least MIN_VIEWPORT_LINES.
 */
export function computeViewportHeight(rows: number, extraChrome = 0): number {
  return Math.max(MIN_VIEWPORT_LINES, rows - (BASE_CHROME_ROWS + extraChrome));
}

/**
 * Compute viewer viewport height for Ctrl+O overlay.
 */
export function computeViewerViewport(rows: number): number {
  return Math.max(MIN_VIEWPORT_LINES, rows - VIEWER_CHROME_ROWS);
}

/**
 * Compute shortcut overlay viewport height.
 */
export function computeShortcutViewport(rows: number): number {
  return Math.max(MIN_VIEWPORT_LINES, rows - SHORTCUTS_CHROME_ROWS);
}
