"""Build the server-less demo of the practice app from a song in the library.

    python tools/build_demo.py library/<song id> <out>/app --id turtle-dove --title "The Turtle Dove"

Writes <out>/app/index.html (the app, answering its own requests with tools/demo.js), the app's
static files and sounds, and songs/<id>/ (page images, a thumbnail and the song's data).
"""
import argparse
import json
import shutil
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("song_dir", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--id", required=True)
    ap.add_argument("--title", required=True)
    a = ap.parse_args()

    meta = json.loads((a.song_dir / "meta.json").read_text())
    out = a.out
    if (out / "static").exists():
        shutil.rmtree(out / "static")
    shutil.copytree(ROOT / "static", out / "static", ignore=shutil.ignore_patterns("index.html", "test-score.png"))
    page = (ROOT / "static" / "index.html").read_text()
    page = page.replace('<script src="static/app.js"></script>', '<script src="demo.js"></script>\n<script src="static/app.js"></script>')
    page = page.replace("<title>Sectional</title>", f"<title>Sectional demo: {a.title}</title>")
    (out / "index.html").write_text(page)
    (out / "demo.js").write_text((ROOT / "tools" / "demo.js").read_text().replace("__SONG_ID__", a.id))

    dest = out / "songs" / a.id
    dest.mkdir(parents=True, exist_ok=True)
    for p in meta["pages"]:
        shutil.copyfile(a.song_dir / "images" / p["file"], dest / p["file"])
    thumb = Image.open(a.song_dir / "images" / meta["pages"][0]["file"])
    thumb.thumbnail((360, 720))
    thumb.convert("RGB").save(dest / "thumb.jpg", quality=82)
    keep = ("pages", "lines", "abc", "original_abc", "version")
    data = {"id": a.id, "title": a.title, "status": "ready", "progress": 1.0, "message": "", "notice": "",
            "settings": {}, **{k: meta[k] for k in keep if k in meta}}
    (dest / "meta.json").write_text(json.dumps(data))
    print("Demo written to", out)


if __name__ == "__main__":
    main()
