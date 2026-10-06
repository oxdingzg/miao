<!--
  Built-in skill. Name and description are registered in code at
  packages/core/src/plugin/skill.ts (V2) and packages/miao/src/skill/index.ts
  (V1). The body below becomes the skill's content.
-->

# Media observation

You cannot watch a video and you cannot listen to audio. You can read images.
Turn media into timestamped contact sheets with ffmpeg, read those sheets, and
base every claim about the content on a frame you have actually seen — never
answer from the filename, the metadata or imagination.

Use when the user provides a video or asks for one to be understood, edited,
QC'd or referenced: finding moments, building a cut, checking a render,
summarizing footage.

## Output contract

One workspace, known names, so a rerun never redoes work:

- `out/media.json` — probe result
- `out/sheets/` — whole-media contact sheets
- `out/segments/` — high-fps re-checks of candidate moments
- `out/qc.json` — QC findings for a render

Decisions come from sheets; a candidate moment gets one high-fps re-watch
before it is acted on; the transcript of what was done lands in `out/`.

## Environment doctor

Run once per workspace before any extraction, and save the verdict to
`.media-env.json` so later steps can trust it instead of re-deriving it:

```sh
ffmpeg -hide_banner -encoders 2>/dev/null | grep -E "libx264|aac"        # encode path exists?
ffmpeg -hide_banner -filters 2>/dev/null | grep -E "drawtext|tile|subtitles"   # compose path exists?
fc-list :lang=zh family | head -5                                        # any real CJK face installed?
```

`drawtext` with a Chinese sample must be rendered and looked at once: a font
that `fc-list` reports can still miss the exact glyphs, and `fc-match` lies by
substituting happily. A burned-in timestamp or subtitle that renders as tofu
boxes passes every exit code and fails the user. Missing encoder or CJK face →
say what is missing and stop before burning an hour into a render that cannot
work.

## Probe first

```sh
ffprobe -v error -print_format json -show_format -show_streams input.mp4 > out/media.json
```

Read duration, resolution, fps and audio presence from it; every later number
(start times, fps choices) comes from here, not from a guess.

## Ingest the whole media

Deterministic frame extraction into sheets, timestamps burned onto each cell:

```sh
mkdir -p out/sheets
# ~1 frame per 10 s, 4x5 grid per sheet; scale first so cells stay uniform.
ffmpeg -hide_banner -i input.mp4 -vf "fps=1/10,scale=480:-1,drawtext=text='%{pts\:hms}':x=8:y=8:fontsize=24:fontcolor=white:box=1:boxcolor=black@0.6,tile=4x5:margin=6:padding=6" -frames:v 100 out/sheets/sheet_%03d.jpg
```

- Short clips (< 2 min): raise density (`fps=1/3`); long footage: lower it and
  let scene detection add key frames:
  `-vf "select='gt(scene,0.25)',showinfo,scale=480:-1,..."` (read the pts from
  showinfo stderr for ordering).
- Read every sheet with the image reader. Note timestamps as `mm:ss` from the
  burned labels; say the sheet cell when it matters.
- One pass, then decide. Do not re-ingest at higher density without a reason
  from the first pass.

## Re-watch a candidate moment

One segment, higher fps, same burned timestamps:

```sh
ffmpeg -hide_banner -ss 00:12:30 -to 00:12:50 -i input.mp4 -vf "fps=3,scale=640:-1,drawtext=text='%{pts\:hms}':x=8:y=8:fontsize=24:fontcolor=white:box=1:boxcolor=black@0.6,tile=3x4" out/segments/seg_001230.jpg
```

Batch several candidate segments as separate commands before reading, so a
single pass of reading covers all of them.

## QC a render you produced

Never accept your own render from its exit code. Ingest the render through the
same sheets pipeline and look, then run the deterministic detectors and put
their findings in `out/qc.json`:

```sh
ffmpeg -hide_banner -i out/preview.mp4 -vf "blackdetect=d=0.5:pic_th=0.95,freezedetect=n=0.003:d=2" -an -f null - 2>&1 | grep -E "blackdetect|freezedetect"
ffmpeg -hide_banner -i out/preview.mp4 -af "silencedetect=n=-40dB:d=2" -f null - 2>&1 | grep silencedetect
```

Black lead-in, frozen tail or a silent audio track are findings to report, not
errors to crash on.

## Speech and audio

Sheets show pictures, not words. If the task needs dialogue, transcribe it
first with whatever transcription tooling the user has configured; without
one, say so and work from the visual record — do not invent lines. Silence
gaps from `silencedetect` are honest evidence of speech boundaries when no
transcriber exists.
