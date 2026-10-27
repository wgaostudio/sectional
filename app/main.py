"""Sectional — local server.

Run with ./start.command (or: .venv/bin/python -m app.main), then open http://localhost:8765.
"""
from __future__ import annotations

import json
import logging
import os
import queue
import shutil
import threading
import time
import traceback
import uuid
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent.parent
LIBRARY = Path(os.environ.get("SECTIONAL_LIBRARY", ROOT / "library"))
UPLOADS = LIBRARY / ".uploads"
STATIC = ROOT / "static"
PORT = int(os.environ.get("SECTIONAL_PORT", "8765"))
SETTINGS = LIBRARY / "settings.json"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("sectional")
LIBRARY.mkdir(parents=True, exist_ok=True)
UPLOADS.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Sectional")
jobs: "queue.Queue[str]" = queue.Queue()
_meta_lock = threading.Lock()
_engine_lock = threading.Lock()   # the detector and the reader share the model files


# ----------------------------------------------------------------------------
# storage
# ----------------------------------------------------------------------------
def _safe(name: str) -> str:
    if not name.replace("-", "").replace(".", "").replace("_", "").isalnum() or ".." in name:
        raise HTTPException(400, "bad name")
    return name


def song_dir(song_id: str) -> Path:
    d = LIBRARY / _safe(song_id)
    if not (d / "meta.json").exists():
        raise HTTPException(404, "song not found")
    return d


def read_meta(d: Path) -> dict:
    return json.loads((d / "meta.json").read_text())


def write_meta(d: Path, meta: dict) -> None:
    with _meta_lock:
        meta["updated"] = time.time()
        tmp = d / "meta.json.tmp"
        tmp.write_text(json.dumps(meta, indent=1))
        tmp.replace(d / "meta.json")


SONG_VERSION = 4   # 4: parts lined up by the most common bar length, pick-ups kept short


def update_meta(d: Path, **changes) -> dict:
    with _meta_lock:
        meta = json.loads((d / "meta.json").read_text())
        meta.update(changes)
        meta["updated"] = time.time()
        tmp = d / "meta.json.tmp"
        tmp.write_text(json.dumps(meta, indent=1))
        tmp.replace(d / "meta.json")
    return meta


def summary(m: dict) -> dict:
    first = (m.get("pages") or [{}])[0].get("file")
    return {
        "id": m["id"], "title": m.get("title"), "status": m.get("status"), "progress": m.get("progress", 0),
        "message": m.get("message", ""), "updated": m.get("updated"), "created": m.get("created"),
        "pages": len(m.get("pages") or []),
        "thumb": f"/api/songs/{m['id']}/images/{first}" if first else None,
    }


def all_songs() -> List[dict]:
    out = []
    for d in LIBRARY.iterdir():
        if d.is_dir() and not d.name.startswith(".") and (d / "meta.json").exists():
            try:
                out.append(read_meta(d))
            except Exception:
                pass
    return out


# ----------------------------------------------------------------------------
# reading (one song at a time — the model is big)
# ----------------------------------------------------------------------------
def describe(units: List[dict]) -> str:
    def where(items):
        by_page = {}
        for u in items:
            by_page.setdefault(u["page"] + 1, []).append(u)
        return "; ".join(f"page {p}" for p in by_page)
    failed = [u for u in units if u["status"] == "failed"]
    partial = [u for u in units if u["status"] == "partial"]
    notes = []
    if failed:
        notes.append(f"{len(failed)} line{'s' if len(failed) > 1 else ''} couldn't be read ({where(failed)}) and will be skipped when playing.")
    if partial:
        notes.append(f"{len(partial)} line{'s were' if len(partial) > 1 else ' was'} only partly read ({where(partial)}).")
    return " ".join(notes)


MISSING_CHECK = 2   # bump to check songs again (2: bars that break the rules of written music)


