"""Check that Legato 2 runs on this Mac and reads a known page correctly.

Reads static/test-score.png (two lines of TTBB + piano whose correct notes are in
app/demo.abc) and reports how much of each part came out right. Everything the model
saw and wrote is saved in selftest-debug/ so problems can be diagnosed.
Run:  .venv/bin/python -m app.selftest
"""
import difflib
import re
import time

from app import omr

ROOT = omr.ROOT


def voices(abc: str) -> dict:
    """Music of each voice (notes and bar lines only), voice by voice."""
    _, body = omr.split_header(abc)
    out, cur = {}, None
    for line in body.split("\n"):
        m = re.match(r"^V:\s*(\S+)", line.strip())
        if m:
            cur = m.group(1)
            continue
        if cur is None:
            continue
        line = re.sub(r'%.*|"[^"]*"|![^!]*!|\$|\s+', "", line)
        out[cur] = out.get(cur, "") + line
    return {k: v for k, v in out.items() if re.search(r"[A-Ga-g]", v)}


def score(abc: str, truth: str) -> float:
    """For each true part, the best-matching part read by the model; weighted by length."""
    got, want = voices(abc), voices(truth)
    if not got or not want:
        return 0.0
    total = sum(len(v) for v in want.values())
    return sum(
        len(w) * max(difflib.SequenceMatcher(None, g, w, autojunk=False).ratio() for g in got.values())
        for w in want.values()
    ) / total


def main():
    truth = (ROOT / "app" / "demo.abc").read_text()
    page = str(ROOT / "static" / "test-score.png")
    print("Loading Legato 2 (the first run downloads ~1.9 GB)…")
    t = time.time()
    omr.ENGINE.load()
    print(f"  loaded on {omr.ENGINE.info.device} ({omr.ENGINE.info.dtype}) in {time.time() - t:.0f}s")

    t = time.time()
    result = omr.ENGINE.transcribe([page], progress=lambda m, f: print(f"  {m}", flush=True),
                                   debug_dir=ROOT / "selftest-debug")
    (ROOT / "selftest-debug" / "merged.abc").write_text(result.abc)
    pct = score(result.abc, truth)
    print(f"\n  Found {len(result.systems)} of 2 lines of music, {pct:.0%} of the notes match ({time.time() - t:.0f}s).")
    if len(result.systems) != 2 or pct < 0.85:
        print("  That's lower than expected. Details are in the selftest-debug folder.")
    else:
        print("  Looks good.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
