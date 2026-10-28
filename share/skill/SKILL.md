---
name: motion
description: Make animated explainer videos (algorithm and code explainers, Shorts, anything "GSAP style") with motion-lab by writing a short Python build script, never hand-written GSAP/JS. Use whenever asked to make, change, or export a video, animation, explainer, or short, or anything in MOTION_LAB_DIR. Triggers: "make a video", "animate", "explainer", "short", "motion", "motion-lab", "export the video".
---

# motion: a video is a ~3 KB Python script

Repo: `MOTION_LAB_DIR`. A project is `projects/NAME/` with `build.py` (yours),
`project.json` (output, also what the user edits in the editor), `assets/`, `exports/`.

## Loop

1. `motion new NAME`: writes a template `projects/NAME/build.py`.
2. Write the script. Narrate first: line timings drive every animation.
3. `motion build NAME --check`: builds, voices new lines (Kokoro, cached), prints line timings
   and lint, writes `projects/NAME/.check/wide.png` and `tall.png` (a frame at 75% through each
   line, plus the end). **Read both sheets**, fix, rebuild. Only changed lines are re-voiced.
   `motion check NAME --at 3.2,7.5` looks at specific times.
4. the user tweaks with `motion NAME` (editor). After that, `save()` refuses to overwrite his edits:
   change `project.json` directly (format: motion-lab `CLAUDE.md`) or ask before `force=True`.
5. `motion export NAME [--aspect wide|tall|both] [--format mp4|webm|gif] [--fps 30]`
   writes `projects/NAME/exports/`. About 2-3 min per aspect for 35 s of video; run it once, at the end.
All of it runs headless on a private port. Never open windows; never run `motion NAME` yourself.

## API (`from motionlab.build import *`)

```python
s = Scene("name", bg="glow"|"flat"|"dusk"|css, voice="bm_george", speed=1.1, captions=True)
L = s.narrate(["line", ("said", "caption shown"), {"say": "...", "gap": .6, "pause": 1.5}], gap=.35)
#   -> Lines in order after the last one. Line: .start .end .dur .at(0.5) .word("pivot", nth=1)
s.wait(sec)                                  # silence before the next narrate()
s.music(file, at=0, volume=.25); s.sfx(file, at, volume=.8)

with s.folder("Scene 2"): ...                # organizes layers + timeline only
with s.group("Name", w, h, pos, tall={...}) as g: ...   # children use px/fractions of w,h;
                                             # in 9:16 it scales to fit width unless tall["scale"]
e = s.text(txt, style, pos, w=None, color=None, align="center", tall={...}, reveal="rise|fade|type|blur")
e = s.rect(pos, w, h, fill="purple", radius=16)  ·  s.circle(pos, d, fill)
e = s.path(d, pos, w, h, stroke, width)  ·  s.arrow(a, b, color)  ·  s.image(file, pos, w=.5)
e = s.video(file, at=0, fill=True, trim=0, dur=None, volume=1, mute=False)
s.save(tail=1.5)                             # duration = last thing + tail
```

- **pos**: spot name `top sub upper center lower bottom left right` (different spots in 9:16;
  left/right stack vertically there), or `(x, y)`: values <= 1 are fractions of the parent box,
  > 1 are px. `w`/`h` work the same way. `tall={"pos":..., "w":..., "size":..., any prop}`
  overrides 9:16 only. Root text and spots lay out both aspects automatically.
- **styles**: title big h1 h2 body caption small label mono num (font, size per aspect, color).
  `size=` overrides. `[[pink|word]]` or `[[#hex|word]]` colors words inside any text.
- **colors** by name anywhere: text muted dim panel purple pink rose cyan green blue yellow
  white none (palette in `C`), or any CSS color.

Every element method takes the start time first and returns its end time:
`fade_in fade_out pop_in pop_out blur_in slide_in(at, dx, dy) reveal(at, dur=auto) draw
move(at, x, y) shift(at, dx, dy) color(at, c) glow(at, px) scale(at, k) pulse spin dim(at, to)
size(at, w, h) show hide tween(at, dur, ease, **props)`.
- `move` x/y are offsets from the layout spot (0, 0 = home). The first tween of a property
  holds its "from" before it starts, so `fade_in(5)` means hidden until 5 s.
- Raw `tween` props: x y scale rotation opacity blur w h fill color stroke glow draw reveal,
  each a target value or a `(from, to)` tuple; `None` from = current. Eases: GSAP strings, or
  "in" "out" "move" "pop".

## Kits

```python
a = s.array([6,3,8,1,9,2,7,4], pos=(.5,.55))   # bars + values; slots 0..n-1
a.show(t) · a.color(slots, c, t, gap=0) · a.glow(slots, px, t) · a.lift(sl, t) · a.drop(sl, t)
a.arrange(new_order, t, dur, gap)  # slot k <- bar now at slot new_order[k]; tags ride along
a.swap(i, j, t) · a.tag(sl, "pivot", t) · a.untag("pivot", t) · a.bracket(lo, hi, t) · a.unbracket(t)
a.label(text, lo, hi, t, color) · a.dim(slots, t) · a.undim(slots, t) · a.wave(t)
a.value(sl) · a.order · a.g (the group, e.g. a.g.fade_out(t))

c = s.code(src, pos, size=34, lang="cpp"|"py"|"js")   # syntax colors on a panel
c.show(t, typed=False) · c.highlight(line, t) · c.unhighlight(t)
```

A full narrated example: `projects/quicksort/build.py` (35 s, both aspects, about 80 lines).

## Rules

- Write a build script, never project.json by hand and never GSAP for new videos. Add a kit
  or a method to `motionlab/build.py` when a video needs something reusable.
- Use the named palette colors (`C`); avoid orange and tan.
- Check both sheets before telling the user it's done. Lint lines (`!`) must be fixed or explained.
