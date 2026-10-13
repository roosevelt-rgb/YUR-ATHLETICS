"""Audited, deterministic specialist capabilities with bounded JSON contracts.

This module is deliberately self-contained and standard-library-only. It performs
no file, network, subprocess or model operations. The pack compiler includes this
same source in every package; capabilities contribute behavior, never authority.
"""
from __future__ import annotations

from collections import Counter
from copy import deepcopy
from decimal import Context, Decimal, ROUND_HALF_UP, localcontext
import hashlib
import json
import math
import re
from types import MappingProxyType

STRATEGIES = ("balanced", "precision")
MAX_TEXT_LENGTH = 100_000
_STOP_WORDS = frozenset("a an and are as at be by for from has have in is it of on or that the this to was were will with".split())


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False)


def validate_schema(value, schema, path="input", depth=0):
    """Validate the bounded subset of JSON Schema used by the shipped contracts."""
    if depth > 12:
        raise ValueError(f"{path}: nesting exceeds the contract limit")
    kind = schema.get("type")
    kinds = kind if isinstance(kind, list) else [kind]
    matches = {
        "null": value is None,
        "boolean": isinstance(value, bool),
        "integer": isinstance(value, int) and not isinstance(value, bool),
        "number": isinstance(value, (float, int)) and not isinstance(value, bool),
        "string": isinstance(value, str),
        "array": isinstance(value, list),
        "object": isinstance(value, dict),
    }
    if kind is not None and not any(matches.get(k, False) for k in kinds):
        raise ValueError(f"{path}: expected {kind}")
    if "enum" in schema and value not in schema["enum"]:
        raise ValueError(f"{path}: unsupported value")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError(f"{path}: numbers must be finite")
        if value < schema.get("minimum", -math.inf) or value > schema.get("maximum", math.inf):
            raise ValueError(f"{path}: number outside contract bounds")
    if isinstance(value, str):
        if len(value) < schema.get("minLength", 0) or len(value) > schema.get("maxLength", MAX_TEXT_LENGTH):
            raise ValueError(f"{path}: text length outside contract bounds")
    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0) or len(value) > schema.get("maxItems", 10_000):
            raise ValueError(f"{path}: item count outside contract bounds")
        for index, item in enumerate(value):
            validate_schema(item, schema.get("items", {}), f"{path}[{index}]", depth + 1)
    if isinstance(value, dict):
        if len(value) > schema.get("maxProperties", 100):
            raise ValueError(f"{path}: too many properties")
        if any(not isinstance(key, str) or len(key) > 200 for key in value):
            raise ValueError(f"{path}: property names must be bounded strings")
        required = schema.get("required", [])
        if any(key not in value for key in required):
            raise ValueError(f"{path}: missing required property")
        properties = schema.get("properties", {})
        extra = schema.get("additionalProperties", False)
        for key, item in value.items():
            if key in properties:
                child = properties[key]
            elif isinstance(extra, dict):
                child = extra
            elif extra is True:
                child = {}
            else:
                raise ValueError(f"{path}: unknown property {key!r}")
            validate_schema(item, child, f"{path}.{key}", depth + 1)


def _object(properties, required=None):
    return {"type": "object", "properties": properties,
            "required": list(properties) if required is None else required,
            "additionalProperties": False}


def _array(items, maximum=2000):
    return {"type": "array", "items": items, "maxItems": maximum}


_STRING = {"type": "string", "maxLength": MAX_TEXT_LENGTH}
_COUNT = {"type": "integer", "minimum": 0}
_FRACTION = {"type": "number", "minimum": 0, "maximum": 1}
_TEXT_INPUT = _object({"text": {**_STRING, "minLength": 1},
                       "top_k": {"type": "integer", "minimum": 1, "maximum": 20}}, ["text"])
_TEXT_OUTPUT = _object({
    "word_count": _COUNT, "sentence_count": _COUNT, "unique_word_count": _COUNT,
    "reading_minutes": {"type": "number", "minimum": 0},
    "keywords": _array(_object({"term": _STRING, "count": _COUNT}), 20),
    "method": {"type": "string", "enum": ["word_frequency", "phrase_frequency"]},
})
_SCALAR = {"type": ["string", "number", "boolean", "null"], "maxLength": 2000}
_DATA_INPUT = _object({"rows": _array({"type": "object", "maxProperties": 100, "additionalProperties": _SCALAR})})
_DATA_OUTPUT = _object({
    "row_count": _COUNT, "column_count": _COUNT, "duplicate_rows": _COUNT,
    "columns": _array(_object({
        "name": _STRING, "type": {"type": "string", "enum": ["unknown", "boolean", "number", "string", "mixed"]},
        "missing_count": _COUNT, "missing_fraction": _FRACTION, "distinct_count": _COUNT,
    }), 100),
    "method": {"type": "string", "enum": ["normalized_values", "strict_values"]},
})
_SUPPORT_INPUT = _object({
    "subject": {"type": "string", "minLength": 1, "maxLength": 500},
    "body": {"type": "string", "maxLength": 20_000},
    "customer_tier": {"type": "string", "enum": ["standard", "premium"]},
}, ["subject", "body"])
_EVIDENCE = _object({"rule": _STRING, "field": {"type": "string", "enum": ["subject", "body", "customer_tier"]},
                     "match": _STRING, "start": _COUNT, "end": _COUNT})
