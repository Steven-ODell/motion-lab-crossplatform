"""motion build | check | export | new: the commands Claude uses to make videos.

    motion new NAME            start projects/NAME/build.py from a template
    motion build NAME          run projects/NAME/build.py (or a path to a script)
    motion check NAME          lint + contact sheets of frames in both aspects
    motion export NAME         MP4 (or --format webm|gif) for --aspect wide|tall|both

check and export start a private server on a free port, so nothing needs to be
running and nothing opens on screen.
"""
import argparse
import base64
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile

from . import lint, store

TEMPLATE = '''from motionlab.build import *

s = Scene("{name}")
L = s.narrate([
    "First line.",
    "Second line.",
])
with s.folder("Title"):
    title = s.text("{title}", "title", "top")
    title.reveal(L[0].start)
s.save()
'''


def script_for(target: str) -> pathlib.Path:
    p = pathlib.Path(target)
    if p.suffix == ".py" and p.exists():
        return p.resolve()
    return store.project_dir(target) / "build.py"


def cmd_new(a):
    f = store.project_dir(a.name) / "build.py"
    if f.exists():
        sys.exit(f"{f} already exists")
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(TEMPLATE.format(name=a.name, title=a.name.replace("-", " ").title()), encoding="utf-8")
    print(f)


def cmd_build(a):
    f = script_for(a.target)
    if not f.exists():
        sys.exit(f"no build script at {f} (motion new NAME makes one)")
    r = subprocess.run([sys.executable, str(f)], cwd=f.parent)
    if r.returncode == 0 and a.check:
        cmd_check(argparse.Namespace(name=f.parent.name, at=None, n=12, aspect="both"))
    sys.exit(r.returncode)


def times_for(p: dict, n: int) -> list[float]:
    """Frames to look at: the middle of each narration line, else n even steps."""
    lines = sorted((c for c in p["audio"] if c["track"] == "narration"), key=lambda c: c["start"])
    if lines:
        ts = [round(c["start"] + c["dur"] * 0.75, 2) for c in lines] + [round(p["duration"] - 0.6, 2)]
    else:
        ts = [round(p["duration"] * (i + 0.5) / n, 2) for i in range(n)]
    return ts


def cmd_check(a):
    from playwright.sync_api import sync_playwright
    from .server import start_background
    p = json.loads(store.project_file(a.name).read_text(encoding="utf-8"))
    for w in lint.check(p):
        print("! " + w)
    ts = [float(x) for x in a.at.split(",")] if a.at else times_for(p, a.n)
    base = start_background()
    outdir = store.project_dir(a.name) / ".check"
    outdir.mkdir(exist_ok=True)
    aspects = ["wide", "tall"] if a.aspect == "both" else [a.aspect]
    with sync_playwright() as pw:
        chromium = shutil.which("chromium")
        browser = pw.chromium.launch(executable_path=chromium) if chromium else pw.chromium.launch()
        for asp in aspects:
            page = browser.new_page(viewport={"width": 1920, "height": 1080})
            page.on("pageerror", lambda e: print(f"page error: {e}", file=sys.stderr))
            page.goto(f"{base}/render.html?project={a.name}&aspect={asp}")
            page.wait_for_function("window.__motion", timeout=30_000)
            w, h = page.evaluate("window.__motion.size")
            page.set_viewport_size({"width": w, "height": h})
            cdp = page.context.new_cdp_session(page)
            tmp = pathlib.Path(tempfile.mkdtemp(prefix="motion-check-"))
            files = []
            for t in ts:
                page.evaluate("t => window.__motion.seek(t)", t)
                png = base64.b64decode(cdp.send("Page.captureScreenshot", {"format": "png", "optimizeForSpeed": True})["data"])
                f = tmp / f"{t:.2f}s.png"
                f.write_bytes(png)
                files.append(str(f))
            cols, tile = ("4", "480x270") if asp == "wide" else ("6", "216x384")
            out = outdir / f"{asp}.png"
            subprocess.run(["magick", "montage", "-label", "%t", *files, "-tile", f"{cols}x", "-geometry", f"{tile}+4+4",
                            "-background", "#000", "-fill", "#ccc", "-pointsize", "14", str(out)], check=True)
            shutil.rmtree(tmp, ignore_errors=True)
            print(out)
            page.close()
        browser.close()


def cmd_export(a):
    from .server import start_background
    base = start_background()
    aspects = ["wide", "tall"] if a.aspect == "both" else [a.aspect]
    for asp in aspects:
        cmd = [sys.executable, "-m", "motionlab.export", a.name, "--aspect", asp, "--format", a.format, "--base", base]
        if a.fps:
            cmd += ["--fps", str(a.fps)]
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
        last = [json.loads(l) for l in r.stdout.splitlines() if l.startswith("{")]
        done = last[-1] if last else {}
        if done.get("stage") == "done":
            print(f"{done['out']}  ({done['frames']} frames, {done['seconds']} s, {done['bytes'] / 1e6:.1f} MB)")
        else:
            sys.exit(f"export failed: {r.stderr.strip()[-800:]}")


def main(argv):
    ap = argparse.ArgumentParser(prog="motion", description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    n = sub.add_parser("new"); n.add_argument("name"); n.set_defaults(fn=cmd_new)
    b = sub.add_parser("build"); b.add_argument("target"); b.add_argument("--check", action="store_true"); b.set_defaults(fn=cmd_build)
    c = sub.add_parser("check"); c.add_argument("name"); c.add_argument("--at", help="comma-separated times")
    c.add_argument("--n", type=int, default=12); c.add_argument("--aspect", choices=["wide", "tall", "both"], default="both"); c.set_defaults(fn=cmd_check)
    e = sub.add_parser("export"); e.add_argument("name"); e.add_argument("--aspect", choices=["wide", "tall", "both"], default="both")
    e.add_argument("--format", choices=["mp4", "webm", "gif"], default="mp4"); e.add_argument("--fps", type=int); e.set_defaults(fn=cmd_export)
    a = ap.parse_args(argv)
    a.fn(a)
