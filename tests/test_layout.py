from pathlib import Path

from PIL import Image

from app.layout import analyse_line

PAGE = Path(__file__).resolve().parents[1] / "static" / "test-score.png"


def test_finds_staves_clefs_and_bars_on_the_sample_page():
    page = Image.open(PAGE)
    line = analyse_line(page, [0, 150, page.width, 700])          # first line of music
    assert [s["clef"] for s in line["staves"]] == ["treble", "bass", "treble", "bass"]
    assert len(line["bounds"]) - 1 == 4                             # four printed bars