def run_repair(d: Path, progress) -> None:
    """Re-read staves the reading missed and bars that break the rules of written music, then
    line the parts up again."""
    from app.check import check_song
    from app.omr import ENGINE
    from app.repair import repair_song
    from app.song import remerge

    meta = read_meta(d)
    if meta.get("original_abc") and meta.get("abc") != meta.get("original_abc"):
        update_meta(d, checked_missing=MISSING_CHECK)   # don't overwrite notes the user fixed
        return
    with _engine_lock:
        ENGINE.load()
        fixed = repair_song(d, meta, ENGINE, lambda m, f: progress(m, 0.4 * f))
        checked = check_song(d, meta, ENGINE, lambda m, f: progress(m, 0.4 + 0.6 * f))
    changes = {"checked_missing": MISSING_CHECK,
               "unsure": {str(k): {str(j): b for j, b in v.items()} for k, v in checked["unsure"].items()}}
    notes = []
    if fixed:
        staves = sorted({f["staff"] + 1 for f in fixed})
        lines = sorted({f["line"] + 1 for f in fixed})
        notes.append(f"The first reading missed staff {', '.join(map(str, staves))} on "
                     f"{len(lines)} line{'s' if len(lines) > 1 else ''}; those were read again on their own.")
    if checked["fixed"]:
        n = sum(len(f["bars"]) for f in checked["fixed"])
        notes.append(f"{n} bar{'s' if n > 1 else ''} that didn't add up (parts muddled together, ties going "
                     f"nowhere) were replaced by a second reading.")
    if fixed or checked["fixed"]:
        built = remerge(d, read_meta(d))
        if built:
            settings = {k: v for k, v in (meta.get("settings") or {}).items() if k != "range"}
            changes.update(abc=built["abc"], original_abc=built["abc"], lines=built["lines"], settings=settings,
                           notice=((meta.get("notice") or "") + " " + " ".join(notes)).strip())
            log.info("Fixed %d missed staves and %d checked staff-lines of %s", len(fixed), len(checked["fixed"]), d.name)
    update_meta(d, **changes)


def worker():
    from app.omr import ENGINE
    from app.song import build

    while True:
        job = jobs.get()
        kind, song_id = job if isinstance(job, tuple) else ("read", job)
        d = LIBRARY / song_id

        def progress(msg, frac, lo=0.0, hi=1.0):
            update_meta(d, status="working", progress=round(lo + (hi - lo) * frac, 3), message=msg)

        try:
            if kind == "repair":
                update_meta(d, status="working", job="repair", progress=0, message="Checking the reading…")
                run_repair(d, progress)
                update_meta(d, status="ready", job=None, progress=1.0, message="")
                continue
            meta = read_meta(d)
            pages = meta["pages"]
            paths = [str(d / "images" / p["file"]) for p in pages]
            with _engine_lock:
                result = ENGINE.transcribe(paths, progress=lambda m, f: progress(m, f, 0, 0.85), reading_dir=d / "reading")
            built = build(d / "images", pages, result.units, result.systems)
            abc = built["abc"]
            title = meta.get("title") or "Untitled"
            if abc.startswith("X:1\n") and "\nT:" not in "\n" + abc.split("\nK:")[0]:
                abc = abc.replace("X:1\n", f"X:1\nT:{title}\n", 1)
            update_meta(d, abc=abc, original_abc=abc, lines=built["lines"], notice=describe(result.units),
                        settings={}, version=SONG_VERSION)
            try:
                progress("Checking the reading…", 0, 0.85, 1.0)
                run_repair(d, lambda m, f: progress(m, f, 0.85, 1.0))
            except Exception as e:
                log.warning("Couldn't check for missed staves: %s", e)
            update_meta(d, status="ready", progress=1.0, message="")
        except Exception as e:
            log.error("Reading failed: %s\n%s", e, traceback.format_exc())
            update_meta(d, status="error" if kind == "read" else "ready", job=None, message=str(e) if kind == "read" else "")
        finally:
            jobs.task_done()


def preload():
    try:
        from app.omr import ENGINE
        with _engine_lock:
            ENGINE.load()
        log.info("Model ready on %s (%s)", ENGINE.info.device, ENGINE.info.dtype)
    except Exception as e:
        log.warning("Model not loaded yet: %s", e)


