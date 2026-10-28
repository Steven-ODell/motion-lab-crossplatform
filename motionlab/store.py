"""Where projects live and how project.json is written."""
import json
import os
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
PROJECTS = pathlib.Path(os.environ.get("MOTION_PROJECTS", ROOT / "projects"))
EDITOR = ROOT / "editor"
DIST = EDITOR / "dist"
# Kokoro voice models: $KOKORO_MODELS, else models/ in the repo (the Windows setup puts them
# there), else the copy Jarvis already has on Sao's laptop.
KOKORO = pathlib.Path(os.environ.get("KOKORO_MODELS") or next(
    (p for p in (ROOT / "models", pathlib.Path.home() / "Projects/Side/jarvis/models") if (p / "kokoro-v1.0.onnx").exists()),
    ROOT / "models"))
# Child processes (export, tts) print and read UTF-8 even on Windows, where the default is cp1252.
os.environ.setdefault("PYTHONUTF8", "1")

NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


def project_dir(name: str) -> pathlib.Path:
    if not NAME.match(name):
        raise ValueError(f"bad project name: {name!r}")
    return PROJECTS / name


def project_file(name: str) -> pathlib.Path:
    return project_dir(name) / "project.json"


def dumps(project: dict) -> str:
    """Pretty at the top, one line per element/tween/clip, so the file diffs
    well and stays easy to edit by hand."""
    lines = ["{"]
    keys = list(project)
    for i, k in enumerate(keys):
        v = project[k]
        comma = "," if i < len(keys) - 1 else ""
        if isinstance(v, list) and v and all(isinstance(x, dict) for x in v):
            lines.append(f"  {json.dumps(k)}: [")
            for j, item in enumerate(v):
                c = "," if j < len(v) - 1 else ""
                lines.append("    " + json.dumps(item, ensure_ascii=False, separators=(", ", ": ")) + c)
            lines.append("  ]" + comma)
        else:
            lines.append(f"  {json.dumps(k)}: {json.dumps(v, ensure_ascii=False)}{comma}")
    lines.append("}")
    return "\n".join(lines) + "\n"


def save(name: str, project: dict) -> float:
    path = project_file(name)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(dumps(project), encoding="utf-8")
    os.replace(tmp, path)
    return path.stat().st_mtime


def list_projects() -> list[dict]:
    out = []
    if PROJECTS.exists():
        for f in sorted(PROJECTS.glob("*/project.json"), key=lambda p: -p.stat().st_mtime):
            try:
                p = json.loads(f.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                continue
            out.append({"name": f.parent.name, "duration": p.get("duration", 0), "mtime": f.stat().st_mtime})
    return out
