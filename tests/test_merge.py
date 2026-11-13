from pathlib import Path

from app.abc_merge import merge

DEMO = Path(__file__).resolve().parents[1] / "app"


def test_demo_lines_merge_in_step():
    m = merge([(DEMO / "demo-1.abc").read_text(), (DEMO / "demo-2.abc").read_text()])
    assert [len(L["bars"]) for L in m.lines] == [4, 4]
    assert m.lines[1]["start"] == sum(m.lines[0]["bars"])
    assert m.abc.startswith("X:1")


def test_failed_line_is_skipped():
    m = merge([(DEMO / "demo-1.abc").read_text(), None])
    assert m.lines[1] is None


def test_added_part_sits_next_to_its_staff():
    first = "X:1\nL:1/8\nM:4/4\nK:C\nV:1 treble\nV:2 bass\nV:1\nc8 |$\nV:2\nC,8 |$\n%%score 1 2\n"
    second = "V:1\nc8 |$\nV:2\nC,8 |$\nV:2x1\nG,,8 |$\n"
    order = [l for l in merge([first, second]).abc.split("\n") if l.startswith("V:") and " " in l]
    assert [l.split()[0] for l in order] == ["V:1", "V:2", "V:2x1"]


INTRO = 'X:1\nL:1/4\nM:4/4\nK:C\nV:1 treble nm="Piano"\nV:2 bass\nV:1\n[ceg]4 |$\nV:2\nC,4 |$\n%%score {1 2}\n'
FULL = ('V:1 treble nm="Soprano"\nV:2 treble nm="Alto"\nV:3 bass nm="Bass"\nV:4 treble nm="Piano"\nV:5 bass\n'
        'V:1\ne f g a |$\nV:2\nc d e f |$\nV:3\nC, D, E, F, |$\nV:4\n[ceg]4 |$\nV:5\nC,,4 |$\n%%score [1 2 3] {4 5}\n')
SHARED = ('V:1 treble\nV:2 treble\nV:3 bass\nV:4 treble\nV:5 bass\n'
          'V:1\ne4 |$\nV:2\nc4 |$\nV:3\nC,4 |$\nV:4\n[ceg]4 |$\nV:5\nC,,4 |$\n%%score [(1 2) 3] {4 5}\n')


def test_a_line_with_fewer_staves_keeps_each_part_on_its_own_id():
    m = merge([INTRO, FULL, SHARED])
    # the piano introduction is the piano, not the sopranos and altos
    assert m.lines[0]["staves"] == [["4"], ["5"]]
    assert m.lines[1]["staves"] == [["1"], ["2"], ["3"], ["4"], ["5"]]
    # sopranos and altos on one staff here: still voices 1 and 2
    assert m.lines[2]["staves"] == [["1", "2"], ["3"], ["4"], ["5"]]
    defs = [l.split()[0] for l in m.abc.split("\n") if l.startswith("V:") and " " in l]
    assert defs == ["V:1", "V:2", "V:3", "V:4", "V:5"]
    assert "%%score [ 1 2 3 ] { 4 5 }" in m.abc
    body = m.abc.split("V:1\n", 1)[1]
    assert body.startswith(" x4 |")                       # sopranos rest through the introduction
