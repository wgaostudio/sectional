"""Where things are on the page photos: staves and bar lines inside each line of music.

Printed music is easy to measure: staff lines are long horizontal dark runs in groups of
five, and bar lines are vertical strokes that cross a whole staff at the same x on every
staff of the line. This lets the app highlight the bar being played on the singer's own
copy, and lets the singer pick their part by tapping their staff.
"""
from __future__ import annotations

from typing import List, Optional

import numpy as np
from PIL import Image


def _runs(mask: np.ndarray) -> List[tuple]:
    """(start, end) of consecutive True runs in a 1-D mask."""
    out, start = [], None
    for i, v in enumerate(mask):
        if v and start is None:
            start = i
        elif not v and start is not None:
            out.append((start, i - 1))
            start = None
    if start is not None:
        out.append((start, len(mask) - 1))
    return out


def ink(gray: np.ndarray, strict: bool = False) -> np.ndarray:
    """Dark-pixel mask, relative to the paper's brightness (photos are rarely pure white).
    strict: only clearly black ink (bar lines on scans); otherwise also thin grey lines."""
    paper = float(np.percentile(gray, 90))
    return gray < (min(150.0, paper - 100.0) if strict else min(200.0, paper - 60.0))


def find_staves(dark: np.ndarray) -> List[dict]:
    """Staves in a binarised line-of-music crop: [{lines: [5 y's], top, bottom, gap}]."""
    h, w = dark.shape
    band = dark[:, int(w * 0.2): int(w * 0.95)]
    frac = band.mean(axis=1)
    lines = [((a + b) / 2, b - a + 1) for a, b in _runs(frac > 0.45)]
    ys = [y for y, thick in lines if thick < 12]
    staves, i = [], 0
    while i + 4 < len(ys):
        five = ys[i:i + 5]
        gaps = np.diff(five)
        g = float(np.median(gaps))
        if g > 3 and np.all(np.abs(gaps - g) < 0.3 * g + 1.5):
            staves.append({"lines": [round(y, 1) for y in five], "top": five[0], "bottom": five[-1], "gap": g})
            i += 5
        else:
            i += 1
    return staves


def find_barlines(dark: np.ndarray, staves: List[dict]) -> List[float]:
    """x of bar lines (including the line at the start of the system), left to right."""
    if not staves:
        return []
    h, w = dark.shape
    per_staff = []
    for st in staves:
        top, bottom = int(round(st["top"])), int(round(st["bottom"]))
        cover = dark[top:bottom + 1, :].mean(axis=0)
        g = st["gap"]
        keep = []
        for a, b in _runs(cover > 0.9):
            width = b - a + 1
            if width > max(6, g * 0.9):
                continue
            # A bar line stands alone: just beside it there is only staff line (or the other
            # stroke of a double bar line). Clefs, time signatures and chords with stems have
            # more ink right next to the stroke.
            near = int(max(2, g * 0.25))
            far = int(max(near + 2, g * 0.8))
            others = np.where(cover > 0.9, 0.0, cover)
            left = others[max(0, a - far): max(0, a - near)]
            right = others[b + near: b + far]
            side = max(left.mean() if left.size else 0, right.mean() if right.size else 0)
            if side < 0.32:
                keep.append((a + b) / 2)
        per_staff.append(keep)
    gap = float(np.median([s["gap"] for s in staves]))
    tol = max(3.0, gap * 0.6)
    need = max(1, int(np.ceil(len(staves) * 0.6))) if len(staves) > 1 else 1
    candidates = sorted(x for xs in per_staff for x in xs)
    found: List[float] = []
    for x in candidates:
        if found and x - found[-1] < tol * 2:
            continue
        hits = sum(1 for xs in per_staff if any(abs(x2 - x) <= tol for x2 in xs))
        if hits >= need:
            found.append(x)
    # double bar lines / thick-thin pairs count once
    merged: List[float] = []
    for x in found:
        if merged and x - merged[-1] < gap * 1.5:
            merged[-1] = x
        else:
            merged.append(x)
    return merged


