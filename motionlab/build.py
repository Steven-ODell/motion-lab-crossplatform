"""Write motion-lab projects in a few lines of Python.

    from motionlab.build import *
    s = Scene("demo")
    L = s.narrate(["Hello there.", "This is a pivot."])
    t = s.text("Hello", "title", "top"); t.reveal(L[0].start)
    s.save()

Positions are fractions of the parent box (stage or group) when <= 1, pixels
otherwise, and are computed for 16:9 and 9:16 separately, so one script makes
both layouts. Every animation method takes the start time first and returns
its end time. See the `motion` skill for the full reference.
"""
import contextlib
import hashlib
import json
import math
import pathlib
import re
import shutil

from . import media, store, tts

SIZE = {"wide": (1920, 1080), "tall": (1080, 1920)}

C = {
    "bg": "#0d0b14", "text": "#e6e1f2", "muted": "#8d84a3", "dim": "#4a4166", "panel": "#1c1828", "line": "#2a2438",
    "purple": "#b07cf5", "pink": "#ff5ef1", "rose": "#ff5ea0", "cyan": "#5ef1ff", "green": "#5eff6c", "blue": "#5ea1ff",
    "yellow": "#f1ff5e", "white": "#ffffff", "black": "#000000", "none": "rgba(0,0,0,0)",
}
BG = {
    "glow": "radial-gradient(ellipse at 50% 30%, #241b3a 0%, #120e1c 48%, #0a0810 100%)",
    "flat": "#0d0b14",
    "dusk": "linear-gradient(180deg, #1a1030 0%, #0d0b14 70%)",
    "black": "#000000",
}
# style: font, weight, size in 16:9, size in 9:16, color, line height
STYLES = {
    "title": ("Unbounded", 800, 92, 120, "text", 1.1),
    "big": ("Unbounded", 800, 160, 190, "text", 1.0),
    "h1": ("Unbounded", 800, 68, 88, "text", 1.15),
    "h2": ("Unbounded", 600, 50, 64, "text", 1.2),
    "body": ("Inter", 600, 44, 56, "text", 1.3),
    "caption": ("Inter", 600, 48, 60, "text", 1.25),
    "small": ("Inter", 400, 32, 40, "muted", 1.3),
    "label": ("JetBrains Mono", 600, 34, 42, "cyan", 1.1),
    "mono": ("JetBrains Mono", 400, 36, 44, "text", 1.35),
    "num": ("Unbounded", 600, 46, 46, "text", 1.0),
}
# named spots: (16:9 fraction, 9:16 fraction). left/right stack vertically in 9:16.
SPOTS = {
    "top": ((.5, .12), (.5, .16)), "sub": ((.5, .21), (.5, .235)), "upper": ((.5, .32), (.5, .32)),
    "center": ((.5, .5), (.5, .5)), "lower": ((.5, .7), (.5, .66)), "bottom": ((.5, .9), (.5, .8)),
    "left": ((.27, .52), (.5, .36)), "right": ((.73, .52), (.5, .66)),
}
CAPTION_SPOT = ((.5, .915), (.5, .8))
EASE = {"in": "power2.out", "out": "power2.in", "move": "power3.inOut", "pop": "back.out(1.7)"}


def col(c):
    return C.get(c, c) if isinstance(c, str) else c


def _slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:24] or "el"


def _est_lines(text, size, w, mono=False):
    plain = re.sub(r"\[\[[^|\]]+\|(.*?)\]\]", r"\1", text)
    per = max(1, int(w / (size * (0.6 if mono else 0.53))))
    return sum(max(1, math.ceil(len(p) / per)) for p in plain.split("\n"))


