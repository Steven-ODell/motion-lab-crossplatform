"""ffmpeg helpers: probing files, cleaning up recordings, mixing the audio tracks."""
import json
import pathlib
import subprocess

SR = 48000


def probe(path: pathlib.Path) -> dict:
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
        capture_output=True, text=True, encoding="utf-8", errors="replace", check=True,
    )
    info = json.loads(r.stdout)
    out = {"dur": float(info.get("format", {}).get("duration") or 0)}
    for s in info.get("streams", []):
        if s.get("codec_type") == "video" and s.get("width"):
            out["w"], out["h"] = s["width"], s["height"]
    return out


def has_audio(path: pathlib.Path) -> bool:
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", str(path)],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    return bool(r.stdout.strip())


def import_video(src: pathlib.Path, stem: pathlib.Path) -> dict:
    """Turn an uploaded video into what the editor uses:
      <stem>.mp4         editing copy: H.264, long side <= 1920, a keyframe every
                         10 frames and no B-frames, so seeking any frame is fast
      <stem>.wav         its sound (48 kHz stereo, levels untouched), if it has any
      <stem>-thumbs.jpg  40 frames side by side across the whole clip
    Phone rotation metadata is applied by ffmpeg, so portrait clips stay portrait.
    """
    mp4 = stem.with_suffix(".mp4")
    fit = "scale='if(gte(iw,ih),min(1920,iw),-2)':'if(gte(iw,ih),-2,min(1920,ih))':flags=lanczos"
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-map", "0:v:0", "-vf", f"{fit},format=yuv420p",
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-g", "10", "-bf", "0", "-movflags", "+faststart", "-an", str(mp4)],
        check=True,
    )
    info = probe(mp4)
    out = {"src": mp4, "dur": info["dur"], "w": info.get("w"), "h": info.get("h")}
    if has_audio(src):
        wav = stem.with_suffix(".wav")
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-map", "0:a:0", "-vn", "-ac", "2", "-ar", str(SR), str(wav)],
                       check=True)
        out["audio"] = wav
    n = 40
    thumbs = stem.parent / f"{stem.name}-thumbs.jpg"
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(mp4), "-vf", f"fps={n}/{max(info['dur'], 0.1):.4f},scale=-2:64,tile={n}x1",
         "-frames:v", "1", "-q:v", "5", str(thumbs)],
        check=True,
    )
    if thumbs.exists():
        out["thumbs"] = thumbs
    return out


def clean_voice(src: pathlib.Path, dst: pathlib.Path):
    """A mic take: rumble cut and loudness matched to the narration (-16 LUFS)."""
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
         "-af", "highpass=f=80,loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", str(SR), "-ac", "1", str(dst)],
        check=True,
    )


def mix(project: dict, folder: pathlib.Path, dst: pathlib.Path) -> bool:
    """Mix every unmuted clip into one stereo WAV the length of the project.

    Gain, trims, and fades match what the editor plays through WebAudio.
    Returns False when there is nothing to mix.
    """
    muted = set(project.get("muted") or [])
    clips = [c for c in project.get("audio", []) if c.get("src") and c["track"] not in muted and c["dur"] > 0]
    # Sound of visible, unmuted video elements (same rules as the editor's allClips).
    for e in project.get("elements", []):
        v = e.get("clip")
        if e.get("type") == "video" and v and v.get("audio") and not v.get("muted") and not e.get("hidden"):
            clips.append({"src": v["audio"], "start": v["start"], "offset": v["offset"], "dur": v["dur"], "volume": v.get("volume", 1)})
    if not clips:
        return False
    total = float(project["duration"])
    inputs, chains, labels = [], [], []
    for i, c in enumerate(clips):
        inputs += ["-i", str(folder / c["src"])]
        dur = min(c["dur"], max(0.0, total - c["start"]))
        if dur <= 0:
            continue
        f = [
            f"atrim=start={c.get('offset', 0):.4f}:duration={dur:.4f}",
            "asetpts=PTS-STARTPTS",
            f"aresample={SR}",
            "aformat=sample_fmts=fltp:channel_layouts=stereo",
            f"volume={c.get('volume', 1):.4f}",
        ]
        fi, fo = min(c.get("fadeIn", 0), dur), min(c.get("fadeOut", 0), dur)
        if fi > 0:
            f.append(f"afade=t=in:st=0:d={fi:.4f}")
        if fo > 0:
            f.append(f"afade=t=out:st={dur - fo:.4f}:d={fo:.4f}")
        ms = round(max(0.0, c["start"]) * 1000)
        if ms:
            f.append(f"adelay={ms}:all=1")
        chains.append(f"[{i}:a]{','.join(f)}[a{i}]")
        labels.append(f"[a{i}]")
    if not labels:
        return False
    graph = ";".join(chains) + ";" + "".join(labels) + (
        f"amix=inputs={len(labels)}:normalize=0:dropout_transition=0,"
        # Fill from t=0 with silence: adelay can leave a timestamp gap at the start
        # that the final atrim (ffmpeg 9) would otherwise collapse, playing clips early.
        f"aresample=async=1:first_pts=0,"
        f"apad=whole_dur={total:.4f},atrim=0:{total:.4f},alimiter=limit=0.97:level=false[out]"
    )
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", *inputs, "-filter_complex", graph, "-map", "[out]", "-ar", str(SR), str(dst)],
        check=True,
    )
    return True
