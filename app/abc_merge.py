"""Check, tidy and join Legato 2's per-system ABC into one tune.

Legato 2 reads one system (one line of music across all staves) at a time. Following
the Legato 2 paper (arXiv 2607.05769, App. A.3):
  * only the first system carries the tune header (X:, T:, L:, M:, K:, ...);
  * each system lists its voices as `V:n ...` blocks and ends with a `%%score` line;
  * a voice's music is the concatenation of its blocks; the layout is the `%%score`
    of the last system.
On real scans the model sometimes renumbers voices between systems, or breaks down
(runs of spaces, the same symbol over and over, lyrics typed out as text). This module
finds those problems, keeps whatever is still usable, and lines voices up by staff.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from fractions import Fraction
from typing import Dict, List, Optional, Tuple

_VOICE = re.compile(r"^\s*V:\s*([^\s\]]+)\s*(.*)$")
_HEADER = re.compile(r"^\s*([A-Za-z]):(.*)$")
_BARS = re.compile(r"::|:\|\]?|\|:|\|\]|\|\||\[\||\|")
_REPEAT = re.compile(r"(.{1,24}?)\1{11,}", re.S)       # the same snippet 12+ times in a row
_SPACES = re.compile(r"[ \t]{30,}")
_LONG_TEXT = re.compile(r'"[_^<>@]?[^"]{40,}"')         # lyrics typed out as an annotation


# ----------------------------------------------------------------------------
# checking and tidying one system's output
# ----------------------------------------------------------------------------
def _music_only(line: str) -> str:
    return re.sub(r'"[^"]*"|![^!]*!|\[[A-Za-z]:[^\]]*\]|%.*', "", line)


def _fix_line(line: str) -> str:
    line = _LONG_TEXT.sub("", line)
    line = re.sub(r'("[^"]*)[ \t]{2,}([^"]*")', lambda m: re.sub(r"\s+", " ", m.group(0)), line)
    if line.count('"') % 2:                       # unclosed text: drop it
        line = line[: line.rfind('"')]
    music = re.sub(r'"[^"]*"', "", line)
    if music.count("!") % 2:                      # unclosed decoration
        cut = line.rfind("!")
        line = line[:cut]
    if line.count("[") > line.count("]"):         # unclosed chord at the end
        line = line[: line.rfind("[")]
    return line.rstrip()


def tidy(text: str) -> str:
    """Remove the model's obvious junk without touching the music."""
    out: List[str] = []
    for raw in text.replace("\r", "").split("\n"):
        if not raw.strip():
            continue
        if _SPACES.search(raw) or _REPEAT.search(raw):
            # keep the part before the breakdown if it ends cleanly at a bar line
            m = _SPACES.search(raw) or _REPEAT.search(raw)
            head = raw[: m.start()]
            cut = max(head.rfind("|"), head.rfind("$"))
            raw = head[: cut + 1] if cut >= 0 else ""
            if not raw.strip():
                continue
        # cross-staff notes ([I:staff +1]) make the drawing code move notes between parts,
        # which breaks timing; keep every note on its own part's staff instead
        raw = re.sub(r"\[I:\s*staff\s*[+-]?\d+\s*\]", "", raw)
        line = _fix_line(raw) if not raw.lstrip().startswith("%%") else raw.rstrip()
        if not line.strip():
            continue
        if out and _VOICE.match(line) and out[-1].strip() == line.strip():
            continue                              # "V:1" repeated on its own
        out.append(line)
    return "\n".join(out) + ("\n" if out else "")


def problems(text: str) -> List[str]:
    """Signs that the model broke down on this system (empty list = looks fine)."""
    issues = []
    if _SPACES.search(text):
        issues.append("runs of blank space")
    if _REPEAT.search(text):
        issues.append("the same symbols over and over")
    if not re.search(r"^\s*%%score", text, re.M):
        issues.append("stopped before the end")
    voices = re.findall(r"^\s*V:\s*(\S+)", text, re.M)
    if not voices:
        issues.append("no parts")
    if len(voices) != len(set(voices)):
        issues.append("a part listed twice")
    if not any(re.search(r"[A-Ga-gz]", _music_only(l)) for l in text.split("\n") if not _VOICE.match(l)):
        issues.append("no notes")
    return issues


