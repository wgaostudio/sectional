from fractions import Fraction as F

from app.check import Reading, choose, score_bar, set_key

U, M, BEAT = F(1, 8), F(1), F(1, 4)


def test_muddled_parts_break_the_rules_and_the_clean_reading_wins():
    # the example from The Turtle Dove: a tied chord, then the tenors hold B♭ while the
    # baritones move F → G♭. The full-line reading turned it into one line "B4 c4".
    set_key("Db")
    line = Reading.build("line", [["[FB]8- | B4 c4 |$"]], U, M)
    alone = Reading.build("alone", [["[FB]8- | B8 |$"], ["x8 | F4 G4 |$"]], U, M)
    hard_line, _ = score_bar(line, 1, F(1), F(2), 2, BEAT, F(2))
    hard_alone, _ = score_bar(alone, 1, F(1), F(2), 2, BEAT, F(2))
    assert hard_line >= 2 and hard_alone == 0
    picks, left = choose([line, alone], [F(1), F(1)], BEAT)
    assert picks[1] == "alone" and left == [0, 0]


def test_a_clean_line_reading_is_kept():
    set_key("C")
    line = Reading.build("line", [["c4 d4 | e8 |$"]], U, M)
    alone = Reading.build("alone", [["c4 B4 | e8 |$"]], U, M)
    picks, _ = choose([line, alone], [F(1), F(1)], BEAT)
    assert picks == ["line", "line"]


def test_two_readings_that_agree_outvote_the_line():
    set_key("C")
    line = Reading.build("line", [["c4 d4 |$"], ["G6 A2 |$"]], U, M)
    alone = Reading.build("alone", [["c4 d4 |$"], ["F6 A2 |$"]], U, M)
    pair = Reading.build("pair", [["c4 d4 |$"], ["F6 A2 |$"]], U, M)
    picks, _ = choose([line, alone, pair], [F(1)], BEAT)
    assert picks == ["alone"]


def test_a_stray_third_voice_is_ignored():
    set_key("C")
    r = Reading.build("alone", [["c2 d2 e2 f2 | g8 |$"], ["E2 F2 G2 A2 | B8 |$"], ["x6 G2 | x8 |$"]], U, M)
    assert len(r.segs) == 2
