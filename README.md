# Rabot

Evens out a set of backing tracks for live playback. Drop in your MP3s, preview the result, and export
44.1 kHz / 24-bit WAVs (all as a ZIP, or one track at a time). The goal is a playlist with no jumps in
level, punch or tone from one song to the next, not maximum digital loudness.

Everything runs in the browser with the Web Audio API. The preview and the export use the same
processing graph, so what you hear is what you download.

```bash
bun install
bun dev
```

## Controls

Two dials, applied to every track:

- **Loudness**: the integrated loudness (LUFS, ITU-R BS.1770) every track is matched to.
- **Dynamics**: tames transients that stick out above a track's own loudness, so percussive or
  dynamic mixes get pulled in and already-dense masters are left alone. Off (0%) by default.

Under each dial, a small bar shows what it's doing to the song that's playing (or selected): the gain
applied, and the live transient reduction.

Drag a dial vertically (hold Shift for fine steps), or use the arrow keys; double-click resets it.

Keyboard shortcuts: Space plays or pauses, B toggles A/B (processed vs. the loudness-matched original),
and ↑/↓ change the selected track. Playback continues into the next track, like the live set would.

## How it works

1. **On add (once per track):** each file is decoded and analyzed into a signature: its loudness, true
   peak, spectrum, and a 10 ms level profile. Several tracks are analyzed at a time; 30 songs take about
   8 seconds.
2. **While you tweak:** nothing is re-rendered. The preview is real-time Web Audio processing, and each
   track's gain for the loudness target is predicted from its signature by simulating the dynamics and
   the limiter on the level profile. Every dial change is instant. The prediction is typically within
   0.1–0.3 dB of the real result.
3. **On export:** each track is rendered through the full chain, measured, and corrected if it missed the
   target by more than 0.05 dB, so exported files are exact. Rendering runs in parallel Web Workers using
   the same compressor and limiter code as the preview; 30 songs export in about 30 seconds.

Tone match (pulling each track's EQ toward the set's average) is disabled for now: the EQ stays flat.

## Replacing one song later

Drop a single file on a track (or select it and click Replace) to swap its source, for example a better
mix, while keeping its place. Then export only that one: with the same dials it gets the same processing
as the rest of the set.

## Processing chain

```
decode → 44.1 kHz stereo → normalize to −18 LUFS → 25 Hz high-pass → dynamics → tone EQ → gain → limiter
```

1. **Normalize**: sets the input loudness to a fixed reference so the dynamics stage behaves the same on
   every track.
2. **Dynamics**: stereo-linked lookahead (3 ms) peak compressor with a soft knee. Its threshold sits
   14 → 6 dB above the track's loudness depending on the dial.
3. **Tone EQ**: low shelf, two peaking bands and a high shelf (flat while tone match is disabled).
4. **Gain**: brings the track to the loudness target (predicted while previewing, measured and corrected
   on export).
5. **Limiter**: lookahead true-peak limiter (4× oversampled detector) with a −1 dBTP ceiling. It
   doesn't overshoot or clip. A track shows its peak limiting only when it's 0.5 dB or more: green is
   inaudible, amber is fine, red means raise Dynamics or lower the Loudness target.

Every exported file is measured again after rendering. The ✓ next to a track means its last export
landed on target at the current settings.
