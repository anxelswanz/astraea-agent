// AstraeaIntro — two-phase boot animation.
//
// Phase 1 (wordmark): a silver shine sweeps left→right across the indigo
// "Astraea" wordmark exactly once (~1s). It does NOT call onDone on finish —
// the wordmark settles to solid indigo and we advance to phase 2.
// Phase 2 (figure): a silver band sweeps top→bottom revealing the goddess
// symbol-art row by row (~60ms/row). When the last row lands → onDone().
// The caller then commits the settled card into <Static> (see App.tsx boot phase).
//
// Lives in the live (non-Static) region only while booting — never repaints after.
// Skippable: any keypress finishes immediately. Narrow terminals skip the
// wordmark phase (start at figure); too narrow even for the goddess → onDone now.
//
// 尺寸检查必须**同时看宽和高**。live frame 一旦比终端还高，Ink 会走 renderInteractiveFrame
// 的 fullscreen 分支：每一帧都写 ansiEscapes.clearTerminal（含 \x1b[3J）+ 全量 static 重印。
// \x1b[3J 会删掉终端的滚动回溯缓冲，xterm / VTE / Konsole / Alacritty / kitty 都认这个转义符
// （macOS Terminal.app 忽略）。字标 6 行 + 女神 25 行 + 输入框 3 行 = 34 行，任何不到 35 行的
// 终端都会中招：启动动画每帧清一次回溯，用户跑 astraea 之前留在终端里的东西全没了，且找不回来。
// 所以放不下就降级（只播字标 / 直接跳过），绝不画一个比窗口还高的帧。

import React, { useEffect, useRef, useState } from 'react'
import { useInput, useStdout, useWindowSize, Box } from 'ink'
import { AstraeaWordmark, WORDMARK_WIDTH, WORDMARK_HEIGHT, fitsWordmark } from './AstraeaWordmark'
import { AstraeaGoddess, GODDESS_HEIGHT, GODDESS_WIDTH } from './AstraeaGoddess'

const TICK_MS = 40          // wordmark frame interval
const STEP = 3              // columns the shine advances per frame
const BAND = 8              // lead/trail padding so the band fully enters & exits
const START = -BAND
const FIGURE_TICK_MS = 60   // goddess reveal: one row per frame (~1.5s total)
// intro 之外这一帧还挂着输入框（上下框线 + 输入行）。宁可多留一行，也不能让整帧超出窗口高度。
const FOOTER_RESERVE = 4

type Phase = 'wordmark' | 'figure'

export function AstraeaIntro({ onDone }: { onDone: () => void }): React.ReactNode {
  const { stdout } = useStdout()
  const columns = stdout?.columns ?? 80
  const { rows } = useWindowSize()
  const height = rows ?? 24
  const wordmarkFits = fitsWordmark(columns) && height >= WORDMARK_HEIGHT + FOOTER_RESERVE
  const goddessFits = columns >= GODDESS_WIDTH
    && height >= WORDMARK_HEIGHT + GODDESS_HEIGHT + FOOTER_RESERVE

  // 窄屏（字标放不下）直接从女神揭示开始；字标放得下则先扫字标。
  const [phase, setPhase] = useState<Phase>(wordmarkFits ? 'wordmark' : 'figure')

  const [pos, setPos] = useState(START)
  const posRef = useRef(START)
  const [shown, setShown] = useState(0)
  const shownRef = useRef(0)
  const doneRef = useRef(false)

  const finish = () => {
    if (doneRef.current) return
    doneRef.current = true
    onDone()
  }

  // Phase 1: 字标横扫。扫完不 onDone，切到 figure（字标转常驻靛蓝）。
  useEffect(() => {
    if (phase !== 'wordmark') return
    const id = setInterval(() => {
      posRef.current += STEP
      if (posRef.current > WORDMARK_WIDTH + BAND) {
        clearInterval(id)
        setPhase('figure')
        return
      }
      setPos(posRef.current)
    }, TICK_MS)
    return () => clearInterval(id)
  }, [phase])

  // Phase 2: 女神自上而下逐行揭示（band = 当前点亮的前沿行）。
  useEffect(() => {
    if (phase !== 'figure') return
    // 连女神都放不下 → 不阻塞 boot，立即收尾。
    if (!goddessFits) { finish(); return }
    const id = setInterval(() => {
      shownRef.current += 1
      if (shownRef.current >= GODDESS_HEIGHT) {
        setShown(GODDESS_HEIGHT)
        clearInterval(id)
        finish()
        return
      }
      setShown(shownRef.current)
    }, FIGURE_TICK_MS)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, goddessFits])

  // Any keypress skips the intro.
  useInput(() => finish())

  if (phase === 'figure' && !goddessFits) return null

  return (
    <Box flexDirection="column" alignItems="center">
      {phase === 'wordmark'
        ? <AstraeaWordmark shineCenter={pos} />
        : <AstraeaWordmark />}
      {phase === 'figure' && goddessFits && (
        <AstraeaGoddess reveal={{ shown, band: shown - 1 }} />
      )}
    </Box>
  )
}
