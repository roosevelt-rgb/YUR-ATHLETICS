# Construction OPC inspection provenance

Status: the pure capability and deterministic standalone packages passed local acceptance on 2026-09-12. Work/chat admission and native model integration are separate checks; this receipt does not claim those interfaces were exercised here.

The capability `construction.opc.inspect` promotes quoted construction cost-line parsing from the user-provided `<unified-root>\catalog\verticals\bidzone\trinity_bridge.py`. The complete 37,239-byte donor was read as source, without imports or execution. Its SHA-256 is `9e37e64eff05cd6c72be67c1b8e7f0348d3a28c04f1d231236a8da5aadc20439`.

The source functions are `_parse_tabular_opc` (lines 791–878, SHA-256 `b8def5ab931f4a211f71127216835cc011d2b88f3a2069e5d3a92a3ab1114418`) and `_normalize_unit` (lines 881–895, SHA-256 `6a06d06afa7da0744de6b7f8c9753a2993485e4a5aaeb4e55191de0a022147c3`). Function hashes cover the UTF-8 AST source segment after CRLF-to-LF normalization, without a trailing newline.

## Relationship to TERRA and HATCH

TERRA identifies cost models, survey, utilities, site analysis and risk among its land-development scopes. Its Planner/Researcher/Analyst/Critic/Synthesizer workflow calls for sourced analysis and cited deliverables. HATCH already extracts explicit quantity tokens. OPC inspection adds quoted unit prices and stated-total arithmetic evidence to that work. It does not determine parcel suitability, zoning compliance, market prices, title, feasibility or complete due diligence.

## Admitted formats

Input is exactly `{ "text": "..." }`, at most 30,000 Unicode code points and 65,536 UTF-8 bytes. Text may contain six-field pipe-separated or tab-separated rows in this order: item number, description, quantity, unit, unit price, stated total. The recognized optional header is `ITEM | DESCRIPTION | QUANTITY | UNIT | UNIT PRICE | TOTAL` (tabs also supported). Quoting/escaping separators inside a field is unsupported.

Six-line OPC blocks use the same field order and require dollar-prefixed unit price and stated total, such as:

```text
2.5
CUT
625000
C.Y.
$1.50
$937,500.00
```

Item numbers must contain a dot, such as `2.5`. Descriptions remain literal, including uppercase words. A description equal to a supported unit token is ambiguous and excluded. Blank lines do not carry field meaning. Unknown text is counted and requires review; headings do not assign CSI or cost authority.

Quantities are nonnegative decimal values up to 1,000,000,000 with at most six decimal places. Prices and stated totals are nonnegative decimal values up to 1,000,000,000,000 with at most two decimal places. Correct thousands grouping is required. Negative values, exponent notation, missing fields, unsupported units and out-of-bounds arithmetic are excluded with source evidence. Zero is retained only when explicitly supplied. No missing quantity or price is filled in.

## Evidence and arithmetic

Outputs contain decimal strings, exact field quotes, zero-based end-exclusive Unicode code-point offsets, one-based source line numbers, and the whole-input UTF-8 SHA-256/byte count. `quantity × unit_price` is calculated with `Decimal`, rounded to two decimal places using `ROUND_HALF_UP`, and compared with the quoted total. `difference` is stated total minus calculated total. Arithmetic consistency is not price validity or approval. The dollar symbol is source notation; jurisdiction and currency conversion are not inferred.

Both `balanced` and `precision` use the same parser and hand-authored expected outcomes. There is no artificial strategy difference. Results expose exclusions, unknown lines, omissions, truncation and whether parsing/arithmetic requires review. At most 100 line items and 100 exclusion records are returned within a 128 KiB JSON budget. Arithmetic results cover returned line items only; incomplete source coverage remains visible.

## Reconciliation and authority boundary

The target self-contained `foundry/specialists.py` routine retains the donor's OPC field concept and unit aliases. It replaces the donor's loose look-ahead with explicit row boundaries, retains uppercase descriptions, separates quantity from price grammar, uses decimal arithmetic and adds source spans. It removes baseline-price fallback, inferred quantity one, false price-validation success, self-issued approval and purported cryptographic signatures.

The donor's Trinity loader/executor, OS kernel, external paths, SQLite price database, audit-file writer and Arbiter are not imported or executed. The pure specialist performs no filesystem, database, subprocess, network or model operations. Existing capability resolution, pack compilation/validation and CommitService remain authoritative. Concept lifecycle and evaluation gates remain separate from a single OPC inspection result.

## Acceptance

`tests/test_construction_capability.py` covers exact quoted outcomes, CRLF/Unicode source fidelity, decimal quantities, currency grouping/rounding, caller decimal-context isolation, uppercase/unit ambiguity, adjacent partial rows, negatives/extremes, strict input, output budgets, both strategy fixtures, deterministic packaging and actual standalone execution. Donor outcome tests were not present in the inspected BID-ZONE scope.

Validation commands and completed results:

```powershell
python -B -m unittest discover -s tests -p test_construction_capability.py -v  # 12 passed
python -B -m unittest discover -s tests -p test_specialists.py -v             # 24 passed
python -B -m unittest discover -s tests -p test_workforce_quantity.py -v      # 12 passed
```

These runs use hand-authored source fixtures and temporary package/state directories. Standalone processes run only the freshly compiled audited package. There are no donor imports, donor runtime launches, external service calls, user-directory writes or pricing database reads in these tests. Both strategy packages reproduce the actual decimal/evidence output on new input.
