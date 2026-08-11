/**
 * Fuzzy filtering via the `fzf` package (FZF algorithm, zero deps) — used by
 * the command palette and any picker where substring matching feels weak.
 * Empty queries return the full list unchanged (stable order).
 */

import { Fzf } from "fzf";
import type { FzfResultItem } from "fzf";

export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  label: (item: T) => string,
): readonly T[] {
  const needle = query.trim();
  if (needle.length === 0) return [...items];
  const finder = new Fzf(items as readonly T[], { selector: label });
  return finder.find(needle).map((result: FzfResultItem<T>) => result.item);
}
