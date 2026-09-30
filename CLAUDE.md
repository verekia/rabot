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
- `src/engine.ts`: loading, the background measurement loop, and export. Measurement waits until every
  track has loaded, because the tone-match reference (`SetProfile` in the store) is the median over all
  tracks. The profile follows the tracks until the first export, then it's locked and persisted, so later
  single-track exports stay consistent. Don't make it follow the tracks after that.
- `src/buffers.ts`: decoded audio isn't kept on tracks (about 85 MB per song). Always go through
  `getBuffer(id, file)`, a small LRU of decode promises. Tracks keep only `duration`, `peaks` and analyses.
- `src/player.ts`: preview voice with a processed path and a loudness-matched original path for A/B.
- `src/store.ts`: zustand store. The three global dials and the locked tone reference persist to
  localStorage. There are deliberately no per-track settings: the same three dials apply to the whole set.

## Gotchas

- Don't swap the custom `dynamics` worklet back to `DynamicsCompressorNode`. Measured on real tracks, the
  native node barely changes peak-to-loudness ratio, and it adds automatic makeup gain.
- Dynamics sits **before** the tone EQ on purpose: its threshold is relative to the −18 LUFS normalized
  level, and EQ would shift that per track.
- Worklet processors return `true` from `process()` and so never die on their own. `Chain.disconnect()`
  sends them `{ stop: true }` so they return `false`; skipping that leaks a processor per play/seek and
  its stale meter reports overwrite the live ones.
- In dev, `window.__rabot` exposes store and pipeline helpers for console testing.

## Deployment

`./deploy.sh` builds an arm64 image (static export served by nginx, see `Dockerfile` / `nginx.conf`), copies
it to `midgar` and runs `docker compose up -d rabot` there. The site must be served over HTTPS (or
localhost): AudioWorklet only works in a secure context. `nginx.conf` serves `/audio-worklets.js` with
`no-cache` because its URL isn't content-hashed.
