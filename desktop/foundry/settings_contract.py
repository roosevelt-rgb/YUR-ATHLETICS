"""Typed desktop preferences; CommitService remains the persistence authority."""
from __future__ import annotations

import json
import math
from pathlib import Path


def preference_fields() -> dict:
    path = Path(__file__).resolve().parents[1] / "settings-preferences.json"
    return json.loads(path.read_text(encoding="utf-8"))["fields"]


def validate_preferences(value: object) -> dict:
    fields = preference_fields()
    if not isinstance(value, dict) or set(value) - set(fields):
        raise ValueError("Desktop preferences contain unsupported fields")
    for key, item in value.items():
        rule = fields[key]
        kind = rule["type"]
        if kind == "boolean":
            valid = type(item) is bool
        elif kind == "enum":
            valid = isinstance(item, str) and item in rule["choices"]
        elif kind == "string":
            valid = isinstance(item, str) and len(item) <= rule["max_length"] and "\0" not in item
        elif kind in ("integer", "number"):
            valid = (type(item) is int if kind == "integer" else type(item) in (int, float))
            valid = valid and math.isfinite(item) and rule["minimum"] <= item <= rule["maximum"]
        else:
            valid = False
        if not valid:
            raise ValueError(f"Invalid desktop preference: {key}")
    return value
