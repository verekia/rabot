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

Three dials, applied to every track:

- **Loudness**: the integrated loudness (LUFS, ITU-R BS.1770) every track is matched to.
- **Dynamics**: tames transients that stick out above a track's own loudness, so percussive or
  dynamic mixes get pulled in and already-dense masters are left alone.
- **Tone match**: moves each track's spectral balance part of the way toward the set's median.

Drag a dial vertically (hold Shift for fine steps), or use the arrow keys; double-click resets it.

Keyboard shortcuts: Space plays or pauses, B toggles A/B (processed vs. the loudness-matched original),
and ↑/↓ change the selected track. Playback continues into the next track, like the live set would.

## Analysis

When you add tracks, they're analyzed automatically (loudness, peaks, spectral balance), then each one is
measured through the processing chain. A progress bar shows where it's at; 30 songs take about a minute.
You can preview right away. Changing a dial re-measures in the background ("Updating…") while the preview
follows instantly.

## Replacing one song later

Drop a single file on a track (or select it and click Replace) to swap its source, for example a better
mix, while keeping its place. Then export only that one.

The tone reference (the set's average spectral balance that Tone match pulls toward) follows your tracks
until your first export. Then it's locked and saved in the browser, together with the dials. A song
exported later, even alone and in another session, gets exactly the same processing as the rest of the
set. When the current tracks differ from the reference, a notice says so, with a button to rebuild the
reference from them instead.

## Processing chain

```
decode → 44.1 kHz stereo → normalize to −18 LUFS → 25 Hz high-pass → dynamics → tone EQ → gain → limiter
```

1. **Normalize**: sets the input loudness to a fixed reference so the dynamics stage behaves the same on
   every track.
2. **Dynamics**: stereo-linked lookahead (3 ms) peak compressor with a soft knee. Its threshold sits
   14 → 6 dB above the track's loudness depending on the dial.
3. **Tone EQ**: low shelf, two peaking bands and a high shelf, solved so each band (bass, low mid,
   presence, air) moves by the requested amount relative to the mids.
4. **Gain**: after steps 1–3 the track is rendered offline and measured, and the exact gain to hit the
   loudness target is applied. If the limiter has real work to do, the full chain is rendered again and
   the gain is corrected until the output lands on target.
5. **Limiter**: lookahead true-peak limiter (4× oversampled detector) with a −1 dBTP ceiling. It
   doesn't overshoot or clip. A track shows its peak limiting only when it's 0.5 dB or more: green is
   inaudible, amber is fine, red means raise Dynamics or lower the Loudness target.

Every exported file is measured again after rendering. The ✓ next to a track means its last export
landed on target at the current settings.
