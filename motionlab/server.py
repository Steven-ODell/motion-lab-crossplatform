"""motion: the motion-lab editor server.

Serves the editor (editor/dist), reads and writes projects/<name>/project.json,
stores uploaded assets, voices narration with Kokoro, and runs exports.
"""
import argparse
import asyncio
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import uuid

from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import media, store, tts

app = FastAPI()
PORT = 3790
jobs: dict[str, dict] = {}


def folder_of(name: str) -> pathlib.Path:
    try:
        return store.project_dir(name)
    except ValueError as e:
        raise HTTPException(400, str(e))


def load(name: str) -> dict:
    f = folder_of(name) / "project.json"
    if not f.exists():
        raise HTTPException(404, f"no project {name}")
    return json.loads(f.read_text(encoding="utf-8"))


@app.get("/api/ping")
def ping():
    return {"ok": True, "app": "motion-lab"}


@app.get("/api/projects")
def projects():
    return store.list_projects()


@app.post("/api/projects")
def create(body: dict = Body(...)):
    name = body.get("name", "")
    folder = folder_of(name)
    if (folder / "project.json").exists():
        raise HTTPException(409, f"{name} already exists")
    project = body.get("project") or {
        "version": 1, "name": name, "duration": 10, "background": "#0d0b14",
        "elements": [], "tweens": [], "audio": [],
    }
    store.save(name, project)
    return {"name": name}


@app.get("/api/projects/{name}")
def get_project(name: str):
    f = folder_of(name) / "project.json"
    if not f.exists():
        raise HTTPException(404, f"no project {name}")
    return FileResponse(f, media_type="application/json", headers={"Cache-Control": "no-store", "X-Mtime": str(f.stat().st_mtime)})


@app.put("/api/projects/{name}")
def put_project(name: str, project: dict = Body(...)):
    folder_of(name)
    return {"mtime": store.save(name, project)}


@app.get("/api/projects/{name}/events")
async def events(name: str):
    """Server-sent events: the file's mtime whenever it changes on disk, so the
    editor picks up edits Claude makes to project.json while it is open."""
    f = folder_of(name) / "project.json"

    async def stream():
        last = f.stat().st_mtime if f.exists() else 0
        yield f"data: {json.dumps({'mtime': last})}\n\n"
        while True:
            await asyncio.sleep(0.5)
            m = f.stat().st_mtime if f.exists() else 0
            if m != last:
                last = m
                yield f"data: {json.dumps({'mtime': m})}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-store"})


VIDEO_EXT = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".mts"}


@app.post("/api/projects/{name}/assets")
async def upload(name: str, file: UploadFile = File(...), kind: str = Form("")):
    assets = folder_of(name) / "assets"
    assets.mkdir(parents=True, exist_ok=True)
    stem = pathlib.Path(file.filename or "upload").stem
    stem = "".join(c if c.isalnum() or c in "-_" else "-" for c in stem)[:40] or "upload"
    ext = pathlib.Path(file.filename or "").suffix.lower() or ".bin"
    tag = uuid.uuid4().hex[:6]
    if kind == "video" or ext in VIDEO_EXT:
        raw = assets / f".{stem}-{tag}{ext}"
        await asyncio.to_thread(save_upload, file, raw)
        try:
            out = await asyncio.to_thread(media.import_video, raw, assets / f"{stem}-{tag}")
        except subprocess.CalledProcessError as e:
            raise HTTPException(400, f"ffmpeg could not read {file.filename}: {e}")
        finally:
            raw.unlink(missing_ok=True)
        rel = lambda p: f"assets/{p.name}"
        return {**out, "src": rel(out["src"]), **({"audio": rel(out["audio"])} if "audio" in out else {}),
                **({"thumbs": rel(out["thumbs"])} if "thumbs" in out else {})}
    if kind == "voice":
        raw = assets / f".{stem}-{tag}{ext}"
        await asyncio.to_thread(save_upload, file, raw)
        dst = assets / f"{stem}-{tag}.wav"
        await asyncio.to_thread(media.clean_voice, raw, dst)
        raw.unlink()
    else:
        dst = assets / f"{stem}-{tag}{ext}"
        await asyncio.to_thread(save_upload, file, dst)
    info = await asyncio.to_thread(media.probe, dst)
    return {"src": f"assets/{dst.name}", **info}


def save_upload(file: UploadFile, dst: pathlib.Path):
    """Stream to disk so a big video never sits in memory."""
    with open(dst, "wb") as f:
        shutil.copyfileobj(file.file, f, 1 << 20)


@app.get("/api/voices")
def voices():
    return tts.voices()


@app.post("/api/projects/{name}/tts")
def voice_lines(name: str, body: dict = Body(...)):
    """Voice narration lines (cached by text+voice+speed)."""
    try:
        return tts.voice_lines(folder_of(name) / "assets", body.get("items", []))
    except RuntimeError as e:
        raise HTTPException(500, str(e))


def run_job(job: dict, cmd: list[str]):
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", cwd=store.ROOT)
    job["proc"] = proc
    for line in proc.stdout:
        try:
            job.update(json.loads(line))
        except json.JSONDecodeError:
            pass
    err = proc.stderr.read()
    proc.wait()
    if job.get("stage") != "done":
        job["stage"] = "cancelled" if job.get("cancelled") else "error"
        job.setdefault("error", err.strip()[-800:] or f"exit {proc.returncode}")