class E:
    """Handle to one element. Every method: start time first, returns end time."""

    def __init__(self, scene, d):
        self.s, self.d, self.id = scene, d, d["id"]
        self.ox = self.oy = 0.0  # current move offsets, for shift()

    def __repr__(self):
        return f"<{self.d['type']} {self.d['name']}>"

    def tween(self, at, dur=0.5, ease="power2.out", **props):
        """Raw tween. Each prop is a target value or a (from, to) pair; None
        as from means 'whatever it is then'. Colors may be names from C."""
        out = {}
        for k, v in props.items():
            f, t = v if isinstance(v, tuple) else (None, v)
            out[k] = [col(f), col(t)]
        self.s.tweens.append({"id": self.s._id("t"), "target": self.id, "start": round(at, 3), "dur": round(dur, 3),
                              "ease": EASE.get(ease, ease), "props": out})
        return round(at + dur, 3)

    # entrances / exits
    def fade_in(self, at, dur=0.5): return self.tween(at, dur, "power2.out", opacity=(0, 1))
    def fade_out(self, at, dur=0.4): return self.tween(at, dur, "power2.in", opacity=(None, 0))
    def pop_in(self, at, dur=0.55): return self.tween(at, dur, "back.out(1.7)", scale=(0, 1))
    def pop_out(self, at, dur=0.35): return self.tween(at, dur, "back.in(1.7)", scale=(None, 0))
    def blur_in(self, at, dur=0.8): return self.tween(at, dur, "power2.out", blur=(24, 0), opacity=(0, 1))

    def slide_in(self, at, dx=0, dy=60, dur=0.7):
        p = {"opacity": (0, 1)}
        if dx: p["x"] = (dx, 0)
        if dy: p["y"] = (dy, 0)
        return self.tween(at, dur, "power3.out", **p)

    def reveal(self, at, dur=None):
        """Type/rise the text in (style set by the element's `reveal` prop)."""
        if dur is None:
            dur = min(2.5, 0.35 + 0.03 * len(self.d["props"].get("text", "")))
        return self.tween(at, dur, "none", reveal=(0, 1))

    def draw(self, at, dur=1.2, ease="power1.inOut"): return self.tween(at, dur, ease, draw=(0, 1))

    # changes
    def move(self, at, x=None, y=None, dur=0.7, ease="power3.inOut"):
        """Move to offset (x, y) px from the layout position (0, 0 = home)."""
        p = {}
        if x is not None: p["x"], self.ox = (None, x), x
        if y is not None: p["y"], self.oy = (None, y), y
        return self.tween(at, dur, ease, **p)

    def shift(self, at, dx=0, dy=0, dur=0.7, ease="power3.inOut"):
        return self.move(at, self.ox + dx if dx else None, self.oy + dy if dy else None, dur, ease)

    def color(self, at, c, dur=0.3):
        prop = {"text": "color", "path": "stroke"}.get(self.d["type"], "fill")
        return self.tween(at, dur, "power1.inOut", **{prop: c})

    def glow(self, at, px=20, dur=0.4): return self.tween(at, dur, "power2.out", glow=px)
    def scale(self, at, k, dur=0.4, ease="back.out(2)"): return self.tween(at, dur, ease, scale=k)
    def spin(self, at, deg=360, dur=1.0): return self.tween(at, dur, "power2.inOut", rotation=deg)
    def dim(self, at, to=0.3, dur=0.3): return self.tween(at, dur, "power1.inOut", opacity=to)
    def size(self, at, w=None, h=None, dur=0.6, ease="power3.out"):
        p = {}
        if w is not None: p["w"] = w
        if h is not None: p["h"] = h
        return self.tween(at, dur, ease, **p)

    def pulse(self, at, k=1.15):
        self.tween(at, 0.16, "power2.out", scale=k)
        return self.tween(at + 0.16, 0.3, "power2.inOut", scale=1)

    def show(self, at):
        """Appear instantly at `at` (hidden before)."""
        return self.tween(at, 0.01, "none", opacity=(0, 1))

    def hide(self, at): return self.tween(at, 0.01, "none", opacity=(None, 0))


class Line:
    """A voiced narration line placed on the timeline."""

    def __init__(self, say, show, start, dur):
        self.say, self.show, self.start, self.dur = say, show, round(start, 3), dur
        self.end = round(start + dur, 3)

    def at(self, f):
        """Time at fraction f (0..1) through the line."""
        return round(self.start + f * self.dur, 3)

    def word(self, w, nth=1):
        """Rough time a word is spoken (by character position in the line)."""
        i = -1
        for _ in range(nth):
            i = self.say.lower().find(w.lower(), i + 1)
            if i < 0:
                raise ValueError(f"{w!r} not in line {self.say!r}")
        return self.at(i / max(1, len(self.say)))

    def __repr__(self):
        return f"<Line {self.start:.2f}-{self.end:.2f} {self.say[:30]!r}>"


