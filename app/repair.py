"""Find staves the reading missed, and read them again on their own.

Legato reads a whole line of music (every staff) at once. On busy pages it sometimes leaves a
staff out: the Basses of a men's chorus came back as empty bars on most lines, with the piano
written instead. This module spots a sung staff whose part came back (nearly) empty while
there is music printed on it, crops just that staff from the page photo, reads the crop by
itself, and puts the result in place of the empty part. The original reading of each line is
kept next to it (system-XX-orig.abc).
"""
from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

import numpy as np
from PIL import Image

from app.abc_merge import parse_system, tidy
from app.layout import ink

log = logging.getLogger("sectional.repair")

_CLEF = re.compile(r"\b(treble|bass|alto|tenor)\b")
_NAME = re.compile(r'\bnm="([^"]*)"')


def _clef_kind(c: str) -> str:
    return "bass" if c.startswith("bass") else "treble"


def note_count(lines: List[str]) -> int:
    text = "\n".join(lines)
    text = re.sub(r'"[^"]*"|![^!]*!|\[[A-Za-z]:[^\]]*\]|%.*', " ", text)
    text = re.sub(r"\[[^\]]*\]", "C", text)            # a chord counts as one note
    return len(re.findall(r"[A-Ga-g]", text))


def map_voices(order: List[str], defs: Dict[str, str], counts: Dict[str, int],
               page_clefs: List[str]) -> Tuple[Dict[str, int], int]:
    """Match the reading's voices (in order) to the page's staves by clef; the same rule the
    practice screen uses. Returns ({voice: staff index}, index of the first piano staff)."""
    N, M = len(page_clefs), len(order)
    if not N or not M:
        return {}, N
    INF, SKIP = 1e9, 20.0
    def clef(v):
        m = _CLEF.search(defs.get(v, ""))
        return _clef_kind(m.group(1)) if m else "treble"
    def cost(i, j):
        w = min(1.0, counts.get(order[i], 0) / 8)
        return (0 if clef(order[i]) == _clef_kind(page_clefs[j]) else 10 * w) + 0.01 * (N - j)
    dp = [[INF] * N for _ in range(M)]
    frm = [[-1] * N for _ in range(M)]
    for j in range(N):
        dp[0][j] = SKIP * j + cost(0, j)
    for i in range(1, M):
        for j in range(N):
            for k in range(j + 1):
                c = dp[i - 1][k] + SKIP * max(0, j - k - 1) + cost(i, j)
                if c < dp[i][j]:
                    dp[i][j], frm[i][j] = c, k
    best = min(range(N), key=lambda j: dp[M - 1][j] + SKIP * (N - 1 - j))
    staff = [0] * M
    j = best
    for i in range(M - 1, -1, -1):
        staff[i] = j
        j = frm[i][j]
    out = {v: staff[i] for i, v in enumerate(order)}
    piano = next((i for i, v in enumerate(order) if re.search(r"pian|pno", (_NAME.search(defs.get(v, "")) or [None, ""])[1], re.I)), None)
    return out, (staff[piano] if piano is not None else N)


def staff_has_music(page: Image.Image, line: dict, j: int) -> float:
    """How much ink sits on staff j apart from its five lines (notes, stems, rests)."""
    st = line["staves"][j]
    gap = (st["bottom"] - st["top"]) / 4
    x0, x1 = line.get("left", line["box"][0]), line.get("right", line["box"][2])
    x0 += 6 * gap                                        # skip clef and key signature
    crop = page.crop((int(x0), int(st["top"] - gap), int(x1), int(st["bottom"] + gap))).convert("L")
    dark = ink(np.asarray(crop))
    rows = dark.mean(axis=1) > 0.45                      # staff lines
    dark[rows, :] = False
    return float(dark.mean())


def find_missing(meta: dict, systems: Dict[int, str], page_images: Callable[[int], Image.Image]) -> List[dict]:
    """Sung staves that came back (nearly) empty while the page has music on them.
    systems: line index -> that line's reading. Returns [{line, staff, voices}]."""
    first = next((systems[k] for k in sorted(systems)), None)
    if first is None:
        return []
    head = parse_system(tidy(first), True)
    defs = dict(head.voice_defs)
    parsed = {k: parse_system(tidy(t), k == min(systems)) for k, t in systems.items()}
    # match voices to staves once, over the whole song (as the practice screen does): one
    # line's empty voice says nothing about which staff it belongs to
    order: List[str] = []
    total: Dict[str, int] = {}
    for k in sorted(parsed):
        s = parsed[k]
        for v, dd in s.voice_defs.items():
            defs.setdefault(v, dd)
        for v in s.order:
            if v not in order:
                order.append(v)
            total[v] = total.get(v, 0) + note_count(s.voices[v])
    ref = next((L for L in meta.get("lines") or [] if L.get("staves") and all(st.get("clef") for st in L["staves"])), None)
    if not ref:
        return []
    clefs = [st["clef"] for st in ref["staves"]]
    vmap, piano_from = map_voices(order, defs, total, clefs)
    out = []
    for k, L in enumerate(meta.get("lines") or []):
        if k not in parsed or L.get("status") == "failed" or len(L.get("staves") or []) != len(clefs):
            continue
        s = parsed[k]
        counts = {v: note_count(s.voices[v]) for v in s.order}
        bars = max(1, len(L.get("bars") or []))
        notes_on = [0] * len(clefs)
        for v, c in counts.items():
            if v in vmap:
                notes_on[vmap[v]] += c
        sung = [j for j in range(min(piano_from, len(clefs)))]
        if len(sung) < 2:
            continue
        page = page_images(L["page"])
        ink_on = {j: staff_has_music(page, L, j) for j in sung}
        busy = [ink_on[j] for j in sung if notes_on[j] >= bars]
        if not busy:
            continue
        typical = float(np.median(busy))
        for j in sung:
            if notes_on[j] < 0.5 * bars and ink_on[j] > 0.35 * typical:
                out.append({"line": k, "staff": j, "voices": [v for v in s.order if vmap.get(v) == j]})
    return out


