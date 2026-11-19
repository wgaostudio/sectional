import re
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


TWO_FOUR = "X:1\nL:1/4\nM:2/4\nK:C\nV:1 treble\nV:2 bass\nV:1\nc d | e f |$\nV:2\nC, D, | E, F, |$\n%%score 1 2\n"


def test_a_new_time_signature_before_the_parts_of_a_line():
    later = "M:4/4\nV:1\nc d e z | f2 z2 |$\nV:2\nC,4 | F,2 z2 |$\n%%score 1 2\n"
    m = merge([TWO_FOUR, later])
    assert m.lines[0]["meters"] == [[2, 4], [2, 4]]
    assert m.lines[1]["meters"] == [[4, 4], [4, 4]]
    # a 4/4 bar ending in rests is a whole bar, not cut down to the 2/4 the tune began in
    assert m.lines[1]["bars"] == [1.0, 1.0]
    assert "[M:4/4] C,4 | F,2 z2 |" in m.abc


def test_a_part_that_missed_the_change_is_given_it():
    later = "V:1\n[M:4/4] c d e z | f2 z2 |$\nV:2\nC,4 | F,2 z2 |$\n%%score 1 2\n"
    m = merge([TWO_FOUR, later])
    assert m.lines[1]["bars"] == [1.0, 1.0]
    assert m.abc.count("[M:4/4]") == 2


def test_a_change_at_the_end_of_a_line_starts_the_next():
    mid = "V:1\nc d | e f | [M:3/4] $\nV:2\nC, D, | E, F, |$\n%%score 1 2\n"
    last = "V:1\nc d e | f2 z |$\nV:2\nC,3 | F,2 z |$\n%%score 1 2\n"
    m = merge([TWO_FOUR, mid, last])
    assert m.lines[1]["meters"] == [[2, 4], [2, 4]]
    assert m.lines[2]["meters"] == [[3, 4], [3, 4]] and m.lines[2]["bars"] == [0.75, 0.75]
    assert "[M:3/4] C,3 |" in m.abc


def test_a_change_inside_a_line_and_compound_time_kept_apart():
    later = "V:1\nc d | [M:6/8] c/ d/ e/ f/ g/ a/ |$\nV:2\nC, D, | [M:6/8] C,3/2 F,3/2 |$\n%%score 1 2\n"
    m = merge([TWO_FOUR, later])
    assert m.lines[1]["meters"] == [[2, 4], [6, 8]]
    assert m.lines[1]["bars"] == [0.5, 0.75]


# ---------------------------------------------------------------- repeats, keys, names
def test_repeats_are_written_out_in_the_order_they_are_sung():
    a = ("X:1\nL:1/4\nM:4/4\nK:C\nV:1\n|: c d e f |1 g4 :|2 c'4 |] d4 |$\nV:2\n|: C D E F |1 G4 :|2 C4 |] D4 |$\n"
         "%%score 1 2\n")
    b = "V:1\ne4 |: f4 | g4 :| a4 |$\nV:2\nE4 |: F4 | G4 :| A4 |$\n%%score 1 2\n"
    m = merge([a, b])
    # line 1: bars 1-2, bar 1 again (the 2nd time), then the 2nd ending and on; line 2's repeat
    assert m.lines[0]["bars"] == [1.0, 1.0, 1.0, 1.0]           # a line opening with |: has no extra bar
    assert m.lines[0]["plays"] == [{"start": 0.0, "from": 0, "to": 2}, {"start": 2.0, "from": 0, "to": 1},
                                   {"start": 3.0, "from": 2, "to": 4}]
    assert m.lines[1]["plays"] == [{"start": 5.0, "from": 0, "to": 3}, {"start": 8.0, "from": 1, "to": 4}]
    v1 = m.abc.split("\nV:1\n")[-1].split("\nV:2\n")[0]
    notes = re.findall(r"[a-gA-G]'?(?=\d|\s|\|)", re.sub(r"\[[A-Z]:[^\]]*\]", "", v1))
    assert notes == ["c", "d", "e", "f", "g", "c", "d", "e", "f", "c'", "d", "e", "f", "g", "f", "g", "a"]
    assert ":|" not in m.abc and "|:" not in m.abc


def test_without_repeats_nothing_is_rewritten():
    m = merge([TWO_FOUR])
    assert m.lines[0]["plays"] == [{"start": 0.0, "from": 0, "to": 2}]
    assert "c d | e f |$" in m.abc


def test_a_new_key_read_on_one_staff_is_given_to_all():
    a = "X:1\nL:1/4\nM:4/4\nK:F\nV:1 treble\nV:2 bass\nV:1\nf g a b |$\nV:2\nF, G, A, B, |$\n%%score 1 2\n"
    b = "V:1\n[K:G] g a b c |$\nV:2\nG, A, B, C |$\n%%score 1 2\n"
    assert merge([a, b]).abc.count("[K:G]") == 2


def test_a_staff_marked_basses_is_the_basses_even_on_a_treble_clef():
    full = ('X:1\nL:1/4\nM:3/4\nK:E\nV:1 treble-8\nV:2 treble-8\nV:3 bass\nV:4 treble nm="Piano"\nV:5 bass\n'
            'V:1\ne f g |$\nV:2\nB c d |$\nV:3\nE, F, G, |$\nV:4\n[EGB]3 |$\nV:5\nE,,3 |$\n%%score [1 2 3] {4 5}\n')
    basses = ('V:1 treble-8\nV:2 treble nm="Piano"\nV:3 bass\n'
              'V:1\n"^basses" G A B |$\nV:2\n[EGB]3 |$\nV:3\nE,,3 |$\n%%score 1 {2 3}\n')
    tenors = ('V:1 treble-8\nV:2 treble nm="Piano"\nV:3 bass\n'
              'V:1\ne f g |$\nV:2\n[EGB]3 |$\nV:3\nE,,3 |$\n%%score 1 {2 3}\n')
    m = merge([full, basses, tenors])
    assert m.lines[1]["staves"] == [["3"], ["4"], ["5"]]
    assert m.lines[2]["staves"] == [["1"], ["4"], ["5"]]


def test_a_percussion_staff_is_only_matched_to_percussion():
    full = ('X:1\nL:1/4\nM:4/4\nK:C\nV:1 treble-8 nm="T"\nV:2 bass nm="B"\nV:3 perc nm="B. P."\n'
            'V:1\ne f g a |$\nV:2\nC, D, E, F, |$\nV:3\nB B B B |$\n%%score [1 2] 3\n')
    no_perc = 'V:1 treble-8\nV:2 bass\nV:1\ne f g a |$\nV:2\nC, D, E, F, |$\n%%score [1 2]\n'
    lone_perc = 'V:1 perc nm="B. P."\nV:1\nB B B B |$\n%%score 1\n'
    m = merge([full, no_perc, lone_perc])
    assert m.lines[1]["staves"] == [["1"], ["2"]]
    assert m.lines[2]["staves"] == [["3"]]