class Scene:
    def __init__(self, name, bg="glow", voice="bm_george", speed=1.1, captions=True, lead_in=0.6):
        self.name = name
        self.folder_path = store.project_dir(name)
        self.bg = BG.get(bg, bg)
        self.voice, self.speed, self.captions = voice, speed, captions
        self.elements, self.tweens, self.audio, self.folders = [], [], [], []
        self.lines: list[Line] = []
        self.cursor = lead_in  # where the next narration line goes
        self._n = {}
        self._folder = None
        self._groups = []  # stack of (id, w, h)
        self._ids = set()

    # ---------------------------------------------------------------- ids
    def _id(self, prefix):
        n = self._n.get(prefix, 0) + 1
        self._n[prefix] = n
        return f"{prefix}{n}"

    def _el_id(self, name):
        base = _slug(name)
        i, cand = 1, base
        while cand in self._ids:
            i += 1
            cand = f"{base}-{i}"
        self._ids.add(cand)
        return cand

    # ---------------------------------------------------------- placement
    def _box(self, aspect):
        if self._groups:
            _, w, h = self._groups[-1]
            return w, h
        return SIZE[aspect]

    def _xy(self, pos, aspect):
        if isinstance(pos, str):
            if self._groups:
                pos = SPOTS[pos][0]
            else:
                pos = SPOTS[pos][0 if aspect == "wide" else 1]
        bw, bh = self._box(aspect)
        x, y = pos
        return (x * bw if abs(x) <= 1 else x, y * bh if abs(y) <= 1 else y)

    def _len(self, v, aspect, axis=0):
        if v is None:
            return None
        return v * self._box(aspect)[axis] if abs(v) <= 1 else v

    def _add(self, type, name, wide, tall=None, **extra):
        d = {"id": self._el_id(name), "type": type, "name": name, "props": {k: v for k, v in wide.items() if v is not None}}
        if self._groups:
            d["parent"] = self._groups[-1][0]
        elif self._folder:
            d["folder"] = self._folder
        if tall:
            diff = {k: v for k, v in tall.items() if v is not None and d["props"].get(k) != v}
            if diff:
                d["tall"] = diff
        d.update(extra)
        self.elements.append(d)
        return E(self, d)

    def _layout(self, pos, w, h, tall):
        """x, y, w, h for both aspects. Inside a group the group scales for 9:16,
        so children share one layout unless `tall` says otherwise."""
        tall = dict(tall or {})
        out = {}
        for a in ("wide", "tall"):
            p = tall.get("pos", pos) if a == "tall" else pos
            ww = tall.get("w", w) if a == "tall" else w
            hh = tall.get("h", h) if a == "tall" else h
            x, y = self._xy(p, a)
            out[a] = {"x": round(x, 1), "y": round(y, 1), "w": round(self._len(ww, a, 0), 1), "h": round(self._len(hh, a, 1), 1) if hh is not None else None}
        extra = {k: v for k, v in tall.items() if k not in ("pos", "w", "h")}
        return out["wide"], {**out["tall"], **extra}

    # ------------------------------------------------------------ elements
    def text(self, text, style="body", pos="center", w=None, color=None, align="center", tall=None, name=None, reveal=None, **props):
        font, weight, sw, st, dc, lh = STYLES[style]
        text = re.sub(r"\[\[([a-z]+)\|", lambda m: f"[[{C.get(m.group(1), m.group(1))}|", text)  # palette names in markup
        if "size" in props:
            sw = st = props.pop("size")
        lh = props.pop("lineHeight", lh)
        mono = font == "JetBrains Mono"
        tall = dict(tall or {})
        if w is None:
            w = self._groups[-1][1] * 0.95 if self._groups else 0.85
            tall.setdefault("w", w if self._groups else 0.9)
        size_t = tall.pop("size", st if not self._groups else sw)
        wide, tl = self._layout(pos, w, None, tall)
        # Display styles stay on one line: shrink a one-line heading until it fits its box.
        plain = re.sub(r"\[\[[^|\]]+\|(.*?)\]\]", r"\1", text)
        if style in ("title", "big", "h1", "h2") and "\n" not in plain:
            k = len(plain) * (0.8 if font == "Unbounded" else 0.58)
            sw = min(sw, int(wide["w"] / k))
            size_t = min(size_t, int(tl["w"] / k))
        wide["h"] = round(_est_lines(text, sw, wide["w"], mono) * sw * lh + 8)
        tl["h"] = round(_est_lines(text, size_t, tl["w"], mono) * size_t * lh + 8)
        tl["size"] = size_t
        base = {**wide, "text": text, "font": font, "size": sw, "weight": weight, "color": col(color or dc),
                "align": align, "lineHeight": lh, "reveal": reveal or ("rise" if style in ("title", "big", "h1", "h2") else "fade"),
                **{k: col(v) for k, v in props.items()}}
        return self._add("text", name or plain.split("\n")[0][:28], base, tl)

    def rect(self, pos="center", w=400, h=240, fill="purple", radius=16, tall=None, name="Box", **props):
        wide, tl = self._layout(pos, w, h, tall)
        return self._add("rect", name, {**wide, "fill": col(fill), "radius": radius, **{k: col(v) for k, v in props.items()}}, tl)

    def circle(self, pos="center", d=200, fill="cyan", tall=None, name="Circle", **props):
        wide, tl = self._layout(pos, d, d, tall)
        return self._add("ellipse", name, {**wide, "fill": col(fill), **{k: col(v) for k, v in props.items()}}, tl)

    def path(self, d, pos="center", w=600, h=200, stroke="pink", width=8, fill="none", tall=None, name="Path", **props):
        wide, tl = self._layout(pos, w, h, tall)
        return self._add("path", name, {**wide, "d": d, "stroke": col(stroke), "strokeWidth": width, "fill": col(fill),
                                         **{k: col(v) for k, v in props.items()}}, tl)

    def arrow(self, a, b, color="cyan", width=8, head=26, name="Arrow", tall=None):
        """Straight arrow from point a to point b (positions like pos=)."""
        res = {}
        for asp in ("wide", "tall"):
            ta = (tall or {}).get("a", a) if asp == "tall" else a
            tb = (tall or {}).get("b", b) if asp == "tall" else b
            (x1, y1), (x2, y2) = self._xy(ta, asp), self._xy(tb, asp)
            pad = head + width
            l, t = min(x1, x2) - pad, min(y1, y2) - pad
            w, h = abs(x2 - x1) + 2 * pad, abs(y2 - y1) + 2 * pad
            ang = math.atan2(y2 - y1, x2 - x1)
            hx = lambda s: (x2 - l - head * math.cos(ang + s), y2 - t - head * math.sin(ang + s))
            (ax, ay), (bx, by) = hx(0.5), hx(-0.5)
            d = f"M{x1 - l:.1f} {y1 - t:.1f} L{x2 - l:.1f} {y2 - t:.1f} M{ax:.1f} {ay:.1f} L{x2 - l:.1f} {y2 - t:.1f} L{bx:.1f} {by:.1f}"
            res[asp] = {"x": round(l + w / 2, 1), "y": round(t + h / 2, 1), "w": round(w, 1), "h": round(h, 1), "d": d}
        return self._add("path", name, {**res["wide"], "stroke": col(color), "strokeWidth": width, "fill": C["none"]}, res["tall"])

    def image(self, file, pos="center", w=0.5, tall=None, name=None, fit="contain"):
        src = self._asset(pathlib.Path(file).expanduser())
        info = media.probe(self.folder_path / src)
        ar = (info.get("h") or 1) / (info.get("w") or 1)
        wide, tl = self._layout(pos, w, None, tall)
        wide["h"], tl["h"] = round(wide["w"] * ar), round(tl["w"] * ar)
        return self._add("image", name or pathlib.Path(file).stem, {**wide, "src": src, "fit": fit}, tl)

    def video(self, file, at=0.0, pos="center", w=None, fill=True, trim=0.0, dur=None, volume=1.0, mute=False, tall=None, name=None):
        """Video clip on screen from `at`. fill=True covers the stage in both layouts."""
        file = pathlib.Path(file).expanduser()
        assets = self.folder_path / "assets"
        assets.mkdir(parents=True, exist_ok=True)
        h = hashlib.sha1(f"{file.resolve()}|{file.stat().st_size}|{file.stat().st_mtime}".encode()).hexdigest()[:8]
        stem = assets / f"{_slug(file.stem)}-{h}"
        if not stem.with_suffix(".mp4").exists():
            info = media.import_video(file, stem)
        else:
            info = {"src": stem.with_suffix(".mp4"), **media.probe(stem.with_suffix(".mp4"))}
            if stem.with_suffix(".wav").exists():
                info["audio"] = stem.with_suffix(".wav")
            th = stem.parent / f"{stem.name}-thumbs.jpg"
            if th.exists():
                info["thumbs"] = th
        rel = lambda p: f"assets/{pathlib.Path(p).name}"
        if fill and not self._groups:
            wide = {"x": 960, "y": 540, "w": 1920, "h": 1080}
            tl = {"x": 540, "y": 960, "w": 1080, "h": 1920}
        else:
            ar = info["h"] / info["w"]
            wide, tl = self._layout(pos, w or 0.6, None, tall)
            wide["h"], tl["h"] = round(wide["w"] * ar), round(tl["w"] * ar)
        length = min(dur or info["dur"] - trim, info["dur"] - trim)
        clip = {"start": round(at, 3), "offset": trim, "dur": round(length, 3), "srcDur": info["dur"], "volume": volume}
        if mute: clip["muted"] = True
        if "audio" in info: clip["audio"] = rel(info["audio"])
        if "thumbs" in info: clip["thumbs"] = rel(info["thumbs"])
        return self._add("video", name or file.stem, {**wide, "src": rel(info["src"]), "fit": "cover"}, tl, clip=clip)

    def _asset(self, file: pathlib.Path) -> str:
        assets = self.folder_path / "assets"
        assets.mkdir(parents=True, exist_ok=True)
        dst = assets / file.name
        if not dst.exists():
            shutil.copy2(file, dst)
        return f"assets/{dst.name}"

    # ----------------------------------------------------------- structure
    @contextlib.contextmanager
    def group(self, name, w, h, pos="center", tall=None):
        """Children use this box (px or fractions). For 9:16 the group moves to
        tall['pos'] and scales to fit the width unless tall['scale'] is given."""
        tall = dict(tall or {})
        scale = tall.pop("scale", None)
        if scale is None and not self._groups:
            scale = min(1.0, 0.92 * 1080 / w)
        tall["scale"] = round(scale, 3) if scale is not None else None
        wide, tl = self._layout(pos, w, h, {**tall, "w": w, "h": h})
        g = self._add("group", name, wide, tl)
        self._groups.append((g.id, w, h))
        try:
            yield g
        finally:
            self._groups.pop()

    @contextlib.contextmanager
    def folder(self, name):
        """Layers made inside go in this folder (organizing only)."""
        f = next((f for f in self.folders if f["name"] == name), None)
        if not f:
            f = {"id": f"f-{_slug(name)}", "name": name}
            self.folders.append(f)
        prev, self._folder = self._folder, f["id"]
        try:
            yield
        finally:
            self._folder = prev

    # --------------------------------------------------------------- sound
    def narrate(self, lines, gap=0.35, at=None, captions=None, voice=None, speed=None):
        """Voice lines one after another (from `at`, else after the last line).
        Each line: "text", or (say, show) where show is the caption, or a dict
        with say/show/gap/pause (pause = extra silence after). Returns Lines."""
        items = []
        for ln in lines:
            if isinstance(ln, str): ln = {"say": ln}
            elif isinstance(ln, tuple): ln = {"say": ln[0], "show": ln[1]}
            items.append(ln)
        voiced = tts.voice_lines(self.folder_path / "assets",
                                 [{"text": i["say"], "voice": voice or self.voice, "speed": speed or self.speed} for i in items])
        t = self.cursor if at is None else at
        out = []
        for i, v in zip(items, voiced):
            ln = Line(i["say"], i.get("show", i["say"]), t, v["dur"])
            self.audio.append({"id": self._id("n"), "track": "narration", "src": v["src"], "start": ln.start, "offset": 0, "dur": v["dur"],
                               "srcDur": v["dur"], "volume": 1, "fadeIn": 0, "fadeOut": 0, "text": ln.say, "voice": voice or self.voice,
                               "speed": speed or self.speed, "voiced": ln.say})
            ln.captioned = self.captions if captions is None else captions
            out.append(ln)
            self.lines.append(ln)
            t = ln.end + i.get("gap", gap) + i.get("pause", 0)
        self.cursor = t
        return out

    def wait(self, sec):
        """Leave `sec` of silence before the next narrated line."""
        self.cursor += sec
        return self.cursor

    def music(self, file, at=0.0, volume=0.25, fade=1.5):
        return self._clip("music", file, at, volume, fade)

    def sfx(self, file, at, volume=0.8):
        return self._clip("sfx", file, at, volume, 0)

    def _clip(self, track, file, at, volume, fade):
        src = self._asset(pathlib.Path(file).expanduser())
        dur = media.probe(self.folder_path / src)["dur"]
        c = {"id": self._id("a"), "track": track, "src": src, "start": at, "offset": 0, "dur": dur, "srcDur": dur, "volume": volume,
             "fadeIn": 0, "fadeOut": fade, "name": pathlib.Path(file).stem}
        self.audio.append(c)
        return c

    # ---------------------------------------------------------------- kits
    def array(self, values, pos=(0.5, 0.55), slot=150, unit=None, tall=None, name="Array", color="dim"):
        return Arr(self, values, pos, slot, unit, tall, name, color)

    def code(self, src, pos="center", size=34, lang="cpp", tall=None, name="Code"):
        return Code(self, src, pos, size, lang, tall, name)

    # ----------------------------------------------------------------- out
    def _captions(self):
        caps = [ln for ln in self.lines if ln.captioned]
        if not caps:
            return
        with self.folder("Captions"):
            for i, ln in enumerate(caps):
                e = self.text(ln.show, "caption", CAPTION_SPOT[0], w=0.8, tall={"pos": CAPTION_SPOT[1], "w": 0.88},
                              name=f"Caption {i + 1}", reveal="fade")
                e.reveal(ln.start - 0.05, ln.dur * 0.85)
                nxt = caps[i + 1].start if i + 1 < len(caps) else None
                hold = ln.end + 1.2
                out = min(nxt - 0.15, hold) if nxt else hold
                e.fade_out(max(ln.end, out - 0.25), 0.25)

    def end(self):
        """Latest moment anything happens so far."""
        ends = [t["start"] + t["dur"] for t in self.tweens] + [c["start"] + c["dur"] for c in self.audio]
        ends += [e["clip"]["start"] + e["clip"]["dur"] for e in self.elements if e.get("clip")]
        return max(ends + [0])

    def save(self, tail=1.5, duration=None, force=False):
        """Write projects/<name>/project.json. Refuses to overwrite a project that
        was edited in the editor since the last build, unless force=True."""
        self._captions()
        dur = round(duration or self.end() + tail, 2)
        for c in self.audio:
            if c["track"] == "music":
                c["dur"] = round(min(c["srcDur"] - c["offset"], dur - c["start"]), 3)
        project = {"version": 1, "name": self.name, "duration": dur, "background": self.bg, "elements": self.elements,
                   "tweens": self.tweens, "audio": self.audio}
        if self.folders:
            project["folders"] = self.folders
        f = store.project_file(self.name)
        mark = f.parent / ".build-hash"
        if f.exists() and not force:
            have = hashlib.sha1(f.read_bytes()).hexdigest()
            if not mark.exists() or mark.read_text(encoding="utf-8").strip() != have:
                raise SystemExit(f"{f} was changed since the last build (editor tweaks?). "
                                 "Edit project.json directly, or save(force=True) to overwrite.")
        store.save(self.name, project)
        mark.write_text(hashlib.sha1(f.read_bytes()).hexdigest(), encoding="utf-8")
        from . import lint
        warnings = lint.check(project)
        print(f"{self.name}: {dur:.1f} s, {len(self.elements)} elements, {len(self.tweens)} tweens, {len(self.audio)} clips")
        for ln in self.lines:
            print(f"  {ln.start:6.2f}-{ln.end:6.2f}  {ln.say[:60]}")
        for w in warnings:
            print("  ! " + w)
        return project