_SUPPORT_OUTPUT = _object({
    "priority": {"type": "string", "enum": ["critical", "high", "normal"]},
    "category": {"type": "string", "enum": ["security", "billing", "access", "technical", "general"]},
    "route": {"type": "string", "enum": ["security-response", "billing-support", "identity-support", "technical-support", "customer-support"]},
    "evidence": _array(_EVIDENCE, 50), "confidence": _FRACTION,
    "requires_human_review": {"type": "boolean"},
    "method": {"type": "string", "enum": ["keyword_rules", "context_rules"]},
})

_HATCH_INPUT = _object({
    "plans_text": {"type": "string", "maxLength": 30_000},
    "specs_text": {"type": "string", "maxLength": 30_000},
})
_HATCH_UNITS = ("SF", "CY", "CF", "LF", "EA", "TON", "GAL", "LBS")
_HATCH_QUANTITY = {"type": "number", "minimum": 0}
_HATCH_SOURCE = _object({
    "field": {"type": "string", "enum": ["plans_text", "specs_text"]},
    "line": {"type": "integer", "minimum": 1}, "start": _COUNT, "end": _COUNT,
    "text": {"type": "string", "maxLength": 30_000},
})
_HATCH_ITEM = _object({
    "division": {"type": "string", "maxLength": 20},
    "qty": _HATCH_QUANTITY,
    "unit": {"type": "string", "enum": list(_HATCH_UNITS)},
    "source": {"type": "string", "maxLength": 140},
    "sources": {**_array(_HATCH_SOURCE, 1), "minItems": 1},
})
_HATCH_OUTPUT = _object({
    "line_items": _array(_HATCH_ITEM, 1000),
    "by_division": {"type": "object", "maxProperties": 1000,
                    "additionalProperties": {"type": "object", "maxProperties": len(_HATCH_UNITS),
                                             "properties": {unit: _HATCH_QUANTITY for unit in _HATCH_UNITS},
                                             "additionalProperties": False}},
    "area_total_sf": _HATCH_QUANTITY,
    "line_count": {"type": "integer", "minimum": 0, "maximum": 1000},
    "truncated": {"type": "boolean"}, "excluded_quantities": _COUNT,
    "totals_scope": {"type": "string", "enum": ["returned_line_items"]},
    "method": {"type": "string", "enum": ["source_quantity_tokens"]},
})

# Promoted from the user-owned workforce donor's _survey/_nearest_division.
# Pure extraction only: no genome, gated_handle, legacy coordinator, or signal bus.
_HATCH_PROVENANCE = {
    "source_id": "yur-unified/workforce", "relative_path": "agents/hatch_quantity.py",
    "source_sha256": "da68288a6d51def386e6cd909e46fa3b3a72c331cdddda05fb666a2e9de10477",
    "functions": {
        "_nearest_division": "c21586fcf3745dbae3ce12bf4a68d0bfbfe57a5a27193a56a2bb7c5e5182b696",
        "_survey": "24d7e2e6f3d7cef002882c3b429d5708e4104f0d2d04167589820b0ef45fd6a1",
    },
    "reconciliation": "bounded-raw-source-quantity-survey-v1",
    "authority_promoted": False,
    "assessment": "Deterministic explicit text tokens; no drawing takeoff or industry accuracy claim",
    "strategy_behavior": "Both strategies use the same reconciled source extraction algorithm",
}
_HATCH_QTY_RE = re.compile(
    r"(?<![\w.,/+\-\u2212\u2013])([+\-\u2212\u2013]?(?:[0-9][0-9,]*(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+\-]?[0-9]+)?)"
    r"[ \t]*(SF|GSF|sq\.?[ \t]*ft|sqft|CY|CF|LF|EA|TONS|TON|GAL|LBS)\b", re.IGNORECASE,
)
_HATCH_VALID_NUMBER = re.compile(r"\+?(?:(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]*)?|\.[0-9]+)\Z")
_HATCH_CSI_RE = re.compile(r"\b(\d{2})\s*(\d{2})\s*(\d{2})\b")
_HATCH_DIV_RE = re.compile(r"\bDivision\s+(\d{1,2})\b", re.IGNORECASE)
_HATCH_UNIT_AFTER = re.compile(r"[ \t]*(?:SF|GSF|sq\.?[ \t]*ft|sqft|CY|CF|LF|EA|TONS|TON|GAL|LBS)\b", re.I)
_HATCH_UNIT_NORM = {"SF": "SF", "GSF": "SF", "SQFT": "SF", "SQ.FT": "SF",
                    "CY": "CY", "CF": "CF", "LF": "LF", "EA": "EA",
                    "TON": "TON", "TONS": "TON", "GAL": "GAL", "LBS": "LBS"}


def _hatch_nearest_division(lines, index):
    """Retain the donor's current-line plus eleven-previous-line CSI lookup."""
    for previous in range(index, max(-1, index - 12), -1):
        line = lines[previous]
        match = _HATCH_CSI_RE.search(line)
        # A six-digit quantity immediately followed by a unit is not a CSI code.
        if match and not _HATCH_UNIT_AFTER.match(line[match.end():]):
            return f"{match.group(1)} {match.group(2)} {match.group(3)}"
        match = _HATCH_DIV_RE.search(line)
        if match:
            return f"Division {match.group(1).zfill(2)}"
    return "unknown"