# ----------------------------------------------------------------------------
# parsing
# ----------------------------------------------------------------------------
@dataclass
class System:
    header: List[str] = field(default_factory=list)          # only for the first system
    voices: Dict[str, List[str]] = field(default_factory=dict)
    voice_defs: Dict[str, str] = field(default_factory=dict)  # id -> "treble nm=..." (first seen)
    order: List[str] = field(default_factory=list)
    score: Optional[str] = None


def parse_system(text: str, first: bool) -> System:
    s = System()
    cur: Optional[str] = None
    for raw in text.replace("\r", "").split("\n"):
        line = raw.rstrip()
        if not line.strip():
            continue
        if line.lstrip().startswith(("%%score", "%%staves")):
            parts = line.split(None, 1)
            s.score = parts[1] if len(parts) > 1 else ""
            continue
        m = _VOICE.match(line)
        if m:
            cur = m.group(1)
            if cur not in s.voices:
                s.voices[cur] = []
                s.order.append(cur)
            attrs = m.group(2).strip()
            if attrs and cur not in s.voice_defs:
                s.voice_defs[cur] = attrs
            continue
        if cur is None:
            # before the first V: line. In the first system that is the tune header; keep
            # only well-formed fields (the model sometimes writes ":Copyright …").
            if first and (re.match(r"^[A-Za-z]:", line) or line.startswith("%")):
                s.header.append(line)
            continue
        s.voices[cur].append(line)
    return s


def salvage(text: str, first: bool) -> Tuple[str, int]:
    """Keep the voices of a broken system that still look complete. Returns (abc, voices kept)."""
    s = parse_system(tidy(text), first)
    out = list(s.header) if first else []
    kept = 0
    for v in s.order:
        lines = [l for l in s.voices[v] if l.strip()]
        body = " ".join(lines)
        if not lines or not re.search(r"(\||\|\]|\$|:)\s*$", body) or not re.search(r"[A-Ga-gzx]", _music_only(body)):
            continue
        out.append(f"V:{v} {s.voice_defs.get(v, '')}".rstrip())
        out.extend(lines)
        kept += 1
    if s.score is not None:
        out.append("%%score " + s.score)
    return ("\n".join(out) + "\n" if kept else ""), kept


# ----------------------------------------------------------------------------
# layout helpers
# ----------------------------------------------------------------------------
def count_bars(lines: List[str]) -> int:
    text = _music_only(" ".join(lines))
    n = len(_BARS.findall(text))
    if text.strip().startswith("|"):
        n -= 1
    return max(n, 0)


def _units_per_bar(header: List[str]) -> str:
    meter, unit = Fraction(4, 4), Fraction(1, 8)
    for line in header:
        m = _HEADER.match(line)
        if not m:
            continue
        key, val = m.group(1), m.group(2).strip()
        try:
            if key == "M":
                if val in ("C", "C|"):
                    meter = Fraction(4, 4) if val == "C" else Fraction(2, 2)
                elif "/" in val:
                    a, b = val.split("/")[:2]
                    meter = Fraction(int(re.sub(r"\D", "", a) or 4), int(re.sub(r"\D", "", b) or 4))
            elif key == "L" and "/" in val:
                a, b = val.split("/")[:2]
                unit = Fraction(int(a), int(b))
        except (ValueError, ZeroDivisionError):
            pass
    n = meter / unit
    return str(n.numerator) if n.denominator == 1 else f"{n.numerator}/{n.denominator}"


_TOK = re.compile(r"[\[\](){}|]|[^\s\[\](){}|]+")


