# motion-lab

Animation videos the user previews, tweaks, and exports.

- **The editor** (`motion`, since 2026-10-25): an After Effects-style editor in the browser.
  Claude writes a project as JSON, the user adjusts it by hand (timeline, canvas, inspector), and
  it exports MP4/WebM/GIF in 16:9 and 9:16. New videos go here.

## Start here (Claude)

This is a cross-platform copy of motion-lab, usually on Windows. To make or change a video,
read `share/skill/SKILL.md` (setup also installs it as the `motion` skill in
`~/.claude/skills/motion`); it has the whole build-script API (`MOTION_LAB_DIR` there means this folder). This file covers
the rest.

| Path | What |
|---|---|
| `projects/NAME/build.py` | a video, as a short Python script you write (examples: `quicksort`, `binary-search`) |
| `projects/NAME/project.json` | what build.py outputs and the editor edits; `assets/` audio/images, `exports/` renders |
| `motionlab/build.py` | the API build scripts import (`Scene`, kits like `array`, `code`) |
| `motionlab/` | the rest of the Python side: server, CLI, export, Kokoro TTS, lint |
| `editor/src/` | the browser editor (Preact + TypeScript); `editor/dist/` is the prebuilt copy it serves |
| `models/` | Kokoro voice files, downloaded by setup (gitignored) |
| `setup.cmd`, `share/setup.ps1` | Windows install; `Open Motion Lab.cmd` starts the editor |

On Windows: the `motion` command is in `%USERPROFILE%\.local\bin`. Use it from Claude Code's
shell as-is (`motion build NAME --check`). If it is missing, the user hasn't run `setup.cmd`.
Never start the editor (`motion` or `motion NAME`) yourself: it opens their browser. Building
`editor/` needs Node; without it, the shipped `editor/dist` is used.

## How Claude makes a video

Write `projects/NAME/build.py` with `motionlab/build.py` (the `motion` skill in
`~/.claude/skills/motion` is the reference), then `motion build NAME --check` and read the
contact sheets in `projects/NAME/.check/`. Never hand-write project.json or GSAP for new videos.
Measured 2026-10-25 on the same quicksort video: build script 1.3k tokens, hand GSAP 3.7k,
JSON generator 5.0k, raw project.json 14.2k. `save()` refuses to overwrite a project the user
edited in the editor (`.build-hash`); add kits/methods to build.py when something repeats.
`motionlab/lint.py` flags off-stage items, partial overlaps (groups = union of children),
late tweens, and narration problems.

## Running it

- `motion [project]` starts the server on 127.0.0.1:3790 and opens it in the browser. If it is already
  running it just opens the tab. `--no-open` skips the browser, `--build` forces a frontend rebuild.
  It rebuilds `editor/dist` by itself when `editor/src` is newer.
- Installed as a uv tool in editable mode (`uv tool install -e .`). Python deps are in `pyproject.toml`.
- Frontend dev: run `motion --no-open`, then `npm run dev` in `editor/` (Vite proxies `/api` and
  `/projects` to :3790). `npm run check` typechecks.
- Testing: render pages headless with Playwright (its own Chromium, or system chromium if on PATH) (`render.html?project=X&aspect=wide`
  exposes `window.__motion.seek(t)`), never open a visible window. Kill test servers after.

## Layout

- Video import (`media.import_video`): uploads stream to disk, then ffmpeg makes an editing copy
  (H.264, long side ≤ 1920, keyframe every 10 frames, no B-frames, rotation applied), a 48 kHz
  wav of its sound, and a 40-frame thumbnail strip for the timeline. The original is deleted.
  Export seeks the `<video>` per frame and waits for `seeked` (`Player.seekFrame`), ~22 ms/frame.
- `motionlab/server.py`: FastAPI. Projects CRUD, `/events` SSE (mtime of project.json, so the
  editor reloads when Claude edits the file while it is open), asset upload (mic takes are
  cleaned to -16 LUFS wav), `/tts` (Kokoro in a subprocess, cached by text+voice+speed),
  export jobs.
- `motionlab/export.py`: headless chromium seeks `render.html` frame by frame, CDP fast PNG
  screenshots into ffmpeg. 1105 frames at 1080p takes ~100 s. `media.mix()` mixes the audio
  tracks with the same linear gains/fades the editor plays.
- `motionlab/tts.py`: Kokoro from `models/` in the repo (override `KOKORO_MODELS`),
  loads per call and exits.