def hatch_quantity(payload, strategy):
    """Extract explicit positive quantity tokens; totals cover returned items only.

Repeated exact quantity/source lines retain their first observed source, matching
the donor's deduplication intent without its rounded-number/prefix collisions.
Plans and specifications have independent heading scopes. This does not infer
dimensions, measure drawings, price quantities, or execute referenced content.
"""
    items, by_division, seen = [], {}, set()
    area_total_sf, excluded, truncated = 0.0, 0, False
    for field in ("plans_text", "specs_text"):
        lines = payload[field].splitlines(keepends=True)
        offset = 0
        for index, line in enumerate(lines):
            division = None
            source_line = line.strip()
            for match in _HATCH_QTY_RE.finditer(line):
                number = match.group(1)
                prefix = line[max(0, match.start() - 80):match.start()]
                # Malformed grouping, negative/range/exponential fragments and
                # explicit zero do not become positive construction quantities.
                if (not _HATCH_VALID_NUMBER.fullmatch(number)
                        or re.search(r"(?:\d[ \t]*(?:-|\u2013|to)|\b(?:minus|negative))[ \t]*$", prefix, re.I)):
                    excluded += 1
                    continue
                try:
                    quantity = float(number.replace(",", ""))
                except (ValueError, OverflowError):
                    excluded += 1
                    continue
                if not math.isfinite(quantity) or quantity <= 0:
                    excluded += 1
                    continue
                unit = _HATCH_UNIT_NORM[re.sub(r"\s+", "", match.group(2).upper())]
                division = division or _hatch_nearest_division(lines, index)
                key = (division, unit, quantity, source_line)
                if key in seen:
                    continue
                if len(items) >= 1000:
                    truncated = True
                    continue
                division_total = by_division.get(division, {}).get(unit, 0.0) + quantity
                area_total = area_total_sf + quantity if unit == "SF" else area_total_sf
                if not math.isfinite(division_total) or not math.isfinite(area_total):
                    excluded += 1
                    continue
                seen.add(key)
                items.append({"division": division, "qty": quantity, "unit": unit,
                              "source": source_line[:140], "sources": [{
                                  "field": field, "line": index + 1,
                                  "start": offset + match.start(), "end": offset + match.end(),
                                  "text": match.group(0),
                              }]})
                by_division.setdefault(division, {})[unit] = division_total
                area_total_sf = area_total
            offset += len(line)
    return {"line_items": items, "by_division": by_division,
            "area_total_sf": area_total_sf, "line_count": len(items),
            "truncated": truncated, "excluded_quantities": excluded,
            "totals_scope": "returned_line_items", "method": "source_quantity_tokens"}


def analyze_text(payload, strategy):
    text = payload["text"]
    words = re.findall(r"[^\W_]+(?:['’][^\W_]+)?", text.lower(), flags=re.UNICODE)
    sentences = [part for part in re.split(r"[.!?]+", text) if re.search(r"\w", part)]
    if strategy == "precision":
        terms = []
        # Punctuation and stop words break phrases; no phrase crosses a sentence.
        for sentence in re.split(r"[.!?;,:\n]+", text.lower()):
            tokens = re.findall(r"[^\W_]+", sentence, flags=re.UNICODE)
            terms.extend(f"{a} {b}" for a, b in zip(tokens, tokens[1:])
                         if a not in _STOP_WORDS and b not in _STOP_WORDS)
        method = "phrase_frequency"
    else:
        terms = [word for word in words if word not in _STOP_WORDS]
        method = "word_frequency"
    counts = Counter(terms)
    return {"word_count": len(words), "sentence_count": len(sentences),
            "unique_word_count": len(set(words)), "reading_minutes": round(len(words) / 200, 3),
            "keywords": [{"term": term, "count": count} for term, count in
                         sorted(counts.items(), key=lambda item: (-item[1], item[0]))[:payload.get("top_k", 5)]],
            "method": method}


def _value_type(value, strategy):
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if strategy == "balanced" and isinstance(value, str):
        try:
            if math.isfinite(float(value.strip())):
                return "number"
        except (ValueError, OverflowError):
            pass
    return "string"


def profile_data(payload, strategy):
    rows = payload["rows"]
    names = sorted({name for row in rows for name in row})
    if len(names) > 100:
        raise ValueError("input.rows: combined column count exceeds 100")
    columns = []
    for name in names:
        values = [row.get(name) for row in rows]
        present = [value for value in values if value is not None and
                   not (strategy == "balanced" and isinstance(value, str) and not value.strip())]
        types = {_value_type(value, strategy) for value in present}
        columns.append({"name": name, "type": next(iter(types)) if len(types) == 1 else "mixed" if types else "unknown",
                        "missing_count": len(rows) - len(present),
                        "missing_fraction": round((len(rows) - len(present)) / len(rows), 6) if rows else 0.0,
                        "distinct_count": len({_canonical(value) for value in present})})
    return {"row_count": len(rows), "column_count": len(names),
            "duplicate_rows": len(rows) - len({_canonical(row) for row in rows}), "columns": columns,
            "method": "normalized_values" if strategy == "balanced" else "strict_values"}