@app.post("/api/projects/{name}/export")
def export(name: str, body: dict = Body(...)):
    folder_of(name)
    aspect, fmt = body.get("aspect", "wide"), body.get("format", "mp4")
    cmd = [sys.executable, "-m", "motionlab.export", name, "--aspect", aspect, "--format", fmt, "--base", f"http://127.0.0.1:{PORT}"]
    if body.get("fps"):
        cmd += ["--fps", str(int(body["fps"]))]
    jid = uuid.uuid4().hex[:8]
    job = {"id": jid, "project": name, "aspect": aspect, "format": fmt, "stage": "starting", "started": time.time()}
    jobs[jid] = job
    threading.Thread(target=run_job, args=(job, cmd), daemon=True).start()
    return public(job)


def public(job: dict) -> dict:
    j = {k: v for k, v in job.items() if k != "proc"}
    if j.get("out"):
        p = pathlib.Path(j["out"])
        j["url"] = f"/projects/{p.parent.parent.name}/exports/{p.name}"
    return j


@app.get("/api/jobs")
def list_jobs():
    return [public(j) for j in jobs.values()]


@app.post("/api/jobs/{jid}/cancel")
def cancel(jid: str):
    job = jobs.get(jid)
    if not job:
        raise HTTPException(404)
    job["cancelled"] = True
    if job.get("proc") and job["proc"].poll() is None:
        job["proc"].terminate()
    return public(job)


@app.post("/api/projects/{name}/reveal")
def reveal(name: str, body: dict = Body(...)):
    """Open an export's folder in the file manager."""
    path = folder_of(name) / "exports"
    path.mkdir(parents=True, exist_ok=True)
    open_external(str(path))
    return {"ok": True}


def open_external(target: str):
    """Open a URL or folder with the desktop's default app (Zen on Sao's laptop)."""
    if sys.platform == "win32":
        os.startfile(target)
        return
    opener = "open" if sys.platform == "darwin" else "xdg-open"
    subprocess.Popen([opener, target], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def build_editor(force=False):
    """Build editor/dist when it is missing or older than the source."""
    index = store.DIST / "index.html"
    srcs = [p for p in (store.EDITOR / "src").rglob("*") if p.is_file()]
    srcs += [store.EDITOR / f for f in ("index.html", "render.html", "package.json", "vite.config.ts")]
    if not force and index.exists() and max(p.stat().st_mtime for p in srcs) <= index.stat().st_mtime:
        return
    npm = shutil.which("npm")
    if not npm:
        if index.exists():  # a shared copy ships editor/dist prebuilt; no Node needed
            return
        sys.exit("motion: the editor needs building and npm is not on PATH")
    if not (store.EDITOR / "node_modules").exists():
        subprocess.run([npm, "ci"], cwd=store.EDITOR, check=True)
    print("motion: building the editor...", file=sys.stderr)
    subprocess.run([npm, "run", "build", "--silent"], cwd=store.EDITOR, check=True)


_mounted = False


def mount():
    global _mounted
    if _mounted:
        return
    build_editor()
    store.PROJECTS.mkdir(parents=True, exist_ok=True)
    app.mount("/projects", StaticFiles(directory=store.PROJECTS), name="projects")
    app.mount("/", StaticFiles(directory=store.DIST, html=True), name="editor")
    _mounted = True


def start_background() -> str:
    """Serve on a free port in a daemon thread (for motion check/export). Returns the base URL."""
    global PORT
    import socket
    import uvicorn
    mount()
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        PORT = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=PORT, log_level="error"))
    threading.Thread(target=server.run, daemon=True).start()
    for _ in range(100):
        if running(PORT):
            break
        time.sleep(0.05)
    return f"http://127.0.0.1:{PORT}"


def running(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/ping", timeout=0.5) as r:
            return json.loads(r.read()).get("app") == "motion-lab"
    except Exception:
        return False


def main():
    global PORT
    if len(sys.argv) > 1 and sys.argv[1] in ("new", "build", "check", "export"):
        from . import cli
        return cli.main(sys.argv[1:])
    ap = argparse.ArgumentParser(prog="motion", description="motion-lab animation editor (also: motion new|build|check|export, see motion build -h)")
    ap.add_argument("project", nargs="?", help="open this project")
    ap.add_argument("--port", type=int, default=int(os.environ.get("MOTION_PORT", 3790)))
    ap.add_argument("--no-open", action="store_true", help="don't open the browser")
    ap.add_argument("--build", action="store_true", help="rebuild the editor even if it looks current")
    a = ap.parse_args()
    PORT = a.port
    url = f"http://127.0.0.1:{a.port}/" + (f"#{a.project}" if a.project else "")

    if running(a.port):
        print(f"motion is already running: {url}", file=sys.stderr)
        if not a.no_open:
            open_external(url)
        return

    if a.build:
        build_editor(True)
    mount()

    if not a.no_open:
        def opener():
            for _ in range(50):
                if running(a.port):
                    open_external(url)
                    return
                time.sleep(0.1)
        threading.Thread(target=opener, daemon=True).start()

    import uvicorn
    print(f"motion: {url}", file=sys.stderr)
    uvicorn.run(app, host="127.0.0.1", port=a.port, log_level="warning")


if __name__ == "__main__":
    main()
