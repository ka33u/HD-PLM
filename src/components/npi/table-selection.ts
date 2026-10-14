// SPDX-License-Identifier: AGPL-3.0-or-later
// Only select identities visible in the current ordered list; preserve other pages.
export function selectRange(
  previous: readonly string[],
  visible: readonly string[],
  target: string,
  checked: boolean,
  anchor: string | null,
  range: boolean,
  limit: number,
) {
  const end = visible.indexOf(target),
    start = anchor ? visible.indexOf(anchor) : -1
  if (end < 0) return [...previous]
  const ids =
    range && start >= 0
      ? visible.slice(Math.min(start, end), Math.max(start, end) + 1)
      : [target]
  const selected = new Set(previous)
  for (const id of ids) {
    if (!checked) selected.delete(id)
    else if (selected.size < limit) selected.add(id)
  }
  return [...selected]
}