_CATEGORY_RULES = (
    ("security", "security-response", ("security breach", "unauthorized access", "phishing", "compromised")),
    ("billing", "billing-support", ("invoice", "payment", "refund", "charged", "billing")),
    ("access", "identity-support", ("password", "login", "sign in", "locked out", "authentication")),
    ("technical", "technical-support", ("production down", "service unavailable", "outage", "error", "crash", "bug", "data loss")),
)


def triage_support(payload, strategy):
    evidence = []

    def find(rule, terms):
        for field in ("subject", "body"):
            value = payload[field]
            for term in terms:
                match = re.search(r"(?<!\w)" + re.escape(term) + r"(?!\w)", value, flags=re.IGNORECASE)
                if match:
                    # Precision avoids a small explicit set of negated assertions.
                    prefix = value[max(0, match.start() - 20):match.start()].lower()
                    if strategy == "precision" and re.search(r"(?:no|not|without|resolved)\s+(?:an?\s+)?$", prefix):
                        continue
                    evidence.append({"rule": rule, "field": field, "match": match.group(0),
                                     "start": match.start(), "end": match.end()})
                    return True
        return False

    category, route = "general", "customer-support"
    for candidate, destination, terms in _CATEGORY_RULES:
        if find(f"category.{candidate}", terms):
            category, route = candidate, destination
            break
    critical = ("production down", "service unavailable", "security breach", "data loss")
    if strategy == "balanced":
        critical += ("outage",)
    if find("priority.critical", critical):
        priority = "critical"
    elif find("priority.high", ("urgent", "blocked", "cannot work", "locked out")):
        priority = "high"
    elif payload.get("customer_tier", "standard") == "premium":
        priority = "high"
        evidence.append({"rule": "priority.premium", "field": "customer_tier", "match": "premium", "start": 0, "end": 7})
    else:
        priority = "normal"
    return {"priority": priority, "category": category, "route": route, "evidence": evidence,
            "confidence": 0.9 if evidence and strategy == "precision" else 0.8 if evidence else 0.3,
            "requires_human_review": priority == "critical" or not evidence,
            "method": "keyword_rules" if strategy == "balanced" else "context_rules"}


# Reconciled quoted OPC rows from the BID-ZONE donor. Never import its runner,
# baseline database, Arbiter or audit writer into this pure specialist runtime.
_OPC_PROVENANCE = {
    "source_id": "yur-unified/catalog", "relative_path": "verticals/bidzone/trinity_bridge.py",
    "source_sha256": "9e37e64eff05cd6c72be67c1b8e7f0348d3a28c04f1d231236a8da5aadc20439",
    "functions": {
        "_parse_tabular_opc": "b8def5ab931f4a211f71127216835cc011d2b88f3a2069e5d3a92a3ab1114418",
        "_normalize_unit": "6a06d06afa7da0744de6b7f8c9753a2993485e4a5aaeb4e55191de0a022147c3",
    },
    "reconciliation": "quoted-opc-arithmetic-v1", "authority_promoted": False,
    "assessment": "Quoted construction rows and arithmetic only; no market pricing, approval or land due diligence",
    "strategy_behavior": "Both strategies use the same reconciled source parser and arithmetic",
}
_OPC_LIMITS = {"input_characters": 30_000, "input_bytes": 65_536, "line_items": 100,
               "excluded_records": 100, "output_bytes": 131_072,
               "quantity_max": "1000000000", "money_max": "1000000000000",
               "quantity_decimal_places": 6, "money_decimal_places": 2}
_OPC_FIELDS = ("item_number", "description", "quantity", "unit", "unit_price", "stated_total")
_OPC_ITEM_ID = re.compile(r"[0-9]{1,4}\.[0-9]{1,4}\Z")
_OPC_UNIT_ALIASES = {
    "sf": "SF", "sqft": "SF", "squarefeet": "SF", "lf": "LF", "linft": "LF", "linearfeet": "LF",
    "cy": "CY", "cubicyard": "CY", "cubicyards": "CY", "ea": "EA", "each": "EA", "unit": "EA",
    "ton": "TON", "tons": "TON", "ac": "AC", "acre": "AC", "acres": "AC", "sy": "SY",
    "gal": "GAL", "gallon": "GAL", "ls": "LS", "lumpsum": "LS", "mon": "MON", "month": "MON", "lots": "LOTS",
}
_OPC_UNITS = tuple(sorted(set(_OPC_UNIT_ALIASES.values())))
_OPC_DECIMAL = {"type": "string", "maxLength": 32}
_OPC_SPAN = _object({"field": {"type": "string", "enum": ["text"]}, "line": {"type": "integer", "minimum": 1},
                     "start": _COUNT, "end": _COUNT, "text": {"type": "string", "maxLength": 500}})
