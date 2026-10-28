"""Export a project to MP4, WebM, or GIF.

Opens the editor's render page in headless system Chromium, seeks the player one
frame at a time, and pipes screenshots to ffmpeg. The audio tracks are mixed
separately (media.mix) and muxed in. Progress goes to stdout as JSON lines so
the server can show it.
"""
import argparse
import base64
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright

from . import media
from .store import project_dir

FORMATS = {
    "mp4": ["-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart"],
    "webm": ["-c:v", "libvpx-vp9", "-crf", "30", "-b:v", "0", "-row-mt", "1", "-pix_fmt", "yuv420p"],
}
AUDIO = {"mp4": ["-c:a", "aac", "-b:a", "192k"], "webm": ["-c:a", "libopus", "-b:a", "160k"]}


def say(**kw):
    print(json.dumps(kw), flush=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("project")
    ap.add_argument("--aspect", choices=["wide", "tall"], default="wide")
    ap.add_argument("--format", choices=["mp4", "webm", "gif"], default="mp4")
    ap.add_argument("--fps", type=int)
    ap.add_argument("--base", default="http://127.0.0.1:3790", help="where the motion server is running")
    ap.add_argument("--silent", action="store_true")
    ap.add_argument("-o", "--out", type=pathlib.Path)
    a = ap.parse_args()

    folder = project_dir(a.project)
    fps = a.fps or (15 if a.format == "gif" else 30)
    out = a.out or folder / "exports" / f"{a.project}-{a.aspect}.{a.format}"
    out.parent.mkdir(parents=True, exist_ok=True)
    project = json.loads(urllib.request.urlopen(f"{a.base}/api/projects/{a.project}").read())

    tmp = pathlib.Path(tempfile.mkdtemp(prefix="motion-export-"))
    try:
        audio = None
        if a.format != "gif" and not a.silent:
            say(stage="audio")
            wav = tmp / "mix.wav"
            if media.mix(project, folder, wav):
                audio = wav

        if a.format == "gif":
            # Half size, one palette for the whole clip, ordered dither keeps it stable frame to frame.
            vf = ["-vf", "scale=iw/2:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4"]
            codec, sound = [*vf, "-loop", "0"], []
        else:
            codec = FORMATS[a.format]
            # Pad the mix with silence and cut at the project length, so a short
            # mix never ends the video early (and never closes ffmpeg's pipe).
            sound = ["-i", str(audio), "-map", "0:v", "-map", "1:a", "-af", "apad", *AUDIO[a.format]] if audio else []
            sound += ["-t", f"{project['duration']:.3f}"]

        q = urllib.parse.urlencode({"project": a.project, "aspect": a.aspect})
        with sync_playwright() as p:
            chromium = shutil.which("chromium")
            browser = p.chromium.launch(executable_path=chromium) if chromium else p.chromium.launch()
            page = browser.new_page(viewport={"width": 1920, "height": 1080})
            page.on("pageerror", lambda e: print(f"page error: {e}", file=sys.stderr))
            page.goto(f"{a.base}/render.html?{q}", wait_until="load")
            page.wait_for_function("window.__motion", timeout=30_000)
            w, h = page.evaluate("window.__motion.size")
            page.set_viewport_size({"width": w, "height": h})
            frames = max(1, round(project["duration"] * fps))
            # Lossless PNG with Chromium's fast encoder: ~5x quicker than
            # page.screenshot() on gradient-heavy frames.
            cdp = page.context.new_cdp_session(page)
            grab = lambda: base64.b64decode(cdp.send("Page.captureScreenshot", {"format": "png", "optimizeForSpeed": True})["data"])
            ffmpeg = subprocess.Popen(
                ["ffmpeg", "-y", "-loglevel", "error",
                 "-f", "image2pipe", "-c:v", "png", "-framerate", str(fps), "-i", "-", *sound, *codec, str(out)],
                stdin=subprocess.PIPE,
            )
            start = time.time()
            for i in range(frames):
                page.evaluate("t => window.__motion.seek(t)", i / fps)
                ffmpeg.stdin.write(grab())
                if i % 5 == 0 or i == frames - 1:
                    say(stage="frames", frame=i + 1, of=frames)
            ffmpeg.stdin.close()
            ffmpeg.wait()
            browser.close()
        if ffmpeg.returncode:
            say(stage="error", error=f"ffmpeg exited {ffmpeg.returncode}")
            return 1
        say(stage="done", out=str(out), frames=frames, seconds=round(time.time() - start, 1), bytes=out.stat().st_size)
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
