from app.abc_merge import parse_system
from app.repair import fits, fix_octave, map_voices, shift_octaves, splice


def test_shift_octaves_leaves_text_and_decorations():
    assert shift_octaves('!p! "^solo" B,,2 [D,F,]8- c', 1) == '!p! "^solo" B,2 [DF]8- c\''
    assert shift_octaves("c'2 C", -1) == "c2 C,"


def test_bass_line_in_treble_range_moves_down():
    lines, moved = fix_octave(["F6 A2 | F2 G2 A2 G2 |"], "bass")
    assert moved == -1 and lines[0].startswith("F,6")
    lines, moved = fix_octave(["B,,2 | B,,2 C,2 D,2 |"], "bass")       # B♭2 is a bass note
    assert moved == 0


def test_voices_match_staves_by_clef():
    order = ["1", "2", "3", "4", "5"]
    defs = {"1": "treble", "2": "treble", "3": "bass", "4": 'treble nm="Piano"', "5": "bass"}
    counts = {v: 20 for v in order}
    vmap, piano = map_voices(order, defs, counts, ["treble", "treble", "bass", "treble", "bass"])
    assert vmap == {"1": 0, "2": 1, "3": 2, "4": 3, "5": 4}
    assert piano == 3


def test_reread_must_fit_the_line():
    got = parse_system("X:1\nL:1/8\nM:4/4\nK:C\nV:1 bass\nB,,2 | B,,8 |$\n", True)
    assert fits(got, [0.25, 1.0])
    assert not fits(got, [1.0, 1.0, 1.0])


def test_splice_fills_the_empty_part():
    system = "% ok\nV:1\nc8 |$\nV:2\nx8 |$\n"
    reread = "X:1\nL:1/8\nK:C\nV:1 bass\nV:2 bass\nV:1\nC,8 |$\nV:2\nG,,8 |$\n"
    out = splice(system, ["2"], reread, ["L:1/8", "K:C"], song_defs={"2": "bass"})
    assert out.startswith("% ok\n")
    assert "V:2\nC,8 |$" in out and "V:2x1" in out and "c8 |$" in out
