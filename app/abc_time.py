"""Bar-by-bar timing of ABC music, and lining parts up at every bar line.

Legato reads every part separately, so a misread note length in one part pushes that
part out of step with the others for the rest of the song. `align_system` measures each
bar of each part and pads shorter bars with invisible rests (`x`) so every part starts
every bar together. Durations are Fractions of a whole note.
"""
from __future__ import annotations

import re
from fractions import Fraction
from collections import Counter
from typing import Dict, List, Optional, Tuple

_NOTE = re.compile(r"(\^\^|\^|__|_|=)?([A-Ga-g])([,']*)(\d*)(/*)(\d*)")
_REST = re.compile(r"([zxZX])(\d*)(/*)(\d*)")
_BAR = re.compile(r":*\|\]|:*\|\||\[\||:*\|:*|::")


def _length(num: str, slashes: str, den: str) -> Fraction:
    n = int(num) if num else 1
    if slashes:
        d = int(den) if den else 2 ** len(slashes)
        return Fraction(n, d)
    return Fraction(n)


def _strip(text: str) -> str:
    text = re.sub(r"%.*", "", text)
    text = re.sub(r'"[^"]*"', " ", text)
    text = re.sub(r"![^!]*!|\+[^+\s]*\+", " ", text)
    text = re.sub(r"\{[^}]*\}", " ", text)          # grace notes take no time
    return text.replace("$", " ")


def _tuplet_q(p: int, compound: bool) -> int:
    return {2: 3, 3: 2, 4: 3, 6: 2, 8: 3}.get(p, 3 if compound else 2)


