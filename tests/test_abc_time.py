from fractions import Fraction as F

from app.abc_time import align_system, split_bars


def beats(durs):
    return [d * 4 for d in durs]


def align(voices, hint=None):
    units = {k: F(1, 8) for k in voices}
    out, bars = align_system({k: [v] for k, v in voices.items()}, list(voices), units, F(1), hint)
    return out, beats(bars)


def test_split_bars_counts_notes_rests_chords_and_tuplets():
    segs, durs, _ = split_bars("A2 B2 c2 d2 | [CEG]8 | (3efg a2 b4 | z8 |$", F(1, 8))
    assert beats(durs) == [4, 4, 4, 4]
    assert segs[0].strip().endswith("|")


def test_pickup_bar_stays_short_when_padding_parts_disagree():
    # the singers start with a one-beat pick-up; a piano part padded it to a full bar
    out, bars = align({"1": "Bc | d2 c2 B2 d2 |$", "2": "x4 x2 B,2 | B,8 |$"})
    assert bars == [1, 4]
    assert "x4 x2" not in out["2"][0]


def test_stray_rest_at_a_fermata_is_trimmed():
    out, bars = align({"1": "A6 z4 |$", "2": "B6 z4 |$", "3": "C6 z2 |$"})
    assert bars == [4]
    out, bars = align({"1": "A6 z4 |$", "2": "B6 z4 |$", "3": "C6 z2 |$"}, hint=F(3, 4))
    assert bars == [3]


def test_missing_bar_line_is_put_back():
    out, bars = align({"1": "A8 | e8 |$", "2": "A,8 | E,8 |$", "3": "A8 e8 |$"})
    assert bars == [4, 4]
    assert out["3"][0].count("|") == 2


def test_tied_note_keeps_its_tie_when_padded():
    out, bars = align({"1": "A2 B2 c2 d2 | B8- |$", "2": "A,8 | B,6- |$"})
    assert bars == [4, 4]
    assert "B,6- |" in out["2"][0]
