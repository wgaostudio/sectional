"""Check every sung staff for signs of a misreading, and fix the bars that fail.

The model reads a whole line of music at once. On busy staves (two parts sharing a staff,
lyrics, a piano below) it sometimes muddles the parts: a tied whole note in one part becomes a
half note followed by a note from the other part. Such mistakes break rules that written music
almost always keeps, so each bar of a staff is scored against them:

  hard   each part fills the bar exactly (notes and rests add up to the bar's length);
         a tied note carries on at the same pitch;
         on a staff with two parts there are two notes, or a rest, at every moment
  soft   no more notes at once than parts; no leaps of more than a sixth within a part;
         no seconds or sevenths between the parts on a beat

Checking costs nothing. Only lines whose reading breaks a hard rule get the staff read again,
on its own and, if that isn't clean either, together with its neighbour. Each bar is then taken
from the reading that keeps the rules best (on a tie, the one the others agree with most).
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple

from PIL import Image

from app.abc_merge import parse_system, tidy
from app.abc_time import _parse_header, align_system, split_bars
from app.repair import map_voices, note_count, splice, staff_reading

log = logging.getLogger("sectional.check")

_PITCH = re.compile(r"([=^_]*)([A-Ga-g])([,']*)")
_STEP = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
_ACC = {"^": 1, "^^": 2, "_": -1, "__": -2, "=": 0, "": 0}
PREFERENCE = ["alone", "pair", "line"]          # who wins when everything else is equal
HARD = 0.5                                      # a bar scoring this much (in beats) needs a second look


_KEY_FIFTHS = {"Cb": -7, "Gb": -6, "Db": -5, "Ab": -4, "Eb": -3, "Bb": -2, "F": -1, "C": 0, "G": 1, "D": 2,
               "A": 3, "E": 4, "B": 5, "F#": 6, "C#": 7}
_SHARPS, _FLATS = "FCGDAEB", "BEADGCF"
KEY: Dict[str, int] = {}          # letter -> semitones, from the song's key signature (set per song)


def set_key(k: str) -> None:
    """Key signature from a K: field ("Db", "Gm", "A mix"...); minor/modes counted as their relative major."""
    KEY.clear()
    m = re.match(r"\s*([A-G][b#]?)(m(?:in)?|min|maj|mix|dor|phr|lyd|loc)?", k or "C", re.I)
    if not m:
        return
    root = m.group(1)
    shift = {"m": -3, "min": -3, "mix": -1, "dor": -2, "phr": -4, "lyd": 1, "loc": -5}.get((m.group(2) or "").lower(), 0)
    fifths = _KEY_FIFTHS.get(root, 0) + shift
    for c in (_SHARPS[:fifths] if fifths > 0 else _FLATS[:-fifths]):
        KEY[c] = 1 if fifths > 0 else -1


def _pitch(acc: str, letter: str, marks: str) -> int:
    p = 60 + _STEP[letter.upper()] + (12 if letter.islower() else 0)
    p += _ACC[acc] if acc else KEY.get(letter.upper(), 0)
    return p + 12 * marks.count("'") - 12 * marks.count(",")


@dataclass
class Note:
    t0: Fraction
    t1: Fraction
    pitches: List[int]
    tie: bool
    voice: int


@dataclass
class Reading:
    """One reading of one staff on one line."""
    name: str
    unit: Fraction
    segs: List[List[str]] = field(default_factory=list)      # per part: bar texts (lined up)
    durs: List[List[Fraction]] = field(default_factory=list)
    raw: List[List[Fraction]] = field(default_factory=list)  # per part: bar lengths as read
    notes: List[Note] = field(default_factory=list)
    rests: List[Tuple[Fraction, Fraction, int]] = field(default_factory=list)

    @classmethod
    def build(cls, name: str, voices: List[List[str]], unit: Fraction, meter: Fraction,
              context: Optional[Dict[str, List[str]]] = None) -> "Reading":
        """voices: this staff's parts (music lines). context: the whole system's voices,
        so the parts are lined up exactly as the merge will line them up."""
        r = cls(name, unit)
        # A staff holds at most two parts. A third voice with only a few notes is the reader
        # hedging (stray notes copied from a neighbour); leave it out.
        counts = [note_count(v) for v in voices]
        if len(voices) >= 3:
            most = max(counts)
            voices = [v for v, c in zip(voices, counts) if c >= 0.35 * most] or voices
        ids = [str(i) for i in range(len(voices))]
        allv = dict(zip(ids, voices))
        order = list(ids)
        if context:
            for k, v in context.items():
                if v not in voices:
                    allv["c" + k] = v
                    order.append("c" + k)
        aligned, _ = align_system(allv, order, {i: unit for i in order}, meter)
        for vi, i in enumerate(ids):
            _, raw, _ = split_bars("\n".join(voices[vi]), unit, meter)
            r.raw.append(raw)
            evs: list = []
            segs, durs, _ = split_bars("\n".join(aligned.get(i) or []), unit, meter, evs)
            r.segs.append(segs)
            r.durs.append(durs)
            t = Fraction(0)
            for seg, d, ev in zip(segs, durs, evs):
                for e in ev:
                    a, b = t + e["t0"], t + e["t1"]
                    if e["kind"] == "note":
                        ps = [_pitch(*m.groups()) for m in _PITCH.finditer(seg[e["s"]:e["e"]])]
                        if ps:
                            r.notes.append(Note(a, b, ps, e["tie"], vi))
                    elif e["kind"] in ("z", "Z"):
                        r.rests.append((a, b, vi))
                t += d
        return r

    def bar_text(self, t0: Fraction, t1: Fraction) -> Optional[List[str]]:
        out = []
        for segs, durs in zip(self.segs, self.durs):
            t, found = Fraction(0), None
            for s, d in zip(segs, durs):
                if t == t0 and t + d == t1:
                    found = s
                t += d
            if found is None:
                return None
            out.append(found)
        return out

    def notes_in(self, t0: Fraction, t1: Fraction) -> set:
        return {(n.t0 - t0, p, n.t1 - n.t0) for n in self.notes if t0 <= n.t0 < t1 for p in n.pitches}


def two_parts(readings: List[Reading]) -> bool:
    """Does this staff carry two parts on this line? (notes stacked, or two voices with notes)"""
    for r in readings:
        voices = {n.voice for n in r.notes}
        onsets: Dict[Fraction, set] = {}
        for n in r.notes:
            onsets.setdefault(n.t0, set()).update(n.pitches)
        if len(voices) >= 2 or (onsets and sum(len(v) >= 2 for v in onsets.values()) / len(onsets) > 0.25):
            return True
    return False


def score_bar(r: Reading, k: int, t0: Fraction, t1: Fraction, parts: int, beat: Fraction,
              line_end: Fraction) -> Tuple[float, float]:
    """(hard, soft) penalties of reading r for bar k = [t0, t1), in beats."""
    hard = soft = 0.0
    target = t1 - t0
    # each part fills the bar as read
    for vi, raw in enumerate(r.raw):
        if len(raw) == len(r.durs[vi]) and k < len(raw):
            if any(t0 <= n.t0 < t1 and n.voice == vi for n in r.notes):
                hard += float(abs(raw[k] - target) / beat)
    # ties carry on
    for n in r.notes:
        if n.tie and t0 <= n.t0 < t1 and n.t1 < line_end:
            nxt = {p for m in r.notes if m.t0 == n.t1 for p in m.pitches}
            hard += sum(1 for p in n.pitches if p not in nxt)
    # every part sounding or resting at every moment; not more notes than parts
    cuts = sorted({t0, t1} | {x for n in r.notes for x in (n.t0, n.t1) if t0 < x < t1}
                  | {x for a, b, _ in r.rests for x in (a, b) if t0 < x < t1})
    for a, b in zip(cuts, cuts[1:]):
        sounding = {p for n in r.notes if n.t0 <= a < n.t1 for p in n.pitches}
        resting = {v for x, y, v in r.rests if x <= a < y}
        if not sounding and resting:
            continue
        gap = max(0, parts - len(sounding) - len(resting))
        hard += float(gap * (b - a) / beat)
        soft += 0.5 * float(max(0, len(sounding) - parts) * (b - a) / beat)
    # within each part: no big leaps; between the parts: no 2nds/7ths on a beat
    onsets = sorted({n.t0 for n in r.notes if t0 <= n.t0 < t1})
    prev_hi = prev_lo = None
    for at in onsets:
        sounding = sorted({p for n in r.notes if n.t0 <= at < n.t1 for p in n.pitches})
        if not sounding:
            continue
        hi, lo = sounding[-1], sounding[0]
        if prev_hi is not None and abs(hi - prev_hi) > 9:
            soft += 0.5
        if parts == 2 and prev_lo is not None and len(sounding) > 1 and abs(lo - prev_lo) > 9:
            soft += 0.5
        if parts == 2 and len(sounding) > 1 and ((at - t0) / beat).denominator == 1 and (hi - lo) % 12 in (1, 2, 10, 11):
            soft += 0.25
        prev_hi, prev_lo = hi, lo
    return hard, soft


def agreement(a: set, b: set) -> float:
    return 1.0 if not a and not b else len(a & b) / len(a | b)


def choose(readings: List[Reading], bars: List[Fraction], beat: Fraction) -> Tuple[List[str], List[float]]:
    """The reading to take each bar from, and how far the chosen bar still breaks the rules."""
    parts = 2 if two_parts(readings) else 1
    end = sum(bars, Fraction(0))
    picks, left = [], []
    t = Fraction(0)
    for k, d in enumerate(bars):
        t0, t1 = t, t + d
        t = t1
        usable = [r for r in readings if r.bar_text(t0, t1) is not None]
        if not usable:
            picks.append("line")
            left.append(0.0)
            continue
        notes = {r.name: r.notes_in(t0, t1) for r in readings}

        def key(r):
            h, s = score_bar(r, k, t0, t1, parts, beat, end)
            agree = sum(agreement(notes[r.name], notes[o.name]) for o in readings if o is not r)
            return (round(h + s, 3), -round(agree, 3), PREFERENCE.index(r.name)), h

        # keep the line's own reading unless it breaks a rule another reading keeps better
        line = next((r for r in usable if r.name == "line"), None)
        ranked = sorted(usable, key=lambda r: key(r)[0])
        best = ranked[0]
        if line is not None:
            lh, ls = score_bar(line, k, t0, t1, parts, beat, end)
            bh, bs = score_bar(best, k, t0, t1, parts, beat, end)
            if lh + ls < HARD or bh + bs >= lh + ls:
                best = line
                # the line's reading keeps the rules, but if the two other readings agree with
                # each other and not with it, two against one: take theirs
                if len(usable) >= 3:
                    agree = {r.name: sum(agreement(notes[r.name], notes[o.name]) for o in usable if o is not r) for r in usable}
                    top = max(usable, key=lambda r: (agree[r.name], -PREFERENCE.index(r.name)))
                    th, ts = score_bar(top, k, t0, t1, parts, beat, end)
                    if top is not line and agree[top.name] > agree["line"] + 0.25 and th + ts < HARD:
                        best = top
        picks.append(best.name)
        left.append(key(best)[1])
    return picks, left


# ---------------------------------------------------------------------------------- the pass
def neighbour(j: int, sung: int) -> int:
    """The staff read together with staff j: the next sung staff down, else the one above."""
    return j + 1 if j + 1 < sung else j - 1


def pair_reading(reading: Path, page: Image.Image, L: dict, k: int, j: int, engine, nb: int) -> Tuple[str, str]:
    """Staff j read together with staff nb (saved as system-XX-pairN.abc and reused)."""
    saved = reading / f"system-{k + 1:02d}-pair{j + 1}.abc"
    m = re.match(r"^% (ok|partial|failed)\n", saved.read_text()) if saved.exists() else None
    if m:
        return saved.read_text()[m.end():], m.group(1)
    staves = L["staves"]
    top, bottom = staves[min(j, nb)], staves[max(j, nb)]
    box = L["box"]
    crop = page.crop((box[0], int(top["y0"]), box[2], int(bottom["y1"])))
    abc, status, _ = engine.read_system(crop, [], first=True)
    saved.write_text(f"% {status}\n" + (abc or ""))
    return abc or "", status


def _fmt(unit: Fraction) -> str:
    return f"{unit.numerator}/{unit.denominator}"


def check_song(song_dir: Path, meta: dict, engine, progress: Callable[[str, float], None]) -> Dict:
    """Check every sung staff of every line; re-read and fix where a hard rule is broken.
    Returns {"fixed": [{line, staff, bars}], "unsure": {line: {staff: [bars]}}}."""
    reading = song_dir / "reading"
    lines = meta.get("lines") or []
    texts: Dict[int, str] = {}
    for k in range(len(lines)):
        f = reading / f"system-{k + 1:02d}.abc"
        if f.exists() and not f.read_text().startswith("% failed"):
            texts[k] = f.read_text()
    if not texts:
        return {"fixed": [], "unsure": {}}
    first = min(texts)
    head = parse_system(tidy(texts[first]), True)
    unit, meter = _parse_header(head.header)
    set_key(next((h[2:].strip() for h in head.header if h.startswith("K:")), "C"))
    beat = Fraction(1, 4) if meter.denominator <= 4 or meter.numerator % 3 else Fraction(3, 8)
    defs = dict(head.voice_defs)
    parsed = {k: parse_system(tidy(t), k == first) for k, t in texts.items()}
    order, total = [], {}
    for k in sorted(parsed):
        for v, dd in parsed[k].voice_defs.items():
            defs.setdefault(v, dd)
        for v in parsed[k].order:
            if v not in order:
                order.append(v)
            total[v] = total.get(v, 0) + note_count(parsed[k].voices[v])
    ref = next((L for L in lines if L.get("staves") and all(st.get("clef") for st in L["staves"])), None)
    if not ref:
        return {"fixed": [], "unsure": {}}
    clefs = [st["clef"] for st in ref["staves"]]
    base = lambda v: re.sub(r"x\d+$", "", v)
    vmap, piano_from = map_voices([v for v in order if base(v) == v], defs, total, clefs)
    sung = list(range(min(piano_from, len(clefs))))

    images: Dict[int, Image.Image] = {}

    def page(i):
        if i not in images:
            images[i] = Image.open(song_dir / "images" / meta["pages"][i]["file"]).convert("RGB")
        return images[i]

    def other(abc, keep):
        """A re-read's parts for this staff, or None if it can't be used."""
        if not abc.strip():
            return None
        s = parse_system(tidy(abc), True)
        u, m = _parse_header(s.header)
        if u != unit:
            return None
        counts = {v: note_count(s.voices[v]) for v in s.order}
        voices = keep(s, counts)
        return voices if voices else None

    fixed, unsure = [], {}
    todo = [(k, j) for k in sorted(parsed) for j in sung if len(lines[k].get("staves") or []) == len(clefs)]
    for n, (k, j) in enumerate(todo):
        L = lines[k]
        s = parsed[k]
        bars = [Fraction(b).limit_denominator(64) for b in L.get("bars") or []]
        mine = [v for v in s.order if vmap.get(base(v)) == j and note_count(s.voices[v])]
        if not bars or not mine:
            continue
        context = {v: s.voices[v] for v in s.order if v not in mine}
        cands = [Reading.build("line", [s.voices[v] for v in mine], unit, meter, context)]
        picks, left = choose(cands, bars, beat)
        if max(left) < HARD:
            continue
        progress(f"Checking staff {j + 1} of line {k + 1} again…", n / max(1, len(todo)))
        abc, status = staff_reading(reading, page(L["page"]), L, k, j, engine)
        alone = other(abc, lambda s2, c: [s2.voices[v] for v in s2.order if c[v]]) if status != "failed" else None
        if alone:
            cands.append(Reading.build("alone", alone, unit, meter))
        picks, left = choose(cands, bars, beat)
        differ = alone is not None and any(
            agreement(cands[0].notes_in(a, b), cands[-1].notes_in(a, b)) < 0.999
            for a, b in zip([sum(bars[:i], Fraction(0)) for i in range(len(bars))],
                            [sum(bars[:i + 1], Fraction(0)) for i in range(len(bars))]))
        if max(left) >= HARD or differ:                  # a third opinion
            nb = neighbour(j, len(sung))
            abc, status = pair_reading(reading, page(L["page"]), L, k, j, engine, nb)
            want = 0 if j < nb else 1

            def keep(s2, c):
                pm, _ = map_voices(s2.order, s2.voice_defs, c, [clefs[min(j, nb)], clefs[max(j, nb)]])
                return [s2.voices[v] for v in s2.order if pm.get(v) == want and c[v]]
            pair = other(abc, keep) if status != "failed" else None
            if pair:
                cands.append(Reading.build("pair", pair, unit, meter))
            picks, left = choose(cands, bars, beat)
        still = [i + 1 for i, x in enumerate(left) if x >= HARD]
        if still:
            unsure.setdefault(k, {})[j] = still
        taken = [i + 1 for i, p in enumerate(picks) if p != "line"]
        if not taken:
            continue
        by = {r.name: r for r in cands}
        nparts = max(len(by[p].segs) for p in picks)
        slots = [[] for _ in range(nparts)]
        t = Fraction(0)
        for d, p in zip(bars, picks):
            segs = by[p].bar_text(t, t + d) or []
            n_units = d / unit
            rest = f"x{n_units.numerator}" + (f"/{n_units.denominator}" if n_units.denominator != 1 else "")
            for i in range(nparts):
                slots[i].append(segs[i] if i < len(segs) else f" {rest} |")
            t += d
        music = ["".join(sl).replace("$", "").rstrip() + " $" for sl in slots]
        key = next((h[2:].strip() for h in head.header if h.startswith("K:")), "C")
        fake = f"X:1\nL:{_fmt(unit)}\nK:{key}\n" + "".join(f"V:{i + 1}\n{m}\n" for i, m in enumerate(music))
        new = splice(texts[k], mine, fake, head.header, first=(k == first), song_defs=defs)
        if not new:
            continue
        texts[k] = new
        parsed[k] = parse_system(tidy(new), k == first)
        orig = reading / f"system-{k + 1:02d}-orig.abc"
        if not orig.exists():
            orig.write_text((reading / f"system-{k + 1:02d}.abc").read_text())
        (reading / f"system-{k + 1:02d}.abc").write_text(new)
        fixed.append({"line": k, "staff": j, "bars": taken})
        log.info("Line %d staff %d: bars %s taken from %s", k + 1, j + 1, taken, picks)
    return {"fixed": fixed, "unsure": unsure}
