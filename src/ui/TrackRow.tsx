import { useRef, useState, type DragEvent } from 'react'

import { CEILING_DBTP, peakLimiting } from '../audio/plan'
import { exportTrack, removeTrack, replaceFile } from '../engine'
import { player } from '../player'
import { isStale, planTrack, useStore, type Track } from '../store'

const db = (v: number, digits = 1) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}`

const limitColor = (v: number) => (v < 1.5 ? 'text-ok' : v < 4 ? 'text-warn' : 'text-bad')

export const TrackRow = ({ track, index }: { track: Track; index: number }) => {
  const state = useStore()
  const selected = state.selectedId === track.id
  const isPlaying = state.playing && state.playingId === track.id
  const tp = planTrack(state, track)
  const stale = track.status === 'ready' && isStale(state, track)
  const limiting = tp && track.stage ? peakLimiting(tp.postGain, track.stage) : null
  const verified =
    track.output && tp && track.output.key === tp.plan.key && Math.abs(track.output.postGain - tp.postGain) < 0.01
  const fileInput = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)

  const onDrop = (e: DragEvent) => {
    const file = e.dataTransfer.files[0]
    if (e.dataTransfer.files.length !== 1 || !file) return
    // A single file dropped on a row swaps that track's source.
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    replaceFile(track.id, file)
  }

  const status =
    track.status === 'loading' ? 'Decoding…' : track.status === 'error' ? track.error : stale ? 'Measuring…' : null

  return (
    <li
      className={`rounded-md border transition-colors ${selected ? 'border-line bg-panel' : 'hover:bg-panel border-transparent'} ${dragOver ? 'border-accent!' : ''}`}
      onDragOver={e => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDragOver(true)
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div
        className="flex h-8 cursor-pointer items-center gap-3 px-3"
        onClick={() => useStore.setState({ selectedId: track.id })}
      >
        <span className="text-faint w-5 text-right text-xs tabular-nums">{index + 1}</span>
        <button
          className="border-line-strong text-text hover:border-accent hover:text-accent grid size-6 shrink-0 place-items-center rounded-full border disabled:opacity-30"
          disabled={track.status !== 'ready'}
          aria-label={isPlaying ? 'Pause' : 'Play'}
          onClick={e => {
            e.stopPropagation()
            useStore.setState({ selectedId: track.id })
            if (isPlaying) player.pause()
            else player.play(track.id)
          }}
        >
          {isPlaying ? (
            <svg viewBox="0 0 16 16" className="size-2.5 fill-current">
              <path d="M4 3h3v10H4zM9 3h3v10H9z" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" className="ml-px size-2.5 fill-current">
              <path d="M4 2.5v11L13 8z" />
            </svg>
          )}
        </button>
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="truncate text-sm">{track.name}</span>
          {status && (
            <span className={`shrink-0 text-xs ${track.status === 'error' ? 'text-bad' : 'text-muted'}`}>{status}</span>
          )}
        </div>
        {selected && (
          <div className="flex shrink-0 items-center gap-1 text-xs" onClick={e => e.stopPropagation()}>
            <button
              className="bg-raised text-text hover:bg-line-strong flex items-center gap-1.5 rounded px-2.5 py-0.5 disabled:opacity-40"
              disabled={track.status !== 'ready' || state.exporting !== null}
              onClick={() => void exportTrack(track.id)}
              title="Export WAV"
            >
              <svg viewBox="0 0 16 16" className="size-3 fill-none stroke-current" strokeWidth={1.6}>
                <path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M3 13h10" />
              </svg>
              <span className="hidden sm:inline">Export WAV</span>
            </button>
            <button
              className="text-muted hover:bg-raised hover:text-text flex items-center gap-1.5 rounded px-2.5 py-0.5"
              onClick={() => fileInput.current?.click()}
              title="Replace file"
            >
              <svg viewBox="0 0 16 16" className="size-3 fill-none stroke-current" strokeWidth={1.6}>
                <path d="M3 6h9.5L10 3.5M13 10H3.5L6 12.5" />
              </svg>
              <span className="hidden sm:inline">Replace</span>
            </button>
            <button
              className="text-muted hover:bg-raised hover:text-bad flex items-center gap-1.5 rounded px-2.5 py-0.5"
              onClick={() => removeTrack(track.id)}
              title="Remove"
            >
              <svg viewBox="0 0 16 16" className="size-3 fill-none stroke-current" strokeWidth={1.6}>
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
              <span className="hidden sm:inline">Remove</span>
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="audio/*,.mp3"
              hidden
              onChange={e => {
                const file = e.target.files?.[0]
                if (file) replaceFile(track.id, file)
                e.target.value = ''
              }}
            />
          </div>
        )}
        {limiting !== null && limiting >= 0.5 && (
          <div
            className={`text-xs tabular-nums ${limitColor(limiting)}`}
            title={`Peak limiting at the ${CEILING_DBTP} dBTP ceiling`}
          >
            lim −{limiting.toFixed(1)}
          </div>
        )}
        {tp && (
          <div className="text-muted w-16 text-right text-xs tabular-nums" title="Gain applied">
            {db(tp.postGain + tp.plan.preGain)} dB
          </div>
        )}
        <div className="text-ok w-3 text-xs" title="Exported at these settings">
          {verified ? '✓' : ''}
        </div>
      </div>
    </li>
  )
}
