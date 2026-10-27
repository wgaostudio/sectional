"""A song's pages, its lines of music and their timing — everything the practice screen needs."""
from __future__ import annotations

import re
from pathlib import Path
from typing import List, Optional

from PIL import Image

from app.abc_merge import merge
from app.layout import analyse_line
from app.omr import load_pages



def save_pages(sources: List[str], dest: Path, start: int = 1) -> List[dict]:
    """Render photos/PDFs to page images in `dest`; returns [{file, w, h}]."""
    dest.mkdir(parents=True, exist_ok=True)
    out = []
    for k, img in enumerate(load_pages(sources), start):
        name = f"page-{k:02d}.jpg"
        img.convert("RGB").save(dest / name, quality=90)
        out.append({"file": name, "w": img.width, "h": img.height})
    return out


def thumbnail(src: Path, dest: Path, width: int = 360):
    img = Image.open(src)
    img.thumbnail((width, width * 2))
    img.convert("RGB").save(dest, quality=82)


def has_music(engine, image_path: Path) -> bool:
    try:
        det = engine.load_detector()
        img = Image.open(image_path).convert("RGB")
        res = det.predict(img, conf=0.7, imgsz=640, verbose=False, device="cpu")
        return bool(len(res) and len(res[0].boxes))
    except Exception:
        return True   # can't tell: let the reading decide


def build(page_dir: Path, pages: List[dict], units: List[dict], outputs: List[str]) -> dict:
    """Merge the per-line readings and locate everything on the pages.

    units: every detected line in reading order: {page, box, status, out}
    outputs: the usable readings (indexed by unit["out"]).
    """
    merged = merge(outputs)
    images = {}
    lines = []
    for u in units:
        timing = merged.lines[u["out"]] if u.get("out") is not None and u["out"] < len(merged.lines) else None
        if u["page"] not in images:
            images[u["page"]] = Image.open(page_dir / pages[u["page"]]["file"])
        geo = analyse_line(images[u["page"]], u["box"], timing["staves"] if timing else None)
        lines.append({
            "page": u["page"],
            "box": u["box"],
            "status": u["status"] if timing else "failed",
            "start": timing["start"] if timing else None,
            "bars": timing["bars"] if timing else [],
            **geo,
        })
    return {"abc": merged.abc, "lines": lines}


def remerge(song_dir: Path, meta: dict) -> Optional[dict]:
    """Line the parts up again from the saved per-line readings (no model needed)."""
    reading = song_dir / "reading"
    lines = meta.get("lines") or []
    if not reading.is_dir() or not lines or not meta.get("pages"):
        return None
    units, outputs = [], []
    for k, L in enumerate(lines, 1):
        f = reading / f"system-{k:02d}.abc"
        raw = f.read_text() if f.exists() else ""
        m = re.match(r"^% (ok|partial|failed)\n", raw)
        if not m:
            return None
        status, abc = m.group(1), raw[m.end():]
        unit = {"page": L["page"], "box": L["box"], "status": status, "out": None}
        if status != "failed" and abc.strip():
            unit["out"] = len(outputs)
            outputs.append(abc)
        units.append(unit)
    if not outputs:
        return None
    return build(song_dir / "images", meta["pages"], units, outputs)