class Arr:
    """Bars for array algorithms. Slots are positions 0..n-1; each bar keeps its
    value. Methods take slot indices and update the arrangement as bars move."""

    def __init__(self, s, values, pos, slot, unit, tall, name, color):
        self.s, self.vals, self.slotw = s, list(values), slot
        n, top = len(values), max(values)
        self.unit = unit or min(46, 420 / top)  # tallest bar about 470 px
        self.base_h = 50
        self.pad = 100  # room above the tallest bar for tags
        self.baseline = self.pad + self.base_h + top * self.unit
        W, H = slot * n, self.baseline + 140
        self.color0 = color
        self.order = list(range(n))  # slot -> bar index
        self.bars, self.rects, self.home = [], [], []
        self._tags, self._labels = {}, {}
        self._bracket = None
        self._ctx = s.group(name, W, H, pos, tall)
        self.g = self._ctx.__enter__()
        for i, v in enumerate(values):
            h = self.h(v)
            with s.group(f"{name} {v}", slot - 34, h, (slot * i + slot / 2, self.baseline - h / 2)) as b:
                self.rects.append(s.rect((0.5, 0.5), slot - 34, h, fill=color, radius=14, name=f"{name} {v} bar"))
                s.text(str(v), "num", (0.5, h + 46), w=slot - 20, name=f"{name} {v} value")
            self.bars.append(b)
            self.home.append(i)
        self._ctx.__exit__(None, None, None)

    def h(self, v): return self.base_h + v * self.unit
    def bar(self, slot): return self.bars[self.order[slot]]
    def rect(self, slot): return self.rects[self.order[slot]]
    def value(self, slot): return self.vals[self.order[slot]]
    def _x(self, slot): return self.slotw * slot + self.slotw / 2

    def show(self, at, gap=0.07):
        t = at
        for k, b in enumerate(self.bars):
            t = b.tween(at + k * gap, 0.7, "back.out(1.6)", y=(90, 0), opacity=(0, 1))
        return t

    def _slots(self, slots):
        return [slots] if isinstance(slots, int) else list(slots)

    def color(self, slots, c, at, gap=0.0, dur=0.3):
        t = at
        for k, sl in enumerate(self._slots(slots)):
            t = self.rect(sl).color(at + k * gap, c, dur)
        return t

    def glow(self, slots, px, at, dur=0.4):
        t = at
        for sl in self._slots(slots):
            t = self.rect(sl).glow(at, px, dur)
        return t

    def lift(self, slot, at, dy=-45, dur=0.4):
        b = self.bar(slot)
        return b.move(at, y=dy, dur=dur, ease="back.out(2)")

    def drop(self, slot, at, dur=0.45):
        return self.bar(slot).move(at, y=0, dur=dur, ease="bounce.out")

    def arrange(self, new_order, at, dur=0.7, gap=0.0):
        """Move bars so slot k holds the bar now at slot new_order[k]."""
        cur, t, n = list(self.order), at, 0
        for k, src in enumerate(new_order):
            bi = cur[src]
            b, x = self.bars[bi], (k - self.home[bi]) * self.slotw
            if abs(b.ox - x) > 1e-6:
                t = b.move(at + n * gap, x=x, dur=dur)
                for e in self._tags.values():  # tags ride along with their bar
                    if e.bar == bi and not e.hidden:
                        e.move(at + n * gap, x=self._x(k) - e.home[0], dur=dur)
                n += 1
            self.order[k] = bi
        return t

    def swap(self, i, j, at, dur=0.6):
        o = list(range(len(self.order)))
        o[i], o[j] = o[j], o[i]
        return self.arrange(o, at, dur)

    def tag(self, slot, text, at, color="pink", dur=0.35):
        """Label above a slot ('pivot', 'i', 'j'); re-tagging moves it there.
        Follows a lifted bar if the bar was lifted before this call."""
        x = self._x(slot)
        y = self.baseline - self.h(self.value(slot)) + self.bar(slot).oy - 62
        e = self._tags.get(text)
        if not e:
            with self.s._in(self.g):
                e = self.s.text(f"{text}\n▾", "label", (x, y), w=220, color=color, name=f"Tag {text}", lineHeight=1.0)
            e.home, e.hidden = (x, y), False
            e.bar = self.order[slot]
            self._tags[text] = e
            return e.tween(at, 0.3, "back.out(2)", opacity=(0, 1), scale=(0.6, 1))
        hx, hy = e.home
        e.bar = self.order[slot]
        if e.hidden:
            e.tween(at, 0.2, "power2.out", opacity=1)
            e.hidden = False
        return e.move(at, x=x - hx, y=y - hy, dur=dur)

    def untag(self, text, at):
        e = self._tags.get(text)
        if not e:
            return at
        e.hidden = True
        return e.fade_out(at, 0.2)

    def bracket(self, lo, hi, at, dur=0.45, color="cyan"):
        """Underline slots lo..hi (the range being worked on)."""
        w = self.slotw * (hi - lo + 1) - 30
        cx = self.slotw * (lo + hi + 1) / 2
        if not self._bracket:
            with self.s._in(self.g):
                self._bracket = self.s.rect((cx, self.baseline + 110), w, 8, fill=color, radius=4, name="Range", glow=10)
            self._bracket.home = (cx, w)
            return self._bracket.fade_in(at, 0.3)
        hx, _ = self._bracket.home
        return self._bracket.tween(at, dur, "power3.inOut", x=(None, cx - hx), w=(None, w), opacity=(None, 1))

    def unbracket(self, at):
        return self._bracket.fade_out(at) if self._bracket else at

    def label(self, text, lo, hi, at, color="cyan", style="label"):
        """Text above a range of slots."""
        with self.s._in(self.g):
            e = self.s.text(text, style, (self.slotw * (lo + hi + 1) / 2, 40), w=self.slotw * (hi - lo + 1) + 120, color=color, name=f"Label {text}", size=40)
        e.slide_in(at, dy=20, dur=0.4)
        return e

    def dim(self, slots, at, to=0.3, dur=0.35):
        t = at
        for sl in self._slots(slots):
            t = self.bar(sl).dim(at, to, dur)
        return t

    def undim(self, slots, at, dur=0.35):
        return self.dim(slots, at, 1, dur)

    def wave(self, at, gap=0.07, color=None):
        """Celebration hop across all bars, left to right."""
        t = at
        for sl in range(len(self.order)):
            b = self.bar(sl)
            b.tween(at + sl * gap, 0.22, "power2.out", y=-36)
            t = b.tween(at + sl * gap + 0.22, 0.5, "bounce.out", y=0)
            if color:
                self.rect(sl).color(at + sl * gap, color)
        return t


