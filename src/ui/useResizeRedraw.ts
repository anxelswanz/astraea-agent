// useResizeRedraw — trigger a single full-screen redraw whenever the terminal is resized.
//
// Why it's needed: Ink's <Static> is append-only — the scrollback history lines it has already
// committed are never repainted. After a terminal resize those old lines re-wrap to the new
// column width, but Ink can't erase frames it already committed, so the history ghosts/misaligns
// and the hand-drawn input-box border breaks too. The fix is to clear the screen + remount
// <Static> on resize, re-rendering all history at the new size (see App's wipeStatic).
//
// What the redraw must NOT do: erase the terminal's scrollback. The clear sequence used here is
// CLEAR_SCREEN (\x1b[2J\x1b[H) — never CLEAR_SCROLLBACK, whose \x1b[3J deletes the scrollback
// buffer outright on xterm / VTE / Konsole / Alacritty / kitty (macOS Terminal.app ignores it,
// which is why the resulting data loss only ever got reported on Linux). Redrawing the screen is
// recoverable; deleting the user's scrollback is not. See the CLEAR_SCREEN comment in App.tsx.
//
// Why it's debounced: dragging a window edge fires dozens of resize events. useWindowSize()
// already listens for those internally; here we only react to the columns/rows values it produces
// — a timer (default 150ms) collapses a whole drag into a single trailing onResize. Each further
// size change during the window clears the pending timer and restarts it, so we fire only once
// the drag settles.
//
// Extracted into its own hook (rather than inlined in App) so the "skip mount frame + debounce +
// ignore unchanged dims + clean up on unmount" logic — which has a few edge cases — can be
// unit-tested in isolation (see useResizeRedraw.test.tsx).

import { useEffect, useRef } from 'react'

export function useResizeRedraw(
  columns: number | undefined,
  rows: number | undefined,
  onResize: () => void,
  delay = 150,
): void {
  // Remember the dimensions at the last redraw. Initialised to the mount-time size, so on the
  // mount frame the deps equal it and nothing fires.
  const prevDims = useRef({ columns, rows })
  useEffect(() => {
    if (prevDims.current.columns === columns && prevDims.current.rows === rows) return
    const id = setTimeout(() => {
      prevDims.current = { columns, rows }
      onResize()
    }, delay)
    return () => clearTimeout(id)
  }, [columns, rows, onResize, delay])
}