_OPC_ROW = _object({
    "item_number": {"type": "string", "maxLength": 9}, "description": {"type": "string", "maxLength": 300},
    "quantity": _OPC_DECIMAL, "unit": {"type": "string", "enum": list(_OPC_UNITS)},
    "unit_price": _OPC_DECIMAL, "stated_total": _OPC_DECIMAL, "calculated_total": _OPC_DECIMAL, "difference": _OPC_DECIMAL,
    "arithmetic": {"type": "string", "enum": ["consistent", "mismatch"]},
    "rounding": {"type": "string", "enum": ["ROUND_HALF_UP"]},
    "format": {"type": "string", "enum": ["pipe", "tab", "vertical"]},
    "sources": _object({name: _OPC_SPAN for name in _OPC_FIELDS}),
})
_OPC_INPUT = _object({"text": {"type": "string", "maxLength": 30_000}})
_OPC_OUTPUT = _object({
    "line_items": _array(_OPC_ROW, 100),
    "excluded": _array(_object({"reason": {"type": "string", "enum": ["malformed_fields", "invalid_item_number", "invalid_description",
                                   "ambiguous_description", "unsupported_unit", "invalid_quantity", "invalid_unit_price", "invalid_stated_total", "arithmetic_limit"]},
                                "source": _OPC_SPAN, "source_truncated": {"type": "boolean"}}), 100),
    "candidate_count": _COUNT, "excluded_count": _COUNT, "omitted_count": _COUNT, "unrecognized_lines": _COUNT,
    "truncated": {"type": "boolean"}, "requires_review": {"type": "boolean"},
    "source": _object({"sha256": {"type": "string", "minLength": 64, "maxLength": 64}, "bytes": _COUNT,
                       "characters": _COUNT, "lines": _COUNT, "offset_unit": {"type": "string", "enum": ["unicode-code-points"]}}),
    "method": {"type": "string", "enum": ["quoted_opc_rows"]},
    "assessment": {"type": "string", "enum": ["quoted_arithmetic_only"]},
    "arithmetic_scope": {"type": "string", "enum": ["returned_line_items"]},
    "limits": _object({key: {"type": "integer" if isinstance(value, int) else "string", "enum": [value]} for key, value in _OPC_LIMITS.items()}),
})


def _opc_unit(text):
    if len(text) > 40 or not re.fullmatch(r"[A-Za-z. \t]+", text):
        return None
    return _OPC_UNIT_ALIASES.get(re.sub(r"[. \t]", "", text.lower()))


def _opc_span(text, start, end, line):
    raw = text[start:end]
    leading = len(raw) - len(raw.lstrip())
    trailing = len(raw.rstrip())
    return {"field": "text", "line": line, "start": start + leading,
            "end": start + max(leading, trailing), "text": raw.strip()}


def _opc_number(text, money=False, require_dollar=False):
    if len(text) > 50 or (require_dollar and not text.startswith("$")):
        raise ValueError("unsupported number")
    if money and text.startswith("$"):
        text = text[1:].strip()
    precision = 2 if money else 6
    integer = r"(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)"
    if not re.fullmatch(rf"(?:{integer}(?:\.[0-9]{{1,{precision}}})?|\.[0-9]{{1,{precision}}})", text):
        raise ValueError("unsupported number")
    value = Decimal(text.replace(",", ""))
    if value > Decimal(_OPC_LIMITS["money_max" if money else "quantity_max"]):
        raise ValueError("number exceeds limits")
    return value


def _opc_quantity_string(value):
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def _opc_row(fields, row_format):
    if len(fields) != 6 or any(not field["text"] for field in fields):
        return None, "malformed_fields"
    item, description, quantity, unit, price, total = [field["text"] for field in fields]
    if not _OPC_ITEM_ID.fullmatch(item):
        return None, "invalid_item_number"
    if len(description) > 300 or not any(character.isalpha() for character in description):
        return None, "invalid_description"
    if _opc_unit(description):
        return None, "ambiguous_description"
    normalized_unit = _opc_unit(unit)
    if not normalized_unit:
        return None, "unsupported_unit"
    values = []
    for value, money, label in ((quantity, False, "quantity"), (price, True, "unit_price"), (total, True, "stated_total")):
        try:
            values.append(_opc_number(value, money, money and row_format == "vertical"))
        except ValueError:
            return None, f"invalid_{label}"
    quantity_value, price_value, total_value = values
    with localcontext(Context(prec=40, rounding=ROUND_HALF_UP)):
        calculated = (quantity_value * price_value).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        if calculated > Decimal(_OPC_LIMITS["money_max"]):
            return None, "arithmetic_limit"
        difference = total_value - calculated
        row = {"item_number": item, "description": description, "quantity": _opc_quantity_string(quantity_value),
               "unit": normalized_unit, "unit_price": format(price_value, ".2f"), "stated_total": format(total_value, ".2f"),
               "calculated_total": format(calculated, ".2f"), "difference": format(difference, ".2f"),
               "arithmetic": "consistent" if difference == 0 else "mismatch", "rounding": "ROUND_HALF_UP",
               "format": row_format, "sources": dict(zip(_OPC_FIELDS, fields))}
    return row, None


def _opc_vertical_start(lines, index):
    """A decimal quantity before its unit/$price is not the next item marker."""
    if not _OPC_ITEM_ID.fullmatch(lines[index]["text"]) or index + 1 >= len(lines):
        return False
    following = lines[index + 1]["text"]
    if not any(character.isalpha() for character in following) or "|" in following or "\t" in following:
        return False
    if _opc_unit(following) and index + 2 < len(lines) and lines[index + 2]["text"].startswith("$"):
        return False
    return True