- `editor/src/player.ts`: the renderer shared by editor and export. **No live GSAP timeline**:
  every frame is computed from the tween list (GSAP only supplies eases and color mixing),
  so seeking is exact in any order.
- `editor/src/state.ts` (signals, undo, autosave, playback), `ops.ts` (layout per aspect,
  grouping, presets), `audio.ts` (WebAudio preview), `recorder.ts` (mic), `ui/*`.
- Preact 10, not 11: Preact 11 drops automatic `px` on numeric styles and the whole UI collapses.

## Project format (`projects/<name>/project.json`)

Saved one element/tween/clip per line. Writing a project = writing this file (a throwaway
Python script that builds it is fine; voice narration first via `POST /api/projects/<name>/tts`
so beats can be placed against real line lengths). Assets go in `projects/<name>/assets/`.

```
{ version: 1, name, duration (s), background (any CSS), elements: [], tweens: [], audio: [], muted?: [track], folders?: [] }
```

**Folders** `[{ id, name }]` (top of the layers panel first) only organize the layers panel and
timeline; they never change the picture. A root element joins one with `folder: id`; group
children follow their group. Use one per scene (or Title / Array / Captions). The timeline
shows each folder as a span you can drag to shift that whole scene in time.

**Elements** (`elements` order = paint order, later on top):
`{ id, type: text|rect|ellipse|path|image|group, name, parent?: groupId, folder?: folderId, hidden?, locked?, props, tall? }`

- `props.x/y` is the element's CENTER, relative to the parent group's top-left (or the stage).
  `w/h` size. Optional: `rotation` (deg), `scale`, `opacity`, `fill`, `stroke`, `strokeWidth`,
  `radius`, `glow` (px, in the element's own color).
- text: `text` (`\n` new lines, `[[#hex|words]]` colors words), `font` (Unbounded, IBM Plex Sans,
  JetBrains Mono, Inter, Space Grotesk; bundled, see `fonts.ts` for weights), `size`, `weight`,
  `color`, `align`, `lineHeight`, `letterSpacing` (em), `reveal`: rise|fade|type|blur.
- path: `d`, `viewBox` (default `0 0 w h`). image: `src` (`assets/...`), `fit`.
- video: `src` (the editing copy), `fit` (default cover), plus `clip: { start, offset, dur, srcDur,
  volume, muted?, audio?, thumbs? }` on the element (not in props: timing is the same in both
  aspects). It is only on screen from `start` to `start + dur`, showing the file from `offset`.
  Its `audio` wav is mixed like a track clip (editor `allClips()`, export `media.mix()`).
  Tweens work on videos like on anything else.
- `tall` holds 9:16 overrides of any props. Stage is 1920x1080 wide, 1080x1920 tall. Put
  things that must reflow (an array of bars) in a group and give the GROUP a tall x/y/scale,
  so children and their tweens need no overrides. Root-level text needs a tall `x` (540) or it
  sits off-screen in 9:16.

**Tweens**: `{ id, target, start, dur, ease, props: { prop: [from|null, to] } }`

- Props: `x y` (offset px from the layout position), `scale` (× rest), `rotation` (+deg),
  `opacity` (× rest), `blur`, `w h` (absolute px), `fill color stroke` (colors), `glow`,
  `draw` (0..1 of a path's stroke), `reveal` (0..1 of a text's characters).
- `from: null` = whatever the value is when the tween starts. Before a property's first tween
  starts, it holds that tween's `from` (so `opacity [0,1]` at 2 s means hidden until 2 s).
  After that, the most recently started tween owns the value.
- `ease`: any GSAP ease string (`power3.out`, `back.out(1.7)`, `steps(6)`, `none`).

**Audio clips**: `{ id, track: narration|voice|music|sfx, src, start, offset (trim), dur, srcDur,
volume (linear), fadeIn, fadeOut, name?, text?, voice?, speed?, voiced? }`. Narration clips carry
`text/voice/speed`; `voiced` is the text `src` was made from (the editor flags a re-voice when
they differ). Voice used so far: `bm_george` at 1.1.

## Projects

- `binary-search`: 28 s, array + C++ code kit, written from the skill alone as its test.
- `quicksort`: 35.5 s narrated explainer (rebuilt from `build.py` 2026-10-25) (8 Kokoro lines). Lomuto partitions on
  [6,3,8,1,9,2,7,4], pivot tag and range bracket hop between steps, captions per line,
  16:9 + 9:16, folders Title / Array / Captions. Built 2026-10-25 as the editor's demo. Exports in `projects/quicksort/exports/`
  (gitignored).

