"""Deterministic trigger arithmetic for deployed agent lifecycles.

Pure standard-library code: no clock reads, timers, threads, processes or I/O.
Callers supply every instant, so committed history can be re-verified exactly.

Supported triggers (all bounded):
  manual      {"kind": "manual"}                                   run only on request
  once        {"kind": "once", "at": ISO-8601 with offset}         a single run
  interval    {"kind": "interval", "seconds": 60..86400}           fixed cadence after each run
  cron        {"kind": "cron", "expression": "m h dom mon dow",    5-field cron
               "timezone": "UTC" | "+HH:MM" | "-HH:MM" | IANA}
  continuous  {"kind": "continuous", "cooldown_seconds": 30..86400} long-running loop: run again
                                                                    after each terminal run
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import re

TRIGGER_KINDS = ("manual", "once", "interval", "cron", "continuous")
_FIELDS = {
    "manual": {"kind"},
    "once": {"kind", "at"},
    "interval": {"kind", "seconds"},
    "cron": {"kind", "expression", "timezone"},
    "continuous": {"kind", "cooldown_seconds"},
}
_MONTHS = {name: index for index, name in enumerate(
    ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"), start=1)}
_DAYS = {name: index for index, name in enumerate(("sun", "mon", "tue", "wed", "thu", "fri", "sat"))}
_OFFSET = re.compile(r"^([+-])(\d{2}):(\d{2})$")
_SEARCH_DAYS = 366 * 5  # Feb 29 on a specific weekday can be years away; bound the walk.


def parse_instant(value):
    if not isinstance(value, str) or len(value) > 64 or "T" not in value:
        raise ValueError("Trigger instants must be timezone-aware ISO strings")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, OverflowError) as exc:
        raise ValueError("Trigger instants must be timezone-aware ISO strings") from exc
    if parsed.tzinfo is None:
        raise ValueError("Trigger instants must include a timezone")
    return parsed.astimezone(timezone.utc)


def resolve_timezone(spec):
    if not isinstance(spec, str) or not 1 <= len(spec) <= 64:
        raise ValueError("Cron timezone must be UTC, a fixed ±HH:MM offset or an IANA name")
    if spec.upper() in {"UTC", "Z", "GMT"}:
        return timezone.utc
    match = _OFFSET.fullmatch(spec)
    if match:
        sign, hours, minutes = match.groups()
        if int(hours) > 14 or int(minutes) > 59:
            raise ValueError("Fixed cron offsets must be within ±14:59")
        delta = timedelta(hours=int(hours), minutes=int(minutes))
        return timezone(-delta if sign == "-" else delta)
    try:
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
    except ImportError as exc:  # pragma: no cover - zoneinfo is stdlib on 3.9+
        raise ValueError("Named timezones are unavailable; use UTC or ±HH:MM") from exc
    try:
        return ZoneInfo(spec)
    except (ZoneInfoNotFoundError, ValueError, OSError) as exc:
        raise ValueError(f"Timezone {spec!r} is unavailable on this machine; use UTC or ±HH:MM") from exc


def _atom(text, low, high, names):
    lowered = text.lower()
    if lowered in names:
        return names[lowered]
    if not re.fullmatch(r"\d{1,2}", text):
        raise ValueError(f"Invalid cron value {text!r}")
    value = int(text)
    if not low <= value <= high:
        raise ValueError(f"Cron value {value} is outside {low}..{high}")
    return value


def _field(text, low, high, names=None, *, weekday=False):
    names = names or {}
    if not isinstance(text, str) or not text or len(text) > 120:
        raise ValueError("Invalid cron field")
    values = set()
    for part in text.split(","):
        step = 1
        if "/" in part:
            part, raw_step = part.split("/", 1)
            if not re.fullmatch(r"\d{1,2}", raw_step) or not 1 <= int(raw_step) <= high - low + 1:
                raise ValueError(f"Invalid cron step {raw_step!r}")
            step = int(raw_step)
        if part == "*":
            start, end = low, high
        elif "-" in part:
            first, last = part.split("-", 1)
            start, end = _atom(first, low, high, names), _atom(last, low, high, names)
            if start > end:
                raise ValueError("Cron ranges must ascend")
        else:
            start = _atom(part, low, high, names)
            end = high if step > 1 else start
        values.update(range(start, end + 1, step))
    if weekday and 7 in values:
        values.discard(7)
        values.add(0)
    return frozenset(values)


def parse_cron(expression):
    if not isinstance(expression, str) or len(expression) > 200:
        raise ValueError("Cron expression must be a bounded string")
    parts = expression.split()
    if len(parts) != 5:
        raise ValueError("Cron expressions use 5 fields: minute hour day-of-month month day-of-week")
    minute, hour, dom, month, dow = parts
    return {
        "minutes": _field(minute, 0, 59),
        "hours": _field(hour, 0, 23),
        "days": _field(dom, 1, 31),
        "months": _field(month, 1, 12, _MONTHS),
        "weekdays": _field(dow, 0, 7, _DAYS, weekday=True),
        # Standard cron: when both day fields are restricted, either may match.
        "dom_restricted": dom != "*",
        "dow_restricted": dow != "*",
    }


def _day_matches(spec, local):
    dom_ok = local.day in spec["days"]
    dow_ok = (local.isoweekday() % 7) in spec["weekdays"]
    if spec["dom_restricted"] and spec["dow_restricted"]:
        return dom_ok or dow_ok
    if spec["dom_restricted"]:
        return dom_ok
    if spec["dow_restricted"]:
        return dow_ok
    return True


def cron_next(expression, tz_spec, after):
    """First fire strictly after `after` (aware datetime), returned in UTC."""
    spec = parse_cron(expression)
    zone = resolve_timezone(tz_spec)
    if not isinstance(after, datetime) or after.tzinfo is None:
        raise ValueError("Cron search requires an aware instant")
    # Walk naive wall-clock time in the deployment's zone.
    wall = after.astimezone(zone).replace(second=0, microsecond=0, tzinfo=None) + timedelta(minutes=1)
    limit = wall + timedelta(days=_SEARCH_DAYS)
    while wall <= limit:
        if wall.month not in spec["months"]:
            wall = (wall.replace(day=1, hour=0, minute=0) + timedelta(days=32)).replace(day=1)
            continue
        if not _day_matches(spec, wall):
            wall = wall.replace(hour=0, minute=0) + timedelta(days=1)
            continue
        if wall.hour not in spec["hours"]:
            wall = wall.replace(minute=0) + timedelta(hours=1)
            continue
        if wall.minute not in spec["minutes"]:
            wall += timedelta(minutes=1)
            continue
        candidate = wall.replace(tzinfo=zone).astimezone(timezone.utc)
        if candidate > after.astimezone(timezone.utc):
            return candidate
        wall += timedelta(minutes=1)
    raise ValueError("Cron expression has no fire time within five years")


def validate_trigger(trigger):
    if not isinstance(trigger, dict) or trigger.get("kind") not in TRIGGER_KINDS:
        raise ValueError(f"Trigger kind must be one of {', '.join(TRIGGER_KINDS)}")
    if set(trigger) != _FIELDS[trigger["kind"]]:
        raise ValueError("Trigger contains missing or unsupported fields")
    kind = trigger["kind"]
    if kind == "once":
        parse_instant(trigger["at"])
    elif kind == "interval":
        if type(trigger["seconds"]) is not int or not 60 <= trigger["seconds"] <= 86400:
            raise ValueError("Interval triggers run every 60..86400 seconds")
    elif kind == "continuous":
        if type(trigger["cooldown_seconds"]) is not int or not 30 <= trigger["cooldown_seconds"] <= 86400:
            raise ValueError("Continuous lifecycles rest 30..86400 seconds between runs")
    elif kind == "cron":
        parse_cron(trigger["expression"])
        resolve_timezone(trigger["timezone"])
    return dict(trigger)


def first_run(trigger, instant):
    """Next run for a newly activated deployment (None = only on request)."""
    trigger = validate_trigger(trigger)
    kind = trigger["kind"]
    if kind == "manual":
        return None
    if kind == "once":
        return max(parse_instant(trigger["at"]), instant)
    if kind == "interval":
        return instant + timedelta(seconds=trigger["seconds"])
    if kind == "cron":
        return cron_next(trigger["expression"], trigger["timezone"], instant)
    return instant  # continuous: start immediately


def following_run(trigger, instant):
    """Next run after a terminal run at `instant` (None = no further automatic run)."""
    trigger = validate_trigger(trigger)
    kind = trigger["kind"]
    if kind in {"manual", "once"}:
        return None
    if kind == "interval":
        return instant + timedelta(seconds=trigger["seconds"])
    if kind == "continuous":
        return instant + timedelta(seconds=trigger["cooldown_seconds"])
    return cron_next(trigger["expression"], trigger["timezone"], instant)


def preview(trigger, instant, count=5):
    """Upcoming fire times for UI confirmation; never persisted."""
    if type(count) is not int or not 1 <= count <= 20:
        raise ValueError("Preview count must be 1..20")
    trigger = validate_trigger(trigger)
    times, cursor = [], first_run(trigger, instant)
    while cursor is not None and len(times) < count:
        times.append(cursor.isoformat())
        if trigger["kind"] == "continuous":
            break  # depends on run duration; only the first start is knowable
        cursor = following_run(trigger, cursor)
    return times
