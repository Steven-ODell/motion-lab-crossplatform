# motion-lab (cross-platform)

Animated explainer videos (vector shapes, text, code, narration) built from short Python
scripts, with a browser editor for tweaking and MP4/WebM/GIF export in 16:9 and 9:16.
Works on Windows and Linux.

## Setup on Windows 10/11

Once, about 10 minutes, roughly 1.5 GB of downloads (Chromium, the voice model, Python deps).

1. Get the folder: `git clone https://github.com/Steven-ODell/motion-lab-crossplatform`,
   or Code > Download ZIP and unzip it somewhere permanent (e.g. `Documents\motion-lab`).
   The install points at this folder, so don't move it afterwards.
2. Double-click `setup.cmd`. It uses winget to install uv, ffmpeg and ImageMagick, then
   installs the `motion` command, headless Chromium and the Kokoro narration voice.

On Linux: install uv, ffmpeg and ImageMagick with your package manager, then
`uv tool install -e .` and `uv tool run --from . python -m playwright install chromium`, and
put `kokoro-v1.0.onnx` and `voices-v1.0.bin` from
[kokoro-onnx model-files-v1.0](https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0)
in `models/`.

## Use

- Double-click `Open Motion Lab.cmd` (or run `motion`). The editor opens in your browser at
  http://127.0.0.1:3790. Closing that black window stops it.
- Videos live in `projects\`, exports in `projects\NAME\exports\`. Two examples are included:
  `quicksort` and `binary-search`.

## With Claude Code (the cheap way to make videos)

`setup.cmd` also installs a `motion` skill into `%USERPROFILE%\.claude\skills`. Ask Claude Code
"make a video about X": it writes `projects/X/build.py`, a short Python script, checks preview
frames, and you tweak the result in the editor. Then "export it" makes the MP4. A build script
costs about a third of the tokens of hand-written animation code.

Claude finds its way around from `CLAUDE.md` (repo map, project format) and
`share/skill/SKILL.md` (how to write a video). Start Claude Code in this folder.

## Commands

| Command | Does |
|---|---|
| `motion` | open the editor |
| `motion new NAME` | start a project from a template |
| `motion build NAME --check` | build, voice the narration, write preview sheets |
| `motion export NAME --aspect both --format mp4` | export the video |