def split_bars(text: str, unit: Fraction, meter: Fraction = Fraction(1),
               events: Optional[list] = None) -> Tuple[List[str], List[Fraction], Fraction]:
    """Split one part's music into bars.

    Returns (segments, durations, unit_after): each segment is the original text of a bar
    *including* its closing bar line (the last one may have none), with its duration.
    Inline [L:..] fields update the unit; [M:..] updates the bar length used for Z rests.

    events: if given, gets one list per segment of the notes and rests in it, as dicts
    {lead, s, e, t0, t1, kind ('note'|'z'|'x'|'Z'), cut, tie}: offsets within the segment
    (lead = where its decorations start), start/end time within the bar, whether the bar
    may be split just before it, and whether it is tied to the next note.
    """
    segments: List[str] = []
    durations: List[Fraction] = []
    i, start, n = 0, 0, len(text)
    dur = Fraction(0)
    tuplet_left, tuplet_factor = 0, Fraction(1)
    tuplet_fresh = False
    last_note: Fraction = Fraction(0)
    broken: Fraction = Fraction(0)     # pending multiplier for the note after a > or <
    in_overlay = False
    cur: List[dict] = []
    lead: Optional[int] = None

    def add(d: Fraction):
        nonlocal dur, tuplet_left, last_note, broken
        if tuplet_left:
            d *= tuplet_factor
            tuplet_left -= 1
        if broken:
            d *= broken
            broken = Fraction(0)
        if not in_overlay:
            dur += d
        last_note = d

    def event(kind: str, s: int, e: int, t0: Fraction, cut: bool):
        nonlocal lead
        if not in_overlay:
            cur.append({"lead": (s if lead is None else lead) - start, "s": s - start, "e": e - start,
                        "t0": t0, "t1": dur, "kind": kind, "cut": cut,
                        "tie": e < n and text[e] == "-"})
        lead = None

    def lead_here():
        nonlocal lead
        if lead is None:
            lead = i

    while i < n:
        c = text[i]
        if c == '"':
            lead_here()
            j = text.find('"', i + 1)
            i = n if j < 0 else j + 1
            continue
        if c == "!":
            lead_here()
            j = text.find("!", i + 1)
            i = n if j < 0 else j + 1
            continue
        if c == "%":
            j = text.find("\n", i)
            i = n if j < 0 else j
            continue
        if c == "{":
            lead_here()
            j = text.find("}", i + 1)
            i = n if j < 0 else j + 1
            continue
        if c == "[" and i + 2 < n and text[i + 1].isalpha() and text[i + 2] == ":":
            j = text.find("]", i)
            field = text[i + 1:j if j > 0 else n]
            if field.startswith("L:"):
                try:
                    a, b = field[2:].strip().split("/")
                    unit = Fraction(int(a), int(b))
                except ValueError:
                    pass
            elif field.startswith("M:"):
                v = field[2:].strip()
                if v in ("C", "C|"):
                    meter = Fraction(1)
                elif "/" in v:
                    try:
                        a, b = v.split("/")
                        meter = Fraction(int(a), int(b))
                    except ValueError:
                        pass
            i = n if j < 0 else j + 1
            continue
        m = _BAR.match(text, i)
        if m and (c in "|:" or text.startswith("[|", i)):
            end = m.end()
            while end < n and (text[end].isdigit() or text[end] in ",-"):   # volta numbers |1 :|2
                end += 1
            segments.append(text[start:end])
            durations.append(dur)
            if events is not None:
                events.append(cur)
            cur, lead = [], None
            dur, start, i = Fraction(0), end, end
            in_overlay = False
            continue
        if c == "[" and i + 1 < n and text[i + 1].isdigit():                 # [1 [2 endings
            i += 2
            continue
        if c == "&":
            in_overlay = True
            for ev in cur:
                ev["cut"] = False
            i += 1
            continue
        if c == "(" and i + 1 < n and text[i + 1].isdigit():
            lead_here()
            m2 = re.match(r"\((\d)(?::(\d*))?(?::(\d*))?", text[i:])
            p = int(m2.group(1))
            q = int(m2.group(2)) if m2.group(2) else _tuplet_q(p, meter.numerator % 3 == 0 and meter.numerator > 3)
            r = int(m2.group(3)) if m2.group(3) else p
            tuplet_left, tuplet_factor = r, Fraction(q, p)
            tuplet_fresh = True
            i += len(m2.group(0))
            continue
        if c == "(":                                                          # slur start
            lead_here()
            i += 1
            continue
        cuttable = (not tuplet_left or tuplet_fresh) and not broken and not in_overlay
        in_tuplet = bool(tuplet_left)
        if c == "[":                                                          # chord
            j = text.find("]", i)
            if j < 0:
                i += 1
                continue
            inner = text[i + 1:j]
            first = _NOTE.search(inner)
            base = _length(*first.group(4, 5, 6)) if first else Fraction(1)
            m3 = re.match(r"(\d*)(/*)(\d*)", text[j + 1:])
            mult = _length(*m3.groups()) if m3.group(0) else Fraction(1)
            t0, s0 = dur, i
            add(base * mult * unit)
            i = j + 1 + len(m3.group(0))
            event("note", s0, i, t0, cuttable)
            tuplet_fresh = False
            continue
        if c in "><":
            k = i
            while k < n and text[k] == c:
                k += 1
            count = k - i
            big = 2 - Fraction(1, 2 ** count)
            small = Fraction(1, 2 ** count)
            first_mult, second_mult = (big, small) if c == ">" else (small, big)
            if last_note and not in_overlay:
                dur += last_note * (first_mult - 1)
                if cur:
                    cur[-1]["t1"] = dur
            broken = second_mult
            i = k
            continue
        m = _NOTE.match(text, i)
        if m:
            t0 = dur
            add(_length(*m.group(4, 5, 6)) * unit)
            i = m.end()
            event("note", m.start(), i, t0, cuttable)
            tuplet_fresh = False
            continue
        m = _REST.match(text, i)
        if m:
            t0 = dur
            if m.group(1) in "ZX":
                bars = int(m.group(2)) if m.group(2) else 1
                if not in_overlay:
                    dur += meter * bars
                i = m.end()
                event("Z", m.start(), i, t0, cuttable)
            else:
                add(_length(*m.group(2, 3, 4)) * unit)
                i = m.end()
                event(m.group(1), m.start(), i, t0, cuttable)
                if cur and not in_overlay:
                    cur[-1]["tup"] = in_tuplet
            tuplet_fresh = False
            continue
        i += 1
    rest = text[start:]
    if dur > 0 or re.search(r"[A-Ga-gzxZX]", _strip(re.sub(r"\[[A-Za-z]:[^\]]*\]", "", rest))):
        segments.append(rest)
        durations.append(dur)
        if events is not None:
            events.append(cur)
    elif segments:
        segments[-1] += rest           # trailing "$", spaces, line breaks belong to the last bar
    return segments, durations, unit