def balance_score(score: str, known: List[str]) -> str:
    """Repair a %%score line: drop unknown voices, fix unbalanced brackets, add missing voices."""
    pairs = {"(": ")", "[": "]", "{": "}"}
    out, stack, seen = [], [], []
    for tok in _TOK.findall(score or ""):
        if tok in pairs:
            if tok == "(" and stack and stack[-1] == "(":  # voice groups don't nest
                out.append(pairs[stack.pop()])
            stack.append(tok)
            out.append(tok)
        elif tok in pairs.values():
            opener = {v: k for k, v in pairs.items()}[tok]
            if opener in stack:  # close anything left open inside it first
                while stack:
                    o = stack.pop()
                    out.append(pairs[o])
                    if o == opener:
                        break
        elif tok == "|":
            if stack and stack[-1] == "(":  # a "|" can't sit inside ( ): the voice group has ended
                out.append(pairs[stack.pop()])
            out.append(tok)
        elif tok in known and tok not in seen:
            seen.append(tok)
            out.append(tok)
    while stack:
        out.append(pairs[stack.pop()])
    text = " ".join(out)
    prev = None
    while prev != text:  # remove brackets that ended up empty, e.g. "( )"
        prev = text
        text = re.sub(r"\(\s*\)|\[\s*\]|\{\s*\}", "", text)
        text = re.sub(r"\|\s*([\])}])", r"\1", text)
        text = re.sub(r"([\[({])\s*\|", r"\1", text)
    for v in known:
        if v not in seen:
            text += " " + v
    return re.sub(r"\s+", " ", text).strip()


def staves(score: Optional[str], voices: List[str]) -> List[List[str]]:
    """Staves (each a list of voice ids) in top-to-bottom order, from a %%score line."""
    if not score:
        return [[v] for v in voices]
    result: List[List[str]] = []
    group: Optional[List[str]] = None
    for tok in _TOK.findall(balance_score(score, voices)):
        if tok == "(":
            group = []
        elif tok == ")":
            if group:
                result.append(group)
            group = None
        elif tok in voices:
            if group is not None:
                group.append(tok)
            else:
                result.append([tok])
    return result


def _renumber(s: System, ref: List[List[str]]) -> System:
    """Give a system's voices the ids of the voices on the same staff in the reference system."""
    mine = staves(s.score, s.order)
    if len(mine) != len(ref):
        return s
    mapping: Dict[str, str] = {}
    for staff, ref_staff in zip(mine, ref):
        for j, v in enumerate(staff):
            mapping[v] = ref_staff[j] if j < len(ref_staff) else f"{ref_staff[0]}x{j}"
    for v in s.order:
        mapping.setdefault(v, v if v not in mapping.values() else f"{v}y")
    if all(k == v for k, v in mapping.items()):
        return s
    r = System(header=s.header)
    for v in s.order:
        nv = mapping[v]
        r.order.append(nv)
        r.voices[nv] = s.voices[v]
        if v in s.voice_defs:
            r.voice_defs[nv] = s.voice_defs[v]
    if s.score is not None:
        r.score = " ".join(mapping.get(t, t) for t in _TOK.findall(s.score))
    return r


# ----------------------------------------------------------------------------
# the merge
# ----------------------------------------------------------------------------
@dataclass
class Merged:
    abc: str
    # one entry per input system (None if it had no music): start time and bar lengths in
    # whole notes, and its staves top to bottom as lists of (merged) voice ids
    lines: List[Optional[dict]]


def merge_systems(outputs: List[str]) -> str:
    return merge(outputs).abc