KEYWORDS = {
    "cpp": "auto bool break case char class const constexpr continue default delete do double else enum explicit false float for "
           "if inline int long namespace new nullptr operator private protected public return short sizeof static struct switch "
           "template this throw true try typedef typename using virtual void while include std vector string size_t".split(),
    "py": "and as assert break class continue def del elif else except False finally for from if import in is lambda None not or "
          "pass raise return True try while with yield self print len range".split(),
    "js": "async await break case catch class const continue default delete do else export false for function if import in let "
          "new null of return switch this throw true try typeof undefined var void while".split(),
}
TOKEN = re.compile(r'(//.*|#.*|"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b)')


def highlight(src, lang):
    kw = set(KEYWORDS.get(lang, []))
    comment = "//"

    def tok(m):
        t = m.group(0)
        if t.startswith(comment) or t.startswith("#"):
            return f"[[{C['muted']}|{t}]]"
        if t[0] in "\"'":
            return f"[[{C['green']}|{t}]]"
        if t[0].isdigit():
            return f"[[{C['pink']}|{t}]]"
        if t in kw:
            return f"[[{C['purple']}|{t}]]"
        return t

    return "\n".join(TOKEN.sub(tok, line) for line in src.split("\n"))


class Code:
    """Syntax-colored code on a panel, with a line highlighter."""

    def __init__(self, s, src, pos, size, lang, tall, name):
        self.s = s
        lines = src.strip("\n").split("\n")
        self.lh = size * 1.45
        self.pad = 34
        W = max(len(l) for l in lines) * size * 0.6 + 2 * self.pad + 10
        H = len(lines) * self.lh + 2 * self.pad
        self.W, self.H = W, H
        with s.group(name, W, H, pos, tall) as g:
            self.g = g
            self.panel = s.rect((0.5, 0.5), W, H, fill="panel", radius=18, name=f"{name} panel", stroke=C["line"], strokeWidth=2)
            self.hl = s.rect((W / 2, self.pad + self.lh / 2), W - 20, self.lh, fill="rgba(176,124,245,0.18)", radius=8, name=f"{name} highlight")
            self.txt = s.text(highlight("\n".join(lines), lang), "mono", (W / 2, H / 2), w=W - 2 * self.pad,
                              align="left", name=f"{name} text", reveal="type", size=size, lineHeight=1.45)
            self.txt.d["props"]["h"] = round(len(lines) * self.lh)
        self._hl_on = False

    def show(self, at, typed=False, dur=None):
        t = self.g.fade_in(at, 0.4)
        if typed:
            t = self.txt.reveal(at + 0.2, dur)
        return t

    def highlight(self, line, at, dur=0.35):
        """Move the highlight bar to line (1-based)."""
        y = (line - 1) * self.lh
        if not self._hl_on:
            self._hl_on = True
            self.hl.tween(at, 0.01, "none", y=(y, y))
            return self.hl.tween(at, 0.25, "power2.out", opacity=(0, 1))
        return self.hl.tween(at, dur, "power3.inOut", y=y)

    def unhighlight(self, at):
        return self.hl.fade_out(at, 0.25)


def _in_group(scene, g):
    """Re-enter an existing group (kits add layers to their group later)."""
    @contextlib.contextmanager
    def cm():
        d = g.d
        scene._groups.append((g.id, d["props"]["w"], d["props"]["h"]))
        try:
            yield
        finally:
            scene._groups.pop()
    return cm()


Scene._in = _in_group

__all__ = ["Scene", "C", "BG", "STYLES", "SPOTS", "col"]