def fits(got, bars: List[float]) -> bool:
    """Does a staff read on its own have the line's bars (same count, each no longer than the
    line's bar, apart from rests at the end)? A misread here mustn't upset the whole line."""
    from app.abc_time import _floor, _parse_header, split_bars
    if not bars:
        return True
    unit, meter = _parse_header(got.header)
    for v in got.order:
        if not note_count(got.voices[v]):
            continue
        evs: list = []
        segs, durs, _ = split_bars("\n".join(got.voices[v]), unit, meter, evs)
        if len(durs) == len(bars):
            if any(float(_floor(d, e)) > t + 1e-6 for d, e, t in zip(durs, evs, bars)):
                return False
        elif abs(float(sum(durs)) - sum(bars)) > 1e-6:
            return False          # a missed bar line is fine (it's put back) if the length is right
    return True


_TOKEN = re.compile(r'"[^"]*"|![^!]*!|\[[A-Za-z]:[^\]]*\]|%.*|([=^_]*)([A-Ga-g])([,\']*)')
_STEP = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def _pitches(lines: List[str]) -> List[int]:
    out = []
    for m in _TOKEN.finditer("\n".join(lines)):
        if m.group(2):
            letter, marks = m.group(2), m.group(3)
            p = 60 + _STEP[letter.upper()] + (12 if letter.islower() else 0)
            out.append(p - 12 * marks.count(",") + 12 * marks.count("'"))
    return out


def shift_octaves(line: str, n: int) -> str:
    """Move every note of an ABC music line n octaves (leaving text, decorations, fields)."""
    def move(m):
        if not m.group(2):
            return m.group(0)
        acc, letter, marks = m.group(1), m.group(2), m.group(3)
        p = (1 if letter.islower() else 0) - marks.count(",") + marks.count("'") + n
        if p >= 1:
            return acc + letter.lower() + "'" * (p - 1)
        return acc + letter.upper() + "," * (-p)
    return _TOKEN.sub(move, line)