def merge(outputs: List[str]) -> Merged:
    """Merge per-system outputs (already checked) into one ABC tune, with every part lined
    up at every bar line, and report where each system sits in time."""
    from app.abc_time import _parse_header, align_system

    parsed = []
    for i, t in enumerate(outputs):
        s = parse_system(tidy(t), not parsed) if t and t.strip() else None
        parsed.append(s if s and s.order else None)
    systems = [s for s in parsed if s]
    if not systems:
        return Merged("", [None] * len(outputs))
    header = list(systems[0].header)
    if not any(h.startswith("X:") for h in header):
        header.insert(0, "X:1")
    if not any(h.startswith("L:") for h in header):
        header.insert(1, "L:1/8")
    if not any(h.startswith("K:") for h in header):
        header.append("K:C")
    k = [h for h in header if h.startswith("K:")][-1]            # K: must be the last field
    header = [h for h in header if not h.startswith(("K:", "%%score", "%%staves"))] + [k]
    unit, meter = _parse_header(header)

    ref = staves(systems[0].score, systems[0].order)
    first = systems[0]
    parsed = [s if (s is None or s is first) else _renumber(s, ref) for s in parsed]
    systems = [s for s in parsed if s]

    order: List[str] = []
    defs: Dict[str, str] = {}
    for s in systems:
        for v in s.order:
            if v not in order:
                order.append(v)
            if v in s.voice_defs and v not in defs:
                defs[v] = s.voice_defs[v]
    # a part added for a staff (id "5x1": another part on voice 5's staff) goes right after it,
    # so it lines up with the right staff on the page; it shares that voice's clef
    for v in [v for v in order if re.match(r"^(.+?)x\d+$", v)]:
        base = re.match(r"^(.+?)x\d+$", v).group(1)
        if base in order:
            order.remove(v)
            at = order.index(base) + 1
            while at < len(order) and order[at].startswith(base + "x"):
                at += 1
            order.insert(at, v)
            if v not in defs and base in defs:
                defs[v] = re.sub(r'\b(s?nm)="[^"]*"', "", defs[base]).strip()

    # A line that starts with a pick-up (a short first bar) usually follows a line whose
    # last bar is short by the same amount; that settles a last bar the parts disagree on.
    pickup: List[Optional[Fraction]] = []
    units = {v: unit for v in order}
    for s in parsed:
        bars = align_system(s.voices, order, units, meter)[1] if s is not None else []
        pickup.append(bars[0] if bars and bars[0] < meter else None)

    music: Dict[str, List[str]] = {v: [] for v in order}
    units = {v: unit for v in order}
    timing: List[Optional[dict]] = []
    t = Fraction(0)
    for i, s in enumerate(parsed):
        if s is None:
            timing.append(None)
            continue
        nxt = pickup[i + 1] if i + 1 < len(parsed) else None
        aligned, bars = align_system(s.voices, order, units, meter,
                                     last_hint=meter - nxt if nxt is not None else None)
        for v in order:
            music[v].extend(aligned.get(v, []))
        timing.append({
            "start": float(t),
            "bars": [float(b) for b in bars],
            "staves": staves(s.score, s.order),
        })
        t += sum(bars, Fraction(0))

    # Layout: the first system's staves (its voices are the reference ids), with any extra
    # voices that were matched to a staff placed on that staff.
    score = systems[0].score
    if score is not None:
        extras: Dict[str, List[str]] = {}
        for v in order:
            m = re.match(r"^(.+?)x\d+$", v)
            if m and m.group(1) in order:
                extras.setdefault(m.group(1), []).append(v)
        toks, out, depth = _TOK.findall(balance_score(score, systems[0].order)), [], 0
        for t in toks:
            if t == "(":
                depth += 1
            elif t == ")":
                depth -= 1
            if t in extras:
                out.append(" ".join([t] + extras[t]) if depth else "( " + " ".join([t] + extras[t]) + " )")
            else:
                out.append(t)
        score = " ".join(out)
    else:
        score = next((s.score for s in reversed(systems) if s.score is not None), None)
    lines = header[:-1]
    if score is not None or len(order) > 1:
        lines.append("%%score " + balance_score(score or " ".join(order), order))
    lines.append(header[-1])
    for v in order:
        lines.append(f"V:{v} {defs.get(v, '')}".rstrip())
    for v in order:
        lines.append(f"V:{v}")
        lines.extend(music[v])
    return Merged("\n".join(lines) + "\n", timing)
