"""Voice narration lines with Kokoro. Run as a subprocess so the model is only in
RAM while it works:  {"items": [{"text", "voice", "speed", "out"}]} on stdin,
one JSON line per finished item on stdout."""
import json
import pathlib
import subprocess
import sys

import numpy as np
import soundfile as sf

from .store import KOKORO

SR = 24000


def trim(samples, threshold=0.004):
    """Cut Kokoro's leading/trailing near-silence so clips start on the word."""
    loud = np.flatnonzero(np.abs(samples) > threshold)
    if not len(loud):
        return samples
    pad = int(0.03 * SR)
    return samples[max(0, loud[0] - pad): loud[-1] + pad]


def main():
    from kokoro_onnx import Kokoro

    job = json.load(sys.stdin)
    kokoro = Kokoro(str(KOKORO / "kokoro-v1.0.onnx"), str(KOKORO / "voices-v1.0.bin"))
    for item in job["items"]:
        voice = item.get("voice") or "bm_george"
        lang = "en-gb" if voice.startswith("b") else "en-us"
        samples, _ = kokoro.create(item["text"], voice=voice, speed=float(item.get("speed") or 1.0), lang=lang)
        samples = trim(samples.astype(np.float32))
        out = pathlib.Path(item["out"])
        raw = out.with_suffix(".raw.wav")
        sf.write(raw, samples, SR)
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(raw),
             "-af", "highpass=f=70,loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "48000", str(out)],
            check=True,
        )
        raw.unlink()
        dur = float(sf.info(out).duration)
        print(json.dumps({"out": str(out), "dur": round(dur, 3)}), flush=True)


def voice_lines(assets: pathlib.Path, items: list[dict]) -> list[dict]:
    """Voice [{text, voice, speed}] into assets/narr-<hash>.wav, reusing any line
    already voiced with the same text, voice and speed. Returns [{src, dur}]
    with src relative to the project folder. Kokoro runs in a subprocess and
    exits when it's done."""
    import hashlib
    from . import media
    assets.mkdir(parents=True, exist_ok=True)
    results, todo = [], []
    for item in items:
        text = (item.get("text") or "").strip()
        voice, speed = item.get("voice") or "bm_george", float(item.get("speed") or 1.0)
        if not text:
            results.append({"src": "", "dur": 0})
            continue
        h = hashlib.sha1(f"{voice}|{speed}|{text}".encode()).hexdigest()[:12]
        out = assets / f"narr-{h}.wav"
        results.append({"src": f"assets/{out.name}", "out": out})
        if not out.exists():
            todo.append({"text": text, "voice": voice, "speed": speed, "out": str(out)})
    if todo:
        r = subprocess.run([sys.executable, "-m", "motionlab.tts"], input=json.dumps({"items": todo}),
                           capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=pathlib.Path(__file__).parent.parent)
        if r.returncode:
            raise RuntimeError(f"kokoro failed: {r.stderr.strip()[-600:]}")
    for res in results:
        if "out" in res:
            res["dur"] = round(media.probe(res.pop("out"))["dur"], 3)
    return results


def voices() -> list[str]:
    path = KOKORO / "voices-v1.0.bin"
    if not path.exists():
        return []
    with np.load(path) as z:
        return sorted(z.files)


if __name__ == "__main__":
    main()
