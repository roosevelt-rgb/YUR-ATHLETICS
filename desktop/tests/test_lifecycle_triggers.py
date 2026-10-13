"""Deterministic trigger arithmetic for deployed agent lifecycles."""
from datetime import datetime, timedelta, timezone
import unittest

from foundry.lifecycle_triggers import (cron_next, first_run, following_run, parse_cron, preview,
                                        resolve_timezone, validate_trigger)

UTC = timezone.utc


def at(text):
    return datetime.fromisoformat(text).replace(tzinfo=UTC)


class CronTests(unittest.TestCase):
    def test_every_fifteen_minutes(self):
        self.assertEqual(cron_next("*/15 * * * *", "UTC", at("2026-10-01T10:07:30")), at("2026-10-01T10:15:00"))
        self.assertEqual(cron_next("*/15 * * * *", "UTC", at("2026-10-01T10:15:00")), at("2026-10-01T10:30:00"))

    def test_weekday_morning_and_names(self):
        # 2026-10-03 is a Saturday; next weekday 08:30 is Monday 2026-10-05.
        self.assertEqual(cron_next("30 8 * * mon-fri", "UTC", at("2026-10-02T09:00:00")), at("2026-10-05T08:30:00"))
        self.assertEqual(cron_next("0 9 1 jan *", "UTC", at("2026-10-01T00:00:00")), at("2027-01-01T09:00:00"))

    def test_dom_and_dow_restricted_means_either(self):
        # Day 15 OR any Sunday; first match after Oct 1 2026 (Thu) is Sunday Oct 4.
        self.assertEqual(cron_next("0 0 15 * 0", "UTC", at("2026-10-01T12:00:00")), at("2026-10-04T00:00:00"))

    def test_sunday_as_seven_and_leap_day(self):
        self.assertEqual(parse_cron("0 0 * * 7")["weekdays"], frozenset({0}))
        self.assertEqual(cron_next("0 12 29 2 *", "UTC", at("2026-10-01T00:00:00")), at("2028-02-29T12:00:00"))

    def test_fixed_offset_timezone(self):
        # 09:00 at -05:00 is 14:00 UTC.
        self.assertEqual(cron_next("0 9 * * *", "-05:00", at("2026-10-01T15:00:00")), at("2026-10-02T14:00:00"))
        self.assertEqual(resolve_timezone("+05:30").utcoffset(None), timedelta(hours=5, minutes=30))

    def test_invalid_expressions_rejected(self):
        for bad in ("* * * *", "60 * * * *", "* 24 * * *", "5-1 * * * *", "*/0 * * * *", "x * * * *", "0 0 30 2 *"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                cron_next(bad, "UTC", at("2026-10-01T00:00:00"))
        with self.assertRaises(ValueError):
            resolve_timezone("+15:00")


class TriggerTests(unittest.TestCase):
    def setUp(self):
        self.now = at("2026-10-01T10:00:00")

    def test_validation_bounds(self):
        validate_trigger({"kind": "interval", "seconds": 60})
        validate_trigger({"kind": "continuous", "cooldown_seconds": 30})
        for bad in ({"kind": "interval", "seconds": 59}, {"kind": "continuous", "cooldown_seconds": 10},
                    {"kind": "once"}, {"kind": "manual", "extra": 1}, {"kind": "daemon"},
                    {"kind": "interval", "seconds": True}, {"kind": "once", "at": "2026-10-01T10:00:00"}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                validate_trigger(bad)

    def test_first_and_following_runs(self):
        self.assertIsNone(first_run({"kind": "manual"}, self.now))
        self.assertEqual(first_run({"kind": "continuous", "cooldown_seconds": 60}, self.now), self.now)
        self.assertEqual(first_run({"kind": "interval", "seconds": 120}, self.now), self.now + timedelta(seconds=120))
        past = {"kind": "once", "at": "2026-09-01T00:00:00+00:00"}
        self.assertEqual(first_run(past, self.now), self.now)
        self.assertIsNone(following_run(past, self.now))
        self.assertEqual(following_run({"kind": "continuous", "cooldown_seconds": 45}, self.now), self.now + timedelta(seconds=45))
        self.assertEqual(following_run({"kind": "cron", "expression": "0 * * * *", "timezone": "UTC"}, self.now),
                         at("2026-10-01T11:00:00"))

    def test_preview_is_bounded(self):
        times = preview({"kind": "cron", "expression": "0 */6 * * *", "timezone": "UTC"}, self.now, 3)
        self.assertEqual(times, ["2026-10-01T12:00:00+00:00", "2026-10-01T18:00:00+00:00", "2026-10-02T00:00:00+00:00"])
        self.assertEqual(len(preview({"kind": "continuous", "cooldown_seconds": 30}, self.now)), 1)
        with self.assertRaises(ValueError):
            preview({"kind": "manual"}, self.now, 0)


if __name__ == "__main__":
    unittest.main()