def _x(d: Fraction, unit: Fraction) -> str:
    n = d / unit
    if n.denominator == 1:
        return f"x{n.numerator}"
    return f"x{n.numerator}/{n.denominator}"


def _parse_header(header: List[str]) -> Tuple[Fraction, Fraction]:
    unit, meter = Fraction(1, 8), Fraction(1)
    for line in header:
        if line.startswith("L:"):
            try:
                a, b = line[2:].strip().split("/")
                unit = Fraction(int(a), int(b))
            except ValueError:
                pass
        elif line.startswith("M:"):
            v = line[2:].strip()
            if v in ("C", "C|"):
                meter = Fraction(1)
            elif "/" in v:
                try:
                    a, b = v.split("/")
                    meter = Fraction(int(re.sub(r"\D", "", a) or 4), int(re.sub(r"\D", "", b) or 4))
                except (ValueError, ZeroDivisionError):
                    pass
    return unit, meter


def _rest(kind: str, d: Fraction, unit: Fraction) -> str:
    n = d / unit
    if n.denominator == 1:
        return f"{kind}{n.numerator if n.numerator != 1 else ''}"
    return f"{kind}{n.numerator if n.numerator != 1 else ''}/{n.denominator}"


def _bar_line_at(seg: str) -> Optional[re.Match]:
    return re.search(r"(\s*(?:\$|\n|\s)*)(:*\|\]|:*\|\||\[\||:*\|:*|::)([\d,\-]*)(\s*\$?\s*)$", seg)


def _rests_at_end(evs: List[dict]) -> Fraction:
    """How much of a bar's end is plain rests (z or x), which may be shortened."""
    total = Fraction(0)
    for ev in reversed(evs):
        if ev["kind"] not in "zx" or ev.get("tup"):
            break
        total += ev["t1"] - ev["t0"]
    return total


def _padding_at_start(evs: List[dict]) -> Fraction:
    """Invisible rests (x) before the first note: the reading often pads a pick-up bar
    out to a full bar this way."""
    if _rests_at_end(evs) >= sum((e["t1"] - e["t0"] for e in evs), Fraction(0)):
        return Fraction(0)          # all rests: already counted as trailing
    total = Fraction(0)
    for ev in evs:
        if ev["kind"] != "x" or ev.get("tup"):
            break
        total += ev["t1"] - ev["t0"]
    return total


def _floor(d: Fraction, evs: List[dict]) -> Fraction:
    """The shortest this bar can be made without touching its notes."""
    return d - _rests_at_end(evs) - _padding_at_start(evs)


def _has_notes(evs: List[dict]) -> bool:
    return any(ev["kind"] == "note" for ev in evs)


def _printed(evs: List[dict]) -> bool:
    """Notes or printed rests (z): the bar's length is evidence of the real bar length.
    Bars of only invisible rests (x) are padding and can take any length."""
    return any(ev["kind"] in ("note", "z", "Z") for ev in evs)


