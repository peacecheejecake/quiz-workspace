"""Build the subset fonts embedded in the synthetic PDF fixtures (M1.1).

The committed fonts under ``tests/fixtures/pdfs/fonts/`` are subsets of Noto Sans KR (SIL Open
Font License 1.1, see ``OFL.txt`` next to them) restricted to the characters the fixtures draw.
Re-run this script only when ``fixture_content.py`` gains characters the fonts do not cover
(``make_fixture_pdfs.py`` fails loudly in that case)::

    uv run python packages/core/scripts/make_fixture_font.py \\
        --regular /path/to/NotoSansKR-Regular.ttf --bold /path/to/NotoSansKR-Bold.ttf

The sources are the static TrueType instances of the Google Fonts "Noto Sans KR" family.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from fixture_content import all_strings, heading_strings
from fontTools import subset  # type: ignore[import-untyped]
from fontTools.ttLib import TTFont  # type: ignore[import-untyped]

REPO_ROOT = Path(__file__).resolve().parents[3]
FONT_DIR = REPO_ROOT / "tests" / "fixtures" / "pdfs" / "fonts"
REGULAR_NAME = "NotoSansKR-FixtureSubset-Regular.ttf"
BOLD_NAME = "NotoSansKR-FixtureSubset-Bold.ttf"

# Printable ASCII plus punctuation the generator draws outside the content strings.
BASE_CHARS = "".join(chr(c) for c in range(0x20, 0x7F)) + "·—…"
# 2000-01-01T00:00:00Z in seconds since 1904-01-01 (the OpenType epoch).
FIXED_TIMESTAMP = 3029529600


def _subset(source: Path, target: Path, chars: str, style: str) -> None:
    options = subset.Options()
    options.hinting = False
    options.layout_features = []
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]
    options.notdef_outline = True
    options.drop_tables += ["DSIG", "GPOS", "GSUB", "GDEF"]
    font = TTFont(str(source), recalcTimestamp=False)
    if "glyf" not in font:
        raise SystemExit(f"{source}: need a TrueType (glyf) font; reportlab cannot embed CFF")
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes={ord(ch) for ch in chars})
    subsetter.subset(font)

    family = "Noto Sans KR Fixture Subset"
    postscript = f"NotoSansKRFixtureSubset-{style}"
    names = font["name"]
    for record in list(names.names):
        if record.nameID in (1, 4, 16):
            names.setName(
                family if record.nameID != 4 else f"{family} {style}",
                record.nameID,
                record.platformID,
                record.platEncID,
                record.langID,
            )
        elif record.nameID == 3:
            names.setName(
                f"{postscript};fixture", 3, record.platformID, record.platEncID, record.langID
            )
        elif record.nameID == 6:
            names.setName(postscript, 6, record.platformID, record.platEncID, record.langID)
    font["head"].created = FIXED_TIMESTAMP
    font["head"].modified = FIXED_TIMESTAMP
    target.parent.mkdir(parents=True, exist_ok=True)
    font.save(str(target))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--regular", type=Path, required=True)
    parser.add_argument("--bold", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=FONT_DIR)
    args = parser.parse_args()

    body = BASE_CHARS + "".join(all_strings())
    headings = BASE_CHARS + "".join(heading_strings())
    _subset(args.regular, args.out / REGULAR_NAME, "".join(sorted(set(body))), "Regular")
    _subset(args.bold, args.out / BOLD_NAME, "".join(sorted(set(headings))), "Bold")
    for name in (REGULAR_NAME, BOLD_NAME):
        print(f"{args.out / name}: {(args.out / name).stat().st_size} bytes")


if __name__ == "__main__":
    main()
