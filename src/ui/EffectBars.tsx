// Small displays under the global dials showing what each one does to the current track.

import { useEffect, useRef } from 'react'

import { BANDS } from '../audio/spectrum'
import { bandResponse, TONE_FILTERS } from '../audio/plan'
import { player } from '../player'

const signed = (v: number) => `${v > 0.05 ? '+' : v < -0.05 ? '−' : ''}${Math.abs(v).toFixed(1)} dB`

const Track = ({ children }: { children?: React.ReactNode }) => (
  <div className="bg-raised relative h-1.5 w-16 overflow-hidden rounded-full">{children}</div>
)

const Label = ({ children }: { children: React.ReactNode }) => (
  <div className="text-muted h-3.5 text-[11px] leading-none tabular-nums">{children}</div>
)

// Net gain applied to the track, ±12 dB around a center tick.
export const GainBar = ({ db }: { db: number | null }) => {
  const t = db === null ? 0 : Math.max(-1, Math.min(1, db / 12))
  return (
    <div className="flex flex-col items-center gap-1.5" title="Gain applied to this track">
      <Track>
        <div
          className="bg-accent absolute inset-y-0"
          style={{ left: `${50 + Math.min(0, t) * 50}%`, width: `${Math.abs(t) * 50}%` }}
        />
        <div className="bg-muted absolute inset-y-0 left-1/2 w-px" />
      </Track>
      <Label>{db === null ? '' : signed(db)}</Label>
    </div>
  )
}

// Live gain reduction from the dynamics stage, 0–8 dB.
export const ReductionBar = ({ active }: { active: boolean }) => {
  const fill = useRef<HTMLDivElement>(null)
  const label = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let frame = 0
    let shown = 0
    const draw = () => {
      frame = requestAnimationFrame(draw)
      const target = active ? player.meters().dynamics : 0
      // Instant attack, smooth fall so the bar is readable.
      shown = target > shown ? target : shown * 0.92 + target * 0.08
      if (fill.current) fill.current.style.width = `${Math.min(100, (shown / 8) * 100)}%`
      if (label.current) label.current.textContent = active ? (shown < 0.05 ? '0 dB' : `−${shown.toFixed(1)} dB`) : ''
    }
    draw()
    return () => cancelAnimationFrame(frame)
  }, [active])

  return (
    <div className="flex flex-col items-center gap-1.5" title="Transient reduction right now">
      <Track>
        <div ref={fill} className="bg-accent absolute inset-y-0 left-0 w-0" />
      </Track>
      <div ref={label} className="text-muted h-3.5 text-[11px] leading-none tabular-nums" />
    </div>
  )
}

// EQ change per band (bass, low mid, presence, air), ±4 dB around a center line.
export const EqBars = ({ gains }: { gains: number[] | null }) => {
  const response = gains ? bandResponse(gains) : null
  const bands = TONE_FILTERS.map(f => f.band)
  const title = response
    ? bands.map(b => `${BANDS[b]!.name} ${signed(response[b]!)}`).join(' · ')
    : 'EQ applied to this track'
  return (
    <div className="flex flex-col items-center gap-1.5" title={title}>
      <div className="flex h-5 w-16 items-stretch gap-1">
        {bands.map(b => {
          const t = response ? Math.max(-1, Math.min(1, response[b]! / 4)) : 0
          return (
            <div key={b} className="bg-raised relative flex-1 overflow-hidden rounded-sm">
              <div
                className="bg-accent absolute inset-x-0"
                style={{ bottom: `${50 + Math.min(0, t) * 50}%`, height: `${Math.abs(t) * 50}%` }}
              />
              <div className="bg-muted absolute inset-x-0 top-1/2 h-px" />
            </div>
          )
        })}
      </div>
    </div>
  )
}