def staff_extent(dark: np.ndarray, staves: List[dict]) -> tuple:
    """Left and right ends of the staff lines (median over all lines of all staves)."""
    lefts, rights = [], []
    w = dark.shape[1]
    for st in staves:
        for y in st["lines"]:
            row = int(round(y))
            rows = dark[max(0, row - 1): row + 2, :].any(axis=0)
            runs = [r for r in _runs(rows) if r[1] - r[0] > w * 0.05]
            if runs:
                lefts.append(runs[0][0])
                rights.append(runs[-1][1])
    if not lefts:
        return 0, w - 1
    return float(np.median(lefts)), float(np.median(rights))


def staff_clef(dark: np.ndarray, st: dict, left: float) -> str:
    """'treble' or 'bass', from the clef's shape: a treble clef reaches well above the top
    line and below the bottom line; a bass clef stays inside the staff."""
    g = st["gap"]
    x0, x1 = int(left + 0.6 * g), int(left + 3.2 * g)
    if x1 <= x0:
        return ""
    def frac(y_from, y_to):
        a, b = int(max(0, y_from)), int(min(dark.shape[0], y_to))
        if b <= a:
            return 0.0
        return float(dark[a:b, x0:x1].any(axis=1).mean())
    above = frac(st["top"] - 1.4 * g, st["top"] - 0.45 * g)
    below = frac(st["bottom"] + 0.45 * g, st["bottom"] + 1.2 * g)
    return "treble" if (above + below) / 2 > 0.35 else "bass"


def analyse_line(page: Image.Image, box: List[int], staff_voices: Optional[List[List[str]]] = None) -> dict:
    """Staves and printed bars of one line of music, in page coordinates.

    staff_voices: the line's staves top-to-bottom as lists of voice ids, from the reading;
    attached to the detected staves when the counts agree.
    """
    x0, y0, x1, y1 = box
    crop = page.crop((x0, y0, x1, y1)).convert("L")
    gray = np.asarray(crop)
    dark = ink(gray, strict=True)
    staves = find_staves(dark)
    loose = find_staves(ink(gray))
    if len(loose) > len(staves):          # faint, thin staff lines (e.g. computer-made pages)
        dark, staves = ink(gray), loose
    if not staves:
        return {"staves": [], "bounds": [], "musicTop": y0, "musicBottom": y1}
    xs = find_barlines(dark, staves)
    left, right = staff_extent(dark, staves)
    gap = float(np.median([s["gap"] for s in staves]))

    # Printed bars: from the start of the music (after clef and key) through each bar line.
    music_start = left + gap * 6
    inner = [x for x in xs if x > left + gap * 2]
    bounds = [music_start] + [x for x in inner if x > music_start + gap]
    if bounds[-1] < right - gap * 2:
        bounds.append(right)

    out_staves = []
    for k, st in enumerate(staves):
        above = staves[k - 1]["bottom"] if k else None
        below = staves[k + 1]["top"] if k + 1 < len(staves) else None
        top = (above + st["top"]) / 2 if above is not None else st["top"] - 2.5 * st["gap"]
        bottom = (st["bottom"] + below) / 2 if below is not None else st["bottom"] + 2.5 * st["gap"]
        out_staves.append({
            "y0": round(y0 + max(0, top)), "y1": round(y0 + min(y1 - y0, bottom)),
            "top": round(y0 + st["top"], 1), "bottom": round(y0 + st["bottom"], 1),
            "clef": staff_clef(dark, st, left),
            "voices": [],
        })
    if staff_voices and len(staff_voices) == len(out_staves):
        for st, vs in zip(out_staves, staff_voices):
            st["voices"] = list(vs)
    return {
        "staves": out_staves,
        "left": round(x0 + left), "right": round(x0 + right),
        "bounds": [round(x0 + b, 1) for b in bounds],
        "musicTop": round(y0 + staves[0]["top"] - 2 * gap),
        "musicBottom": round(y0 + staves[-1]["bottom"] + 2 * gap),
    }