def fix_octave(lines: List[str], clef: str) -> Tuple[List[str], int]:
    """A staff read on its own sometimes comes back an octave off (a bass part around B♭1).
    Bring it into the range singers on that clef actually sing. Returns (lines, octaves moved)."""
    ps = sorted(_pitches(lines))
    if not ps:
        return lines, 0
    median = ps[len(ps) // 2]
    lo, hi = (45, 64) if clef == "bass" else (57, 84)
    n = 0
    while median + 12 * n < lo:
        n += 1
    while median + 12 * n > hi:
        n -= 1
    return ([shift_octaves(l, n) for l in lines] if n else lines), n


def _field(header: List[str], key: str) -> Optional[str]:
    for h in header:
        if h.startswith(key + ":"):
            return h[len(key) + 1:].strip()
    return None


def splice(system_text: str, voices: List[str], reread: str, song_header: List[str], first: bool = False,
           song_defs: Optional[Dict[str, str]] = None) -> Optional[str]:
    """Put the music read from the staff crop in place of the (empty) voices of that staff."""
    new = parse_system(tidy(reread), True)
    parts = [v for v in new.order if note_count(new.voices[v]) > 0] or new.order
    if not parts or not voices:
        return None
    prefix = ""
    unit, key = _field(new.header, "L"), _field(new.header, "K")
    song_unit, song_key = _field(song_header, "L") or "1/8", _field(song_header, "K")
    if unit and unit != song_unit:
        prefix += f"[L:{unit}]"
    suffix = ""
    if key and song_key and key.split()[0] != song_key.split()[0]:
        prefix += f"[K:{key}]"
        suffix = f"[K:{song_key}]"
    if unit and unit != song_unit:
        suffix += f"[L:{song_unit}]"

    s = parse_system(tidy(system_text), first)
    target_def = s.voice_defs.get(voices[0], "") or (song_defs or {}).get(voices[0], "") or new.voice_defs.get(parts[0], "")
    m = _CLEF.search(target_def)
    clef = _clef_kind(m.group(1)) if m else "treble"

    def music(v):
        lines = [l for l in new.voices[v] if l.strip()]
        if not lines:
            return []
        lines, moved = fix_octave(lines, clef)
        if moved:
            log.info("Moved a re-read staff %+d octave(s) into the %s-clef singing range", moved, clef)
        lines[0] = prefix + lines[0]
        if suffix:
            last = lines[-1].rstrip()
            lines[-1] = (last[:-1] + suffix + " $") if last.endswith("$") else last + suffix
        return lines

    out, done = [], set()
    status = system_text.split("\n", 1)[0] if system_text.startswith("% ") else None
    if status:
        out.append(status)
    out.extend(h for h in s.header if not h.startswith("%"))
    for v in s.order:
        out.append(f"V:{v} {s.voice_defs.get(v, '')}".rstrip())
        if v == voices[0]:
            out.extend(music(parts[0]))
            for n, extra in enumerate(parts[1:], 1):     # more parts on that staff
                out.append(f"V:{voices[0]}x{n} {s.voice_defs.get(v, '')}".rstrip())
                out.extend(music(extra))
        elif v in voices:
            pass                                           # leave the others on that staff empty
        else:
            out.extend(s.voices[v])
        done.add(v)
    if s.score:
        out.append("%%score " + s.score)
    return "\n".join(out) + "\n"


def staff_reading(reading: Path, page: Image.Image, L: dict, k: int, j: int, engine) -> Tuple[str, str]:
    """Staff j of line k read on its own (saved as system-XX-staffN.abc and reused)."""
    saved = reading / f"system-{k + 1:02d}-staff{j + 1}.abc"
    m = re.match(r"^% (ok|partial|failed)\n", saved.read_text()) if saved.exists() else None
    if m:
        return saved.read_text()[m.end():], m.group(1)
    st, box = L["staves"][j], L["box"]
    crop = page.crop((box[0], int(st["y0"]), box[2], int(st["y1"])))
    crop.save(reading / f"system-{k + 1:02d}-staff{j + 1}.png")
    abc, status, _ = engine.read_system(crop, [], first=True)
    saved.write_text(f"% {status}\n" + (abc or ""))
    return abc or "", status


def repair_song(song_dir: Path, meta: dict, engine, progress: Callable[[str, float], None]) -> List[dict]:
    """Re-read missed staves of a song in place (reading/system-XX.abc). Returns what was fixed."""
    reading = song_dir / "reading"
    systems: Dict[int, str] = {}
    for k in range(len(meta.get("lines") or [])):
        orig = reading / f"system-{k + 1:02d}-orig.abc"
        f = orig if orig.exists() else reading / f"system-{k + 1:02d}.abc"
        if f.exists():
            raw = f.read_text()
            m = re.match(r"^% (ok|partial|failed)\n", raw)
            if m and m.group(1) != "failed":
                systems[k] = raw
    if not systems:
        return []
    images: Dict[int, Image.Image] = {}

    def page(i):
        if i not in images:
            images[i] = Image.open(song_dir / "images" / meta["pages"][i]["file"]).convert("RGB")
        return images[i]

    todo = find_missing(meta, systems, page)
    if not todo:
        return []
    head = parse_system(tidy(systems[min(systems)]), True)
    song_header, song_defs = head.header, head.voice_defs
    fixed = []
    by_line: Dict[int, str] = {}
    for n, item in enumerate(todo):
        k, j = item["line"], item["staff"]
        L = meta["lines"][k]
        progress(f"Reading the {_ordinal(j + 1)} staff of line {k + 1} again on its own…", n / len(todo))
        abc, status = staff_reading(reading, page(L["page"]), L, k, j, engine)
        if status == "failed" or not abc.strip():
            continue
        got = parse_system(tidy(abc), True)
        if sum(note_count(got.voices[v]) for v in got.order) == 0:
            continue                                     # nothing to sing there after all
        if not fits(got, L.get("bars") or []):
            log.info("Re-read of line %d staff %d doesn't fit the line's bars; kept the original", k + 1, j + 1)
            continue
        base = by_line.get(k, systems[k])
        new = splice(base, item["voices"], abc, song_header, first=(k == min(systems)), song_defs=song_defs)
        if not new:
            continue
        by_line[k] = new
        fixed.append({"line": k, "staff": j})
    for k, text in by_line.items():
        orig = reading / f"system-{k + 1:02d}-orig.abc"
        cur = reading / f"system-{k + 1:02d}.abc"
        if not orig.exists():
            orig.write_text(cur.read_text())
        cur.write_text(text)
    return fixed


def _ordinal(n: int) -> str:
    return {1: "1st", 2: "2nd", 3: "3rd"}.get(n, f"{n}th")
