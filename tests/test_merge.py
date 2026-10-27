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