def migrate():
    """Bring songs saved by an earlier version of the app up to date (no model needed): line
    the parts up again from the saved per-line readings."""
    from app.song import remerge

    for meta in all_songs():
        d = LIBRARY / meta["id"]
        if meta.get("version") == SONG_VERSION or meta.get("status") != "ready":
            continue
        edited = meta.get("original_abc") and meta.get("abc") != meta.get("original_abc")
        built = None
        if not edited:
            try:
                built = remerge(d, meta)
            except Exception as e:
                log.warning("Couldn't update %s: %s", meta["id"], e)
        if built:
            # bar times may move, so a saved practice range could point at the wrong bars
            settings = {k: v for k, v in (meta.get("settings") or {}).items() if k != "range"}
            update_meta(d, version=SONG_VERSION, abc=built["abc"], original_abc=built["abc"],
                        lines=built["lines"], settings=settings)
            log.info("Updated %s", meta["id"])
        else:
            update_meta(d, version=SONG_VERSION)


# ----------------------------------------------------------------------------
# API
# ----------------------------------------------------------------------------
@app.get("/api/status")
def status():
    try:
        from app.omr import ENGINE
        info = dict(ENGINE.info.__dict__)
    except Exception as e:  # torch missing, etc.
        info = {"loaded": False, "error": str(e)}
    return {"engine": info, "queue": jobs.qsize()}


@app.get("/api/settings")
def get_settings():
    try:
        return json.loads(SETTINGS.read_text())
    except Exception:
        return {}


@app.put("/api/settings")
def put_settings(body: dict):
    current = get_settings()
    current.update(body)
    SETTINGS.write_text(json.dumps(current, indent=1))
    return current


# -- adding a song: upload, check pages, then read ------------------------------
@app.post("/api/uploads")
def upload(files: List[UploadFile] = File(...)):
    from app.song import has_music, save_pages, thumbnail

    if not files:
        raise HTTPException(400, "Add at least one photo or PDF")
    up = uuid.uuid4().hex[:12]
    d = UPLOADS / up
    (d / "src").mkdir(parents=True)
    sources = []
    for i, f in enumerate(files):
        ext = Path(f.filename or "").suffix.lower() or ".jpg"
        if ext not in {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".pdf"}:
            ext = ".jpg"
        p = d / "src" / f"{i:02d}{ext}"
        with open(p, "wb") as out:
            shutil.copyfileobj(f.file, out)
        sources.append(str(p))
    try:
        pages = save_pages(sources, d / "images")
    except Exception as e:
        raise HTTPException(400, f"Couldn't open that file: {e}")
    from app.omr import ENGINE
    out = []
    for n, p in enumerate(pages):
        thumbnail(d / "images" / p["file"], d / "images" / f"thumb-{p['file']}")
        with _engine_lock:
            music = has_music(ENGINE, d / "images" / p["file"])
        out.append({"n": n, "thumb": f"/api/uploads/{up}/thumb-{p['file']}", "music": music, "w": p["w"], "h": p["h"]})
    (d / "pages.json").write_text(json.dumps(pages))
    return {"upload": up, "pages": out}


@app.get("/api/uploads/{up}/{name}")
def upload_image(up: str, name: str):
    p = UPLOADS / _safe(up) / "images" / _safe(name)
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p)


class NewSong(BaseModel):
    upload: str
    title: str = ""
    pages: List[int]


@app.post("/api/songs")
def create_song(body: NewSong):
    src = UPLOADS / _safe(body.upload)
    if not (src / "pages.json").exists():
        raise HTTPException(404, "upload not found")
    all_pages = json.loads((src / "pages.json").read_text())
    chosen = [n for n in body.pages if 0 <= n < len(all_pages)]
    if not chosen:
        raise HTTPException(400, "Choose at least one page with music")
    song_id = uuid.uuid4().hex[:12]
    d = LIBRARY / song_id
    (d / "images").mkdir(parents=True)
    pages = []
    for k, n in enumerate(chosen, 1):
        p = all_pages[n]
        name = f"page-{k:02d}.jpg"
        shutil.copy(src / "images" / p["file"], d / "images" / name)
        pages.append({"file": name, "w": p["w"], "h": p["h"]})
    now = time.time()
    meta = {"id": song_id, "title": body.title.strip() or "Untitled song", "status": "queued", "progress": 0,
            "message": "Waiting to start…", "created": now, "pages": pages, "lines": [], "abc": "",
            "settings": {}, "version": SONG_VERSION}
    write_meta(d, meta)
    shutil.rmtree(src, ignore_errors=True)
    jobs.put(song_id)
    return meta


