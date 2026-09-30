import { useEffect, useRef, useState } from 'react'

import { DEFAULT_GLOBAL } from './audio/plan'
import { addFiles, exportAll, updateProfile } from './engine'
import { player } from './player'
import { isStale, planTrack, sameNames, setGlobal, useStore } from './store'
import { EqBars, GainBar, ReductionBar } from './ui/EffectBars'
import { Knob } from './ui/Knob'
import { Transport } from './ui/Transport'
import { TrackRow } from './ui/TrackRow'

export const MainView = () => {
  const tracks = useStore(s => s.tracks)
  const global = useStore(s => s.global)
  const exporting = useStore(s => s.exporting)
  const profile = useStore(s => s.profile)
  const playing = useStore(s => s.playing)
  const currentId = useStore(s => (s.playing ? s.playingId : s.selectedId))
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  // Whole-window drop target for adding files.
  useEffect(() => {
    let depth = 0
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth++
      setDragging(true)
    }
    const leave = () => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault()
    }
    const drop = (e: DragEvent) => {
      depth = 0
      setDragging(false)
      if (!hasFiles(e)) return
      e.preventDefault()
      addFiles(Array.from(e.dataTransfer!.files))
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [])

  // Keyboard: Space play/pause, B toggles A/B, ↑/↓ select track.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.closest('input, textarea, [role="slider"]') || e.metaKey || e.ctrlKey || e.altKey) return
      const state = useStore.getState()
      if (e.code === 'Space') {
        e.preventDefault()
        player.toggle()
      } else if (e.key === 'b' || e.key === 'B') {
        useStore.setState({ bypass: !state.bypass })
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const i = state.tracks.findIndex(t => t.id === state.selectedId)
        const next = state.tracks[Math.max(0, Math.min(state.tracks.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
        if (next) {
          useStore.setState({ selectedId: next.id })
          if (state.playing) player.play(next.id)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const ready = tracks.filter(t => t.status === 'ready')

  // Each track counts twice: once when read and analyzed, once when its gain has been measured.
  const active = tracks.filter(t => t.status !== 'error')
  const loading = active.filter(t => t.status === 'loading').length
  const pending = ready.filter(t => isStale({ global, profile }, t)).length
  const busy = loading + pending > 0
  const progress = active.length ? 1 - (2 * loading + pending) / (2 * active.length) : 1

  const readyNames = ready.map(t => t.name)

  // What the dials do to the playing track (or the selected one when stopped).
  const current = tracks.find(t => t.id === currentId)
  const currentPlan = current ? planTrack({ global, profile }, current) : null
  const profileDiffers = profile?.locked && readyNames.length > 0 && !sameNames(profile.names, readyNames)

  return (
    <div className="flex min-h-screen flex-col">
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 pt-8 pb-10">
        <header className="mb-8 flex items-center justify-between gap-4">
          <h1 className="text-lg font-semibold tracking-tight">Rabot</h1>
          <button
            className="bg-accent text-bg rounded-md px-4 py-2 text-sm font-semibold hover:brightness-110 disabled:opacity-30"
            disabled={ready.length === 0 || loading > 0 || exporting !== null}
            onClick={() => void exportAll()}
          >
            {exporting ? `Exporting ${exporting.done}/${exporting.total}` : 'Export all'}
          </button>
        </header>

        <section className="border-line mb-6 flex flex-wrap justify-center gap-x-10 gap-y-6 border-b pb-6 sm:justify-start">
          <Knob
            label="Loudness"
            value={global.target}
            min={-20}
            max={-8}
            step={0.5}
            defaultValue={DEFAULT_GLOBAL.target}
            format={v => `${v.toFixed(1)} LUFS`}
            onChange={target => setGlobal({ target })}
          >
            <GainBar db={currentPlan ? currentPlan.postGain + currentPlan.plan.preGain : null} />
          </Knob>
          <Knob
            label="Dynamics"
            value={global.dynamics}
            min={0}
            max={1}
            step={0.05}
            defaultValue={DEFAULT_GLOBAL.dynamics}
            format={v => `${Math.round(v * 100)}%`}
            onChange={dynamics => setGlobal({ dynamics })}
          >
            <ReductionBar active={playing} />
          </Knob>
          <Knob
            label="Tone match"
            value={global.toneMatch}
            min={0}
            max={1}
            step={0.05}
            defaultValue={DEFAULT_GLOBAL.toneMatch}
            format={v => `${Math.round(v * 100)}%`}
            onChange={toneMatch => setGlobal({ toneMatch })}
          >
            <EqBars gains={currentPlan?.plan.eq ?? null} />
          </Knob>
        </section>

        {busy && (
          <div className="mb-4 flex items-center gap-3 text-xs" role="status">
            <span className="text-muted w-20 shrink-0">{loading > 0 ? 'Analyzing' : 'Updating'}</span>
            <div className="bg-raised h-1 flex-1 overflow-hidden rounded-full">
              <div
                className="bg-accent h-full transition-[width] duration-300"
                style={{ width: `${progress * 100}%` }}
              />
            </div>
            <span className="text-muted w-10 text-right tabular-nums">{Math.round(progress * 100)}%</span>
          </div>
        )}

        {profileDiffers && !loading && (
          <div className="text-muted mb-4 flex flex-wrap items-center justify-between gap-3 text-xs">
            <span>Tone reference: last export ({profile.names.length} tracks)</span>
            {readyNames.length >= 2 && (
              <button className="text-text underline-offset-4 hover:underline" onClick={updateProfile}>
                Use current tracks
              </button>
            )}
          </div>
        )}

        {tracks.length > 0 && (
          <ul className="mb-3 flex flex-col gap-px">
            {tracks.map((t, i) => (
              <TrackRow key={t.id} track={t} index={i} />
            ))}
          </ul>
        )}

        <button
          className={`flex w-full items-center justify-center rounded-lg border border-dashed text-sm transition-colors ${
            dragging ? 'border-accent text-accent' : 'border-line-strong text-muted hover:border-muted hover:text-text'
          } ${tracks.length ? 'py-3' : 'py-24'}`}
          onClick={() => fileInput.current?.click()}
        >
          {tracks.length ? '+ Add tracks' : 'Drop MP3s here'}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="audio/*,.mp3"
          multiple
          hidden
          onChange={e => {
            addFiles(Array.from(e.target.files ?? []))
            e.target.value = ''
          }}
        />
      </main>
      {tracks.length > 0 && <Transport />}
    </div>
  )
}
