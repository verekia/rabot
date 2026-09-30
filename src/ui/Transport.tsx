import { useEffect, useRef, type MouseEvent } from 'react'

import { player } from '../player'
import { useStore } from '../store'

const time = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

const Meter = ({ label, meterRef }: { label: string; meterRef: React.RefObject<HTMLDivElement | null> }) => (
  <div className="flex w-28 flex-col gap-1">
    <div className="text-faint flex justify-between text-[10px] tracking-wider uppercase">
      <span>{label}</span>
      <span data-value className="tabular-nums" />
    </div>
    <div className="bg-raised h-1.5 overflow-hidden rounded-full">
      <div ref={meterRef} className="bg-accent ml-auto h-full w-0" />
    </div>
  </div>
)

const setMeter = (el: HTMLDivElement | null, db: number) => {
  if (!el) return
  el.style.width = `${Math.min(100, (db / 12) * 100)}%`
  const label = el.parentElement?.previousElementSibling?.querySelector('[data-value]')
  if (label) label.textContent = db > 0.05 ? `−${db.toFixed(1)} dB` : ''
}

export const Transport = () => {
  const selectedId = useStore(s => s.selectedId)
  const playingId = useStore(s => s.playingId)
  const playing = useStore(s => s.playing)
  const bypass = useStore(s => s.bypass)
  const tracks = useStore(s => s.tracks)
  const current = tracks.find(t => t.id === (playing ? playingId : selectedId))
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const timeRef = useRef<HTMLSpanElement>(null)
  const limRef = useRef<HTMLDivElement>(null)

  const peaks = current?.peaks ?? null
  const duration = current?.duration ?? 0
  const isCurrent = current?.id === playingId

  useEffect(() => {
    let frame = 0
    const draw = () => {
      frame = requestAnimationFrame(draw)
      const canvas = canvasRef.current
      if (!canvas) return
      const dpr = window.devicePixelRatio || 1
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr
        canvas.height = h * dpr
      }
      const g = canvas.getContext('2d')!
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, w, h)
      const pos = isCurrent ? player.position() : 0
      const progress = duration ? pos / duration : 0
      if (peaks) {
        const style = getComputedStyle(canvas)
        const played = style.getPropertyValue('--color-accent')
        const rest = style.getPropertyValue('--color-line-strong')
        const bars = Math.floor(w / 2)
        for (let i = 0; i < bars; i++) {
          const p = peaks[Math.floor((i / bars) * peaks.length)]!
          const bh = Math.max(1, Math.min(1, p) * h)
          g.fillStyle = i / bars < progress ? played : rest
          g.fillRect(i * 2, (h - bh) / 2, 1, bh)
        }
      }
      if (timeRef.current) timeRef.current.textContent = `${time(pos)} / ${time(duration)}`
      const meters = player.meters()
      setMeter(limRef.current, playing ? meters.limiter : 0)
    }
    draw()
    return () => cancelAnimationFrame(frame)
  }, [peaks, duration, isCurrent, playing])

  const onSeek = (e: MouseEvent<HTMLCanvasElement>) => {
    if (!duration) return
    const rect = e.currentTarget.getBoundingClientRect()
    player.seek(((e.clientX - rect.left) / rect.width) * duration)
  }

  const index = tracks.findIndex(t => t.id === current?.id)
  const go = (delta: number) => {
    const next = tracks[index + delta]
    if (!next) return
    useStore.setState({ selectedId: next.id })
    if (playing) player.play(next.id)
  }

  return (
    <div className="border-line bg-panel/95 sticky bottom-0 z-10 border-t backdrop-blur">
      <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-x-5 gap-y-3 px-4 py-3">
        <div className="flex items-center gap-1">
          <button
            className="text-muted hover:text-text grid size-8 place-items-center rounded-md disabled:opacity-30"
            onClick={() => go(-1)}
            disabled={index <= 0}
            aria-label="Previous track"
          >
            <svg viewBox="0 0 16 16" className="size-4 fill-current">
              <path d="M3 3h2v10H3zM13 3v10L6 8z" />
            </svg>
          </button>
          <button
            className="bg-accent text-bg grid size-10 place-items-center rounded-full hover:brightness-110 disabled:opacity-30"
            onClick={player.toggle}
            disabled={current?.status !== 'ready'}
            aria-label={playing ? 'Pause' : 'Play'}
          >
            {playing ? (
              <svg viewBox="0 0 16 16" className="size-4 fill-current">
                <path d="M4 3h3v10H4zM9 3h3v10H9z" />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" className="ml-0.5 size-4 fill-current">
                <path d="M4 2.5v11L13 8z" />
              </svg>
            )}
          </button>
          <button
            className="text-muted hover:text-text grid size-8 place-items-center rounded-md disabled:opacity-30"
            onClick={() => go(1)}
            disabled={index < 0 || index >= tracks.length - 1}
            aria-label="Next track"
          >
            <svg viewBox="0 0 16 16" className="size-4 fill-current">
              <path d="M11 3h2v10h-2zM3 3v10l7-5z" />
            </svg>
          </button>
        </div>

        <div className="flex min-w-60 flex-1 flex-col gap-1">
          <div className="flex justify-between gap-3 text-xs">
            <span className="text-text truncate">{current?.name ?? 'Nothing selected'}</span>
            <span ref={timeRef} className="text-faint shrink-0 tabular-nums" />
          </div>
          <canvas ref={canvasRef} className="h-9 w-full cursor-pointer" onClick={onSeek} />
        </div>

        <div
          className="border-line-strong flex rounded-md border p-0.5 text-xs"
          title="A/B against the loudness-matched original (B)"
        >
          {(['Processed', 'Original'] as const).map(label => {
            const active = (label === 'Original') === bypass
            return (
              <button
                key={label}
                className={`rounded px-2.5 py-1 ${active ? 'bg-raised text-text' : 'text-muted hover:text-text'}`}
                onClick={() => useStore.setState({ bypass: label === 'Original' })}
              >
                {label}
              </button>
            )
          })}
        </div>

        <div className="flex flex-col gap-1.5">
          <Meter label="Limiter" meterRef={limRef} />
        </div>
      </div>
    </div>
  )
}