@app.post("/api/demo")
def create_demo():
    """Add the sample piece (The Turtle Dove, already read) so practice can be tried right away."""
    src = ROOT / "samples" / "turtle-dove"
    song_id = uuid.uuid4().hex[:12]
    d = LIBRARY / song_id
    shutil.copytree(src / "images", d / "images")
    meta = json.loads((src / "meta.json").read_text())
    now = time.time()
    meta.update(id=song_id, created=now, updated=now)
    write_meta(d, meta)
    return meta


@app.get("/api/songs")
def list_songs():
    songs = [summary(m) for m in all_songs()]
    songs.sort(key=lambda s: s.get("updated") or 0, reverse=True)
    return songs


@app.get("/api/songs/{song_id}")
def get_song(song_id: str):
    return read_meta(song_dir(song_id))


class SongUpdate(BaseModel):
    title: Optional[str] = None
    abc: Optional[str] = None
    settings: Optional[dict] = None


@app.put("/api/songs/{song_id}")
def put_song(song_id: str, body: SongUpdate):
    d = song_dir(song_id)
    changes = {k: v for k, v in body.model_dump().items() if v is not None}
    return update_meta(d, **changes)


@app.post("/api/songs/{song_id}/retry")
def retry(song_id: str):
    d = song_dir(song_id)
    meta = read_meta(d)
    if not meta.get("pages"):
        raise HTTPException(400, "No pages to read")
    update_meta(d, status="queued", progress=0, message="Waiting to start…")
    jobs.put(song_id)
    return {"ok": True}


@app.post("/api/songs/{song_id}/repair")
def repair(song_id: str):
    d = song_dir(song_id)
    meta = read_meta(d)
    if not (d / "reading").is_dir() or not meta.get("lines"):
        raise HTTPException(400, "This song has no saved reading to check")
    update_meta(d, status="queued", job="repair", progress=0, message="Waiting to start…", checked_missing=None)
    jobs.put(("repair", song_id))
    return {"ok": True}


@app.delete("/api/songs/{song_id}")
def delete_song(song_id: str):
    shutil.rmtree(song_dir(song_id))
    return {"ok": True}


@app.get("/api/songs/{song_id}/images/{name}")
def song_image(song_id: str, name: str):
    p = song_dir(song_id) / "images" / _safe(name)
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p, headers={"Cache-Control": "max-age=86400"})


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})


app.mount("/static", StaticFiles(directory=STATIC), name="static")


# ----------------------------------------------------------------------------
def main():
    import uvicorn

    migrate()
    model = os.environ.get("SECTIONAL_NO_MODEL") != "1"
    for meta in all_songs():
        d = LIBRARY / meta["id"]
        if meta.get("status") in ("queued", "working"):
            update_meta(d, status="queued", progress=0, message="Waiting to start…")
            jobs.put(("repair", meta["id"]) if meta.get("job") == "repair" else meta["id"])
        elif (model and meta.get("status") == "ready" and (d / "reading").is_dir()
              and (meta.get("checked_missing") or 0) < MISSING_CHECK):
            # songs read before the app looked for missed staves: look now
            update_meta(d, status="queued", job="repair", progress=0, message="Waiting to start…")
            jobs.put(("repair", meta["id"]))
    threading.Thread(target=worker, daemon=True).start()
    if os.environ.get("SECTIONAL_NO_MODEL") != "1":
        threading.Thread(target=preload, daemon=True).start()

    print("\n  🎶  Sectional is running")
    print(f"     Open http://localhost:{PORT}")
    print("     Leave this window open while you practice. Close it to stop.\n")
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