def inspect_construction_opc(payload, strategy):
    """Inspect explicitly quoted rows without inferring quantities or prices."""
    text = payload["text"]
    if any((ord(character) < 32 and character not in "\r\n\t") or ord(character) == 127 for character in text):
        raise ValueError("OPC source contains unsupported control characters")
    try:
        encoded = text.encode("utf-8")
    except UnicodeError as exc:
        raise ValueError("OPC source must be valid UTF-8 text") from exc
    if len(encoded) > _OPC_LIMITS["input_bytes"]:
        raise ValueError("OPC source exceeds its UTF-8 byte limit")
    lines, offset = [], 0
    physical_lines = text.splitlines(keepends=True)
    for number, raw in enumerate(physical_lines, 1):
        span = _opc_span(text, offset, offset + len(raw), number)
        if span["text"]:
            lines.append(span)
        offset += len(raw)
    result = {"line_items": [], "excluded": [], "candidate_count": 0, "excluded_count": 0, "omitted_count": 0,
              "unrecognized_lines": 0, "truncated": False, "requires_review": False,
              "source": {"sha256": hashlib.sha256(encoded).hexdigest(), "bytes": len(encoded), "characters": len(text),
                         "lines": len(physical_lines), "offset_unit": "unicode-code-points"},
              "method": "quoted_opc_rows", "assessment": "quoted_arithmetic_only", "arithmetic_scope": "returned_line_items",
              "limits": deepcopy(_OPC_LIMITS)}
    index, returned_bytes = 0, 0
    while index < len(lines):
        current = lines[index]
        raw = current["text"]
        separator = "|" if "|" in raw else "\t" if "\t" in raw else None
        if separator:
            parts = raw.split(separator)
            if [part.strip().upper() for part in parts] == ["ITEM", "DESCRIPTION", "QUANTITY", "UNIT", "UNIT PRICE", "TOTAL"]:
                index += 1
                continue
            fields, position = [], current["start"]
            for part in parts:
                fields.append(_opc_span(text, position, position + len(part), current["line"]))
                position += len(part) + 1
            if "|" in raw and "\t" in raw:
                fields = []  # Mixed separators have no admitted field interpretation.
            row_format = "pipe" if separator == "|" else "tab"
            end = index + 1
        elif _OPC_ITEM_ID.fullmatch(raw):
            end = index + 1
            while end < min(index + 6, len(lines)):
                if "|" in lines[end]["text"] or "\t" in lines[end]["text"] or _opc_vertical_start(lines, end):
                    break
                end += 1
            fields, row_format = lines[index:end], "vertical"
        else:
            result["unrecognized_lines"] += 1
            index += 1
            continue
        result["candidate_count"] += 1
        row, error = _opc_row(fields, row_format)
        if error:
            result["excluded_count"] += 1
            source_end = lines[end - 1]["end"]
            source = {**current, "end": min(source_end, current["start"] + 500),
                      "text": text[current["start"]:min(source_end, current["start"] + 500)]}
            record = {"reason": error, "source": source, "source_truncated": source["end"] < source_end}
            destination, limit = result["excluded"], _OPC_LIMITS["excluded_records"]
        else:
            record, destination, limit = row, result["line_items"], _OPC_LIMITS["line_items"]
        cost = len(_canonical(record).encode("utf-8")) + 1
        # Reserve metadata/standard JSON whitespace headroom inside the 128 KiB contract.
        if len(destination) >= limit or returned_bytes + cost > 108 * 1024:
            result["omitted_count"] += 1
            result["truncated"] = True
        else:
            destination.append(record)
            returned_bytes += cost
        index = end
    result["requires_review"] = bool(not result["line_items"] or result["excluded_count"] or result["unrecognized_lines"]
                                     or result["truncated"] or any(row["arithmetic"] == "mismatch" for row in result["line_items"]))
    return result


_HANDLERS = MappingProxyType({"text.analyze": analyze_text, "data.profile": profile_data, "support.triage": triage_support,
                             "workforce.hatch.quantity": hatch_quantity, "construction.opc.inspect": inspect_construction_opc})
_SCHEMAS = MappingProxyType({"text.analyze": (_TEXT_INPUT, _TEXT_OUTPUT),
                           "data.profile": (_DATA_INPUT, _DATA_OUTPUT),
                           "support.triage": (_SUPPORT_INPUT, _SUPPORT_OUTPUT),
                           "workforce.hatch.quantity": (_HATCH_INPUT, _HATCH_OUTPUT),
                           "construction.opc.inspect": (_OPC_INPUT, _OPC_OUTPUT)})
_DESCRIPTIONS = MappingProxyType({
    "text.analyze": ("Text Analyst", "Count words and sentences and rank repeated words or adjacent phrases."),
    "data.profile": ("Data Quality Analyst", "Profile bounded tabular JSON for types, missing values and duplicate rows."),
    "support.triage": ("Support Triage", "Recommend ticket priority and routing with matched-rule evidence; sends no messages."),
    "workforce.hatch.quantity": ("HATCH Quantity Survey", "Extract explicit source quantities by CSI division from plans and specifications text, retaining source evidence and bounded totals."),
    "construction.opc.inspect": ("Construction OPC Inspector", "Inspect six-field quoted construction cost rows, exact source evidence and decimal arithmetic discrepancies; infer no quantities or prices."),
})