def _fit(seg: str, evs: List[dict], d: Fraction, target: Fraction, unit: Fraction) -> str:
    """Make one bar exactly `target` long: pad with an invisible rest, or shorten its
    trailing rests (the reading sometimes adds a beat of rest at a fermata)."""
    if d < target:
        filler = " " + _x(target - d, unit) + " "
        if evs and evs[-1]["tie"]:
            # keep a tied note right against the bar line, so the tie still reaches the next bar
            k = evs[-1]["lead"]
            return seg[:k] + filler.lstrip() + seg[k:]
        m = _bar_line_at(seg)
        if m:
            return seg[:m.start()] + filler + seg[m.start():]
        return seg.rstrip().rstrip("$") + filler + "|"
    if d > target:
        excess = d - target

        def shrink(seg, ev, excess):
            r = ev["t1"] - ev["t0"]
            if r <= excess:
                return seg[:ev["lead"]] + seg[ev["e"]:], excess - r
            mult = _length(*_REST.match(seg, ev["s"]).group(2, 3, 4)) * (r - excess) / r
            return seg[:ev["s"]] + _rest(ev["kind"], mult * unit, unit) + seg[ev["e"]:], Fraction(0)

        tail = []
        for ev in reversed(evs):                    # trailing rests first
            if ev["kind"] not in "zx" or ev.get("tup"):
                break
            tail.append(ev)
        for ev in tail:
            if excess <= 0:
                break
            seg, excess = shrink(seg, ev, excess)
        if excess > 0 and len(tail) < len(evs):     # then padding before the first note
            head, left = [], excess
            for ev in evs:
                if left <= 0 or ev["kind"] != "x" or ev.get("tup"):
                    break
                take = min(left, ev["t1"] - ev["t0"])
                head.append((ev, take))
                left -= take
            for ev, take in reversed(head):
                seg, _ = shrink(seg, ev, take)
    return seg


def _cut(text: str, segs: List[str], evs: List[List[dict]], durs: List[Fraction],
         times: List[Fraction], unit: Fraction) -> Optional[str]:
    """Add bar lines to a part at the given times (from the start of the line), where it
    has none. Returns the new text, or None if a note lies across one of those times."""
    edits = []                      # (offset in text, old length, new text)
    off, t = 0, Fraction(0)
    for seg, ev, d in zip(segs, evs, durs):
        inside = [x - t for x in times if t < x < t + d]
        for c in inside:
            hit = next((e for e in ev if e["t0"] == c and e["cut"]), None)
            if hit:
                edits.append((off + hit["lead"], 0, "| "))
                continue
            span = next((e for e in ev if e["t0"] < c < e["t1"]), None)
            if span and span["kind"] == "x" and not span.get("tup"):
                edits.append((off + span["s"], span["e"] - span["s"],
                              f"{_x(c - span['t0'], unit)} | {_x(span['t1'] - c, unit)}"))
                continue
            return None
        off += len(seg)
        t += d
    for pos, old, new in sorted(edits, reverse=True):
        text = text[:pos] + new + text[pos + old:]
    return text


def _choose(lengths: List[Fraction], floor: Fraction, meter: Fraction,
            hint: Optional[Fraction] = None) -> Fraction:
    """The length of one bar, from what the parts that read it say (most common wins).
    hint: the length the music around it suggests, used when the parts disagree."""
    if not lengths:
        return max(floor, meter) if floor > 0 else meter
    counts = Counter(lengths).most_common()
    best = max(c for _, c in counts)
    tied = [L for L, c in counts if c == best]
    # a tie: the shortest length every part can be fitted to (longer readings of the bar are
    # padding or stray rests, which can be trimmed; notes can't)
    fitting = [L for L in tied if L >= floor]
    L = min(fitting) if fitting else max(tied)
    if hint is not None and hint >= floor and hint > 0 and (len(counts) > 1 or L > meter):
        return hint
    if L > meter and floor <= meter:      # an over-full bar: a stray rest at a fermata
        L = meter
    return max(L, floor) if max(L, floor) > 0 else meter


