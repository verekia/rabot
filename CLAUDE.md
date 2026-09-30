# CLAUDE.md

## Project

Rabot is a client-only tool that homogenizes backing tracks for live music (loudness, dynamics, tone)
and exports 44.1 kHz / 24-bit WAVs, individually or zipped. Priorities, in order: tracks feel
homogeneous across the playlist, then no added distortion, then loudness (default −11 LUFS).

Stack: Next.js (pages router, static export) · React · zustand · Tailwind · Bun · oxfmt · oxlint · warden.

```bash
bun dev            # portless rabot next dev
bun run all        # format:check + lint + typecheck + warden + test — run before considering work done
bun test           # DSP unit tests (src/audio/*.test.ts)
```

## Architecture

`pages/index.tsx` dynamically imports `src/MainView.tsx` with `ssr: false`. All audio code lives in `src/`.

- `src/audio/plan.ts`: **pure**. Turns dials + analysis into a `Plan` (pre gain, EQ gains, compressor
  params). `plan.key` identifies everything before the post gain; a `StageAnalysis` is only valid for a
  matching key. Also computes the post gain, the limiter makeup validity and the clean-target hint.
- `src/audio/chain.ts`: the Web Audio graph (`buildChain`), used by **both** the realtime preview and the
  OfflineAudioContext export. Never fork these paths. Also handles latency measurement (the export is
  trimmed so it stays sample-aligned with the source) and decoding.
- `public/audio-worklets.js`: plain-JS AudioWorklet processors: `dynamics` (lookahead peak compressor)
  and `true-peak-limiter`. They're in `public/` so `audioWorklet.addModule` can load them by URL. The
  4× interpolator must stay in sync with `interpolatorPhases` in `loudness.ts`.
- `src/audio/loudness.ts`, `spectrum.ts`, `wav.ts`: **pure** DSP (BS.1770 loudness, true peak, band
  levels, WAV encoder), run in `analysis.worker.ts` and covered by `dsp.test.ts`.
- `src/audio/model.ts`: **pure**. The core of the interactivity: each track's `Signature` (loudness,
  true peak, spectrum, 10 ms K-weighted power + sample peak per segment) is measured once on add, and the
  dynamics stage + limiter are simulated on it (`simulateDynamics`, `solveGain`) to predict the post gain
  for any dial setting. Dials must never trigger renders; keep the simulation in sync with the worklets'
  gain curves and time constants.
- `src/engine.ts`: analysis on add (`analyzeTrack`, up to `CONCURRENCY` in parallel via the worker pool in
  `analyzer.ts`) and export. Only export renders full audio: render, measure, then correct by scaling
  (when that can't push peaks into the limiter) or by re-rendering. Chrome runs all offline
  AudioWorklet rendering on one thread, so parallel export renders don't help.
- Linear filters (25 Hz high-pass, tone EQ) change loudness predictably: `eqLoudnessDelta` and
  `highpassLoudnessDelta` in `plan.ts` compute it from the per-channel K-weighted spectrum.
- Tone match is disabled (`TONE_MATCH_ENABLED = false` in `plan.ts`): the EQ stays flat and its dial is
  hidden, but the code (profile, reference bands, EQ solver) is kept. The tone reference (`SetProfile` in
  the store) follows the tracks until the first export, then it's locked and persisted.
- `src/buffers.ts`: decoded audio isn't kept on tracks (about 85 MB per song). Always go through
  `getBuffer(id, file)`, a small LRU of decode promises. Tracks keep only `duration`, `peaks` and analyses.
- `src/player.ts`: preview voice with a processed path and a loudness-matched original path for A/B.
- `src/store.ts`: zustand store. The global dials and the locked tone reference persist to
  localStorage. There are deliberately no per-track settings: the same dials apply to the whole set.

## Gotchas

- Don't swap the custom `dynamics` worklet back to `DynamicsCompressorNode`. Measured on real tracks, the
  native node barely changes peak-to-loudness ratio, and it adds automatic makeup gain.
- Dynamics sits **before** the tone EQ on purpose: its threshold is relative to the −18 LUFS normalized
  level, and EQ would shift that per track.
- Web Audio reads a highpass/lowpass `Q` in dB (peaking filters take it linear). The high-pass uses
  `HIGHPASS_Q_DB` (−3.01 dB = Butterworth); a linear 0.707 there adds a resonant bump.
- Worklet processors return `true` from `process()` and so never die on their own. `Chain.disconnect()`
  sends them `{ stop: true }` so they return `false`; skipping that leaks a processor per play/seek and
  its stale meter reports overwrite the live ones.
- In dev, `window.__rabot` exposes store and pipeline helpers for console testing.

## Deployment

`./deploy.sh` builds an arm64 image (static export served by nginx, see `Dockerfile` / `nginx.conf`), copies
it to `midgar` and runs `docker compose up -d rabot` there. The site must be served over HTTPS (or
localhost): AudioWorklet only works in a secure context. `nginx.conf` serves `/audio-worklets.js` with
`no-cache` because its URL isn't content-hashed.