def run_capability(capability_id, payload, strategy="balanced"):
    if not isinstance(capability_id, str) or capability_id not in _HANDLERS:
        raise ValueError("unknown capability identifier")
    if strategy not in STRATEGIES:
        raise ValueError("unknown specialist strategy")
    input_schema, output_schema = _SCHEMAS[capability_id]
    validate_schema(payload, input_schema)
    if len(_canonical(payload).encode("utf-8")) > 2_000_000:
        raise ValueError("input exceeds the 2 MB capability limit")
    result = _HANDLERS[capability_id](payload, strategy)
    validate_schema(result, output_schema, "output")
    return result


def _fixtures(capability_id):
    """Hand-authored expected outcomes; never generated from handler execution."""
    if capability_id == "construction.opc.inspect":
        common = {"excluded": [], "candidate_count": 1, "excluded_count": 0, "omitted_count": 0,
                  "unrecognized_lines": 0, "truncated": False, "method": "quoted_opc_rows",
                  "assessment": "quoted_arithmetic_only", "arithmetic_scope": "returned_line_items", "limits": deepcopy(_OPC_LIMITS)}
        cases = [
            {"name": "quoted-uppercase-cut-and-decimal-quantity", "input": {"text": "1.1 | CUT | 2.5 | CY | $4.00 | $10.00"},
             "expected": {**common, "requires_review": False,
                 "source": {"sha256": "b17974a3da4809384fcb7bcef8eb2ccabfe6c83ff78cc7c41f24330e6a7f34ba", "bytes": 37,
                            "characters": 37, "lines": 1, "offset_unit": "unicode-code-points"},
                 "line_items": [{"item_number": "1.1", "description": "CUT", "quantity": "2.5", "unit": "CY", "unit_price": "4.00",
                     "stated_total": "10.00", "calculated_total": "10.00", "difference": "0.00", "arithmetic": "consistent",
                     "rounding": "ROUND_HALF_UP", "format": "pipe", "sources": {
                         "item_number": {"field": "text", "line": 1, "start": 0, "end": 3, "text": "1.1"},
                         "description": {"field": "text", "line": 1, "start": 6, "end": 9, "text": "CUT"},
                         "quantity": {"field": "text", "line": 1, "start": 12, "end": 15, "text": "2.5"},
                         "unit": {"field": "text", "line": 1, "start": 18, "end": 20, "text": "CY"},
                         "unit_price": {"field": "text", "line": 1, "start": 23, "end": 28, "text": "$4.00"},
                         "stated_total": {"field": "text", "line": 1, "start": 31, "end": 37, "text": "$10.00"},
                     }}]}},
            {"name": "quoted-vertical-total-discrepancy", "input": {"text": "1.2\nFILL\n1.25\nCY\n$2.00\n$3.00"},
             "expected": {**common, "requires_review": True,
                 "source": {"sha256": "8d9ccf3f52f1bc2662e5ef308a860f055c6ba5df3d54a9136eeac8daee5a062e", "bytes": 28,
                            "characters": 28, "lines": 6, "offset_unit": "unicode-code-points"},
                 "line_items": [{"item_number": "1.2", "description": "FILL", "quantity": "1.25", "unit": "CY", "unit_price": "2.00",
                     "stated_total": "3.00", "calculated_total": "2.50", "difference": "0.50", "arithmetic": "mismatch",
                     "rounding": "ROUND_HALF_UP", "format": "vertical", "sources": {
                         "item_number": {"field": "text", "line": 1, "start": 0, "end": 3, "text": "1.2"},
                         "description": {"field": "text", "line": 2, "start": 4, "end": 8, "text": "FILL"},
                         "quantity": {"field": "text", "line": 3, "start": 9, "end": 13, "text": "1.25"},
                         "unit": {"field": "text", "line": 4, "start": 14, "end": 16, "text": "CY"},
                         "unit_price": {"field": "text", "line": 5, "start": 17, "end": 22, "text": "$2.00"},
                         "stated_total": {"field": "text", "line": 6, "start": 23, "end": 28, "text": "$3.00"},
                     }}]}},
        ]
        return [{**deepcopy(case), "strategy": strategy} for case in cases for strategy in STRATEGIES]
    if capability_id == "workforce.hatch.quantity":
        payload = {"plans_text": "Division 03\nConcrete 125 CY", "specs_text": "09 51 00\nGypsum 1,200 SF"}
        expected = {
            "line_items": [
                {"division": "Division 03", "qty": 125.0, "unit": "CY", "source": "Concrete 125 CY",
                 "sources": [{"field": "plans_text", "line": 2, "start": 21, "end": 27, "text": "125 CY"}]},
                {"division": "09 51 00", "qty": 1200.0, "unit": "SF", "source": "Gypsum 1,200 SF",
                 "sources": [{"field": "specs_text", "line": 2, "start": 16, "end": 24, "text": "1,200 SF"}]},
            ], "by_division": {"Division 03": {"CY": 125.0}, "09 51 00": {"SF": 1200.0}},
            "area_total_sf": 1200.0, "line_count": 2, "truncated": False, "excluded_quantities": 0,
            "totals_scope": "returned_line_items", "method": "source_quantity_tokens",
        }
        empty = {"line_items": [], "by_division": {}, "area_total_sf": 0.0, "line_count": 0,
                 "truncated": False, "excluded_quantities": 2,
                 "totals_scope": "returned_line_items", "method": "source_quantity_tokens"}
        return [{"name": "source-quantities-and-divisions", "strategy": strategy,
                 "input": deepcopy(payload), "expected": deepcopy(expected)} for strategy in STRATEGIES] + [
                    {"name": "zero-and-negative-not-quantities", "strategy": strategy,
                     "input": {"plans_text": "0 SF\n-4 CY", "specs_text": "No numeric quantities."},
                     "expected": deepcopy(empty)} for strategy in STRATEGIES]
    if capability_id == "text.analyze":
        common = {"word_count": 6, "sentence_count": 2, "unique_word_count": 3, "reading_minutes": 0.03}
        return [
            {"name": "repeated-words", "strategy": "balanced", "input": {"text": "Fast agents build. Fast agents build."},
             "expected": {**common, "keywords": [{"term": "agents", "count": 2}, {"term": "build", "count": 2}, {"term": "fast", "count": 2}], "method": "word_frequency"}},
            {"name": "repeated-phrases", "strategy": "precision", "input": {"text": "Fast agents build. Fast agents build."},
             "expected": {**common, "keywords": [{"term": "agents build", "count": 2}, {"term": "fast agents", "count": 2}], "method": "phrase_frequency"}},
        ]
    if capability_id == "data.profile":
        rows = [{"id": "1", "name": "Ada"}, {"id": "1", "name": "Ada"}, {"id": "2", "name": ""}]
        return [
            {"name": "normalize-missing-and-numbers", "strategy": "balanced", "input": {"rows": rows},
             "expected": {"row_count": 3, "column_count": 2, "duplicate_rows": 1, "columns": [
                 {"name": "id", "type": "number", "missing_count": 0, "missing_fraction": 0.0, "distinct_count": 2},
                 {"name": "name", "type": "string", "missing_count": 1, "missing_fraction": 0.333333, "distinct_count": 1}], "method": "normalized_values"}},
            {"name": "preserve-source-types", "strategy": "precision", "input": {"rows": rows},
             "expected": {"row_count": 3, "column_count": 2, "duplicate_rows": 1, "columns": [
                 {"name": "id", "type": "string", "missing_count": 0, "missing_fraction": 0.0, "distinct_count": 2},
                 {"name": "name", "type": "string", "missing_count": 0, "missing_fraction": 0.0, "distinct_count": 2}], "method": "strict_values"}},
        ]
    return [
        {"name": "route-critical-outage", "strategy": "balanced", "input": {"subject": "Outage", "body": "Production down"},
         "expected": {"priority": "critical", "category": "technical", "route": "technical-support", "evidence": [
             {"rule": "category.technical", "field": "subject", "match": "Outage", "start": 0, "end": 6},
             {"rule": "priority.critical", "field": "subject", "match": "Outage", "start": 0, "end": 6}],
             "confidence": 0.8, "requires_human_review": True, "method": "keyword_rules"}},
        {"name": "require-outage-context", "strategy": "precision", "input": {"subject": "Outage", "body": "Production down"},
         "expected": {"priority": "critical", "category": "technical", "route": "technical-support", "evidence": [
             {"rule": "category.technical", "field": "subject", "match": "Outage", "start": 0, "end": 6},
             {"rule": "priority.critical", "field": "body", "match": "Production down", "start": 0, "end": 15}],
             "confidence": 0.9, "requires_human_review": True, "method": "context_rules"}},
    ]


