"""DFW metro place names for the is_dfw flags, read from local data (recruit/data is not in git):
  data/dfw_cities.txt            roster hometowns (sidearm_parser.TX_METRO_DFW matches the hometown's city part)
  data/dfw_school_prefixes.txt   UIL school names (uil_alignment.DFW matches a school name that starts with one)
One name per line; a regex alternative such as 'Ft\\.? Worth' is allowed, a line starting with '#' is a comment, and
matching ignores case. Without a file nothing is flagged DFW by that script; the Texas counts are unaffected."""
from __future__ import annotations

import pathlib
import re

DATA = pathlib.Path(__file__).resolve().parent / "data"
CITIES = DATA / "dfw_cities.txt"
SCHOOL_PREFIXES = DATA / "dfw_school_prefixes.txt"
NEVER = re.compile(r"(?!)")


def names(path: pathlib.Path) -> list[str]:
    if not path.exists():
        return []
    lines = (line.strip() for line in path.read_text(encoding="utf-8").splitlines())
    return [s for s in lines if s and not s.startswith("#")]


def regex(prefix: str, path: pathlib.Path) -> re.Pattern[str]:
    """prefix + '(' + name|name|... + ')\\b', ignoring case; a pattern that never matches when the list is empty."""
    alts = names(path)
    return re.compile(prefix + "(" + "|".join(alts) + r")\b", re.I) if alts else NEVER
