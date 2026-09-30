import { useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'

type Props = {
  label: string
  value: number
  min: number
  max: number
  step: number
  defaultValue: number
  onChange: (value: number) => void
  format: (value: number) => string
  bipolar?: boolean
  size?: number
  // Shown under the value, e.g. what the dial does to the current track.
  children?: ReactNode
}

const START = -135
const SWEEP = 270

const polar = (cx: number, cy: number, r: number, deg: number) => {
  const rad = ((deg - 90) * Math.PI) / 180
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)] as const
}

const arc = (cx: number, cy: number, r: number, from: number, to: number) => {
  const [x1, y1] = polar(cx, cy, r, from)
  const [x2, y2] = polar(cx, cy, r, to)
  const large = Math.abs(to - from) > 180 ? 1 : 0
  const sweep = to > from ? 1 : 0
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} ${sweep} ${x2} ${y2}`
}

// Rotary dial: drag vertically (hold Shift for fine), arrow keys to step, double-click to reset.
export const Knob = ({
  label,
  value,
  min,
  max,
  step,
  defaultValue,
  onChange,
  format,
  bipolar,
  size = 64,
  children,
}: Props) => {
  const drag = useRef<{ y: number; value: number } | null>(null)

  const commit = (v: number) => {
    const clamped = Math.min(max, Math.max(min, Math.round(v / step) * step))
    if (clamped !== value) onChange(Number(clamped.toFixed(4)))
  }

  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    e.currentTarget.focus()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { y: e.clientY, value }
  }
  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    if (!drag.current) return
    const range = e.shiftKey ? 1000 : 200
    commit(drag.current.value + ((drag.current.y - e.clientY) / range) * (max - min))
  }
  const onPointerUp = () => (drag.current = null)

  const onKeyDown = (e: KeyboardEvent) => {
    const delta =
      e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0
    if (!delta) return
    e.preventDefault()
    e.stopPropagation()
    commit(value + delta * step * (e.shiftKey ? 5 : 1))
  }

  const t = (value - min) / (max - min)
  const angle = START + t * SWEEP
  const origin = bipolar ? START + ((0 - min) / (max - min)) * SWEEP : START
  const c = size / 2
  const r = size / 2 - 5
  const [ix, iy] = polar(c, c, r - 9, angle)
  const [ox, oy] = polar(c, c, r - 3, angle)

  return (
    <div className="flex w-20 flex-col items-center gap-1.5 select-none">
      <div className="text-muted text-[11px] font-semibold tracking-wider uppercase">{label}</div>
      <svg
        width={size}
        height={size}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={format(value)}
        className="focus-visible:ring-accent/60 cursor-ns-resize touch-none rounded-full outline-none focus-visible:ring-2"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => onChange(defaultValue)}
        onKeyDown={onKeyDown}
      >
        <circle cx={c} cy={c} r={r - 6} className="fill-raised stroke-line-strong" strokeWidth={1} />
        <path
          d={arc(c, c, r, START, START + SWEEP)}
          className="stroke-line-strong fill-none"
          strokeWidth={3}
          strokeLinecap="round"
        />
        {Math.abs(angle - origin) > 0.5 && (
          <path
            d={arc(c, c, r, Math.min(origin, angle), Math.max(origin, angle))}
            className="stroke-accent fill-none"
            strokeWidth={3}
            strokeLinecap="round"
          />
        )}
        <line x1={ix} y1={iy} x2={ox} y2={oy} className="stroke-text" strokeWidth={2} strokeLinecap="round" />
      </svg>
      <div className="text-text text-sm tabular-nums">{format(value)}</div>
      {children && <div className="mt-1 flex h-7 items-start">{children}</div>}
    </div>
  )
}