def align_system(voices: Dict[str, List[str]], order: List[str], units: Dict[str, Fraction],
                 meter: Fraction, last_hint: Optional[Fraction] = None
                 ) -> Tuple[Dict[str, List[str]], List[Fraction]]:
    """Make every part of one system have the same bars, each the same length.

    The bar lengths come from the parts that read them: the most common length among the
    parts' notes and printed rests (over-full bars are trimmed where they end in rests;
    short bars get invisible rests). A part that missed a bar line gets one where the
    others have it.

    `voices` maps id -> music lines for this system (missing/empty = silent here);
    `units` holds each part's current L: unit (updated in place for inline [L:] changes).
    `last_hint`: the length the last bar probably has (the next line starts with a pick-up).
    Returns (new music lines per part, bar lengths).
    """
    parts: Dict[str, dict] = {}
    for v in order:
        text = "\n".join(voices.get(v) or [])
        if text.strip():
            evs: list = []
            u0 = units[v]
            segs, durs, units[v] = split_bars(text, u0, meter, evs)
            parts[v] = {"text": text, "segs": segs, "durs": durs, "evs": evs, "u0": u0}
    if not parts:
        return {}, []

    # How many bars: the most bars that at least two parts with notes agree on.
    with_notes = [p for p in parts.values() if any(_has_notes(e) for e in p["evs"])] or list(parts.values())
    counts = Counter(len(p["durs"]) for p in with_notes)
    need = min(2, len(with_notes))
    nbars = max((c for c, k in counts.items() if k >= need), default=max(counts))

    def bar_targets(group: List[dict]) -> List[Fraction]:
        out = []
        for k in range(nbars):
            lengths = [p["durs"][k] for p in group if _printed(p["evs"][k])]
            floor = max((_floor(p["durs"][k], p["evs"][k]) for p in group), default=Fraction(0))
            out.append(_choose(lengths, floor, meter, last_hint if k == nbars - 1 else None))
        return out

    targets = bar_targets([p for p in parts.values() if len(p["durs"]) == nbars])

    # Parts with a different number of bars: add the missing bar lines where they fall.
    times, t = [], Fraction(0)
    for d in targets[:-1]:
        t += d
        times.append(t)
    for v, p in parts.items():
        if len(p["durs"]) == nbars:
            continue
        new = _cut(p["text"], p["segs"], p["evs"], p["durs"], times, p["u0"])
        if new is not None:
            evs = []
            segs, durs, _ = split_bars(new, p["u0"], meter, evs)
            if len(durs) == nbars:
                p.update(text=new, segs=segs, durs=durs, evs=evs)

    # Bars that can't be shortened enough set a floor for everyone.
    for k in range(nbars):
        for p in parts.values():
            if len(p["durs"]) == nbars:
                targets[k] = max(targets[k], _floor(p["durs"][k], p["evs"][k]))
    for p in parts.values():
        if len(p["durs"]) != nbars and p["durs"]:
            short = sum(p["durs"], Fraction(0)) - _rests_at_end(p["evs"][-1])
            over = short - sum(targets, Fraction(0))
            if over > 0:
                targets[-1] += over

    out: Dict[str, List[str]] = {}
    total = sum(targets, Fraction(0))
    for v in order:
        u = units[v]
        if v not in parts:
            out[v] = [" " + " ".join(f"{_x(t, u)} |" for t in targets) + " $"]
            continue
        p = parts[v]
        segs, durs, evs = p["segs"], p["durs"], p["evs"]
        if len(durs) == nbars:
            pieces = [_fit(segs[k], evs[k], durs[k], targets[k], u) for k in range(nbars)]
        else:                       # couldn't line its bars up: at least end the line together
            pieces = list(segs[:-1])
            last = total - sum(durs[:-1], Fraction(0))
            pieces.append(_fit(segs[-1], evs[-1], durs[-1], last, u) if last >= 0 else segs[-1])
        text = "".join(pieces)
        if not text.rstrip().endswith("$"):
            text = text.rstrip() + " $"
        out[v] = [line for line in text.split("\n") if line.strip()]
    return out, targets