def catalog():
    """Return fresh JSON metadata; callers cannot mutate the authoritative catalog."""
    return [{"id": cid, "name": _DESCRIPTIONS[cid][0], "description": _DESCRIPTIONS[cid][1],
             "input_schema": deepcopy(_SCHEMAS[cid][0]), "output_schema": deepcopy(_SCHEMAS[cid][1]),
             "fixtures": deepcopy(_fixtures(cid)),
             "runtime": {"language": "python", "minimum_version": "3.11", "handler": _HANDLERS[cid].__name__, "dependencies": [],
                         **({"provenance": deepcopy(_HATCH_PROVENANCE)} if cid == "workforce.hatch.quantity" else
                            {"provenance": deepcopy(_OPC_PROVENANCE)} if cid == "construction.opc.inspect" else {})},
             "permissions": [], "trust": {"source": "audited-local", "health": "available", "validation": "fixed-outcome-fixtures"},
             "rollback": {"behavior": "pure_function_no_durable_mutation"}} for cid in sorted(_HANDLERS)]


class CapabilityRegistry:
    def catalog(self):
        return catalog()

    def get(self, capability_id):
        for item in catalog():
            if item["id"] == capability_id:
                return item
        raise ValueError("unknown capability identifier")


class CapabilityResolver:
    def __init__(self, registry=None):
        self.registry = registry or CapabilityRegistry()

    def resolve(self, capability_ids):
        if (not isinstance(capability_ids, list) or not 1 <= len(capability_ids) <= len(_HANDLERS)
                or any(not isinstance(cid, str) for cid in capability_ids)
                or len(set(capability_ids)) != len(capability_ids)):
            raise ValueError("capabilities must be a nonempty list of unique exact identifiers")
        return [{**self.registry.get(cid), "selection_reason": f"Explicit mission request exactly matched registered capability {cid}."}
                for cid in capability_ids]
