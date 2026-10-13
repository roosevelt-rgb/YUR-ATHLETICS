# Generated Python specialists

In **Code** mode, select a project containing an existing acceptance-contract
JSON file. Ask YUR to read its current hash and call `forge_python_specialist`
with that path and hash. The repository includes
[`examples/quantity-rollup.specialist.json`](../examples/quantity-rollup.specialist.json)
as a small, manually authored starting example. Review and prepare the expected
cases before the generation mission; a same-mission edit or copied/reformatted
model artifact cannot become that mission's acceptance contract.

The Work manager retains the acquired contract before requesting two fresh model
candidates. Each request receives only the public behavior and schemas. Candidate
code runs in the already-admitted serial cell. Expected outputs stay in the host
validator. A candidate must match every case before CommitService publishes its
source, contract, driver and validation digests. If both pass, smaller UTF-8 source
wins, with SHA-256 as the deterministic tie breaker. This is an explicit package
size tradeoff; it is not a general code-quality ranking. Duplicate syntax trees
are rejected; distinct syntax alone does not establish semantic diversity.

Open **Agents → Generated Python** to inspect retained workers. **Use in Code**
prepares an editable draft with the exact source Work ID, build step and artifact
digest. Send fresh input through `run_python_specialist`; its source and original
acceptance evidence are rechecked before contained execution. New results are
checked against the output schema. Their unseen-input correctness is not implied
by the original cases. No generated source is imported into the Desktop process
or added to the trusted built-in pack runtime.

The library scans at most the newest 200 Work records, pages by publication
identity and bounds each returned data page to 120 KiB. Empty discovery creates
no journal. Reading or inspecting a worker does not execute it. The first format
retains workers locally; exporting or deploying these generated workers is not
implemented.

`foundry/generated_contracts.py` defines a bounded, pure contract for new Python
worker behavior. It does not generate or execute code, publish packs, grant
permissions, choose a provider, or prove industry correctness. Work ingress,
contained execution and CommitService own those separate responsibilities.

## Frozen acceptance contract

A contract has exactly these fields:

```text
schema: "yur.python-specialist-contract.v1"
name: 1..100 printable characters, no surrounding whitespace
description: 1..4000 characters containing non-whitespace text
input_schema: bounded object schema
output_schema: bounded object schema
cases: 3..8 objects, each exactly {id, input, expected}
```

Case IDs are distinct lowercase logical identifiers of at most 64 characters.
Inputs must be distinct, including numerically equivalent inputs such as `1`
and `1.0` or signed numeric zero. Repeated input with a different expected value
is rejected as ambiguous. Every input and expected output must satisfy its
declared schema. The SHA-256 contract digest includes all acceptance cases.

The Work binding acquires the user-selected contract from its source at an
expected file hash and freezes it before generation. A model-written contract in
the same mission is not an independent acceptance source. The validator cannot
establish source ownership or infer the accuracy of the supplied expectations;
the ingress and retained source evidence must establish where they came from.

Candidate generation receives `public_contract()`: only the name, description,
input schema and output schema. It receives neither acceptance cases nor sibling
candidate outputs. An operator can nevertheless put example-like information in
the description; the projection does not establish statistical independence or
prevent inference of expected behavior from the task definition.

After contained execution, a fixed outward validator compares actual returned
JSON with the frozen expected JSON. The worker does not receive expected values
and cannot supply an authoritative pass flag. Exit status or printed test claims
alone are insufficient. Passing means only that those finite, operator-supplied
examples matched under the recorded runtime and source digests. It does not
establish general correctness, safe domain decisions, market superiority, or an
independent industry certification. Unknown inputs remain a coverage gap.

Source, cell and evaluation checkpoints are distinct. After an interrupted
acknowledgment, the same Work request resumes its retained source and reuses any
committed cell output. Saved acceptance decisions are rederived from actual
recorded outputs before publication. The host never treats a guest's printed
"passed" message or process exit zero as an acceptance decision.

The fixed driver uses a canonical base64/JSON envelope within the current cell's
output budget. Reported stdout hashes refer to the guardian's normalized display
bytes. The driver receives no expected values. Native execution still requires
the already-running admitted WSL resource; the Desktop does not boot a guest,
install packages, grant network access or fall back to host execution.

## Schema subset and bounds

Each schema node has one explicit `type`: `object`, `array`, `string`, `integer`,
`number`, `boolean`, or `null`. Input and output roots must be objects.

| Type | Supported fields besides `type` |
| --- | --- |
| Object | Required `properties`, `required`, `additionalProperties: false`; optional `maxProperties` |
| Array | Required `items`, `maxItems`; optional `minItems` |
| String | Required `maxLength`; optional `minLength`, `enum` |
| Integer / number | Optional `minimum`, `maximum`, `enum` |
| Boolean / null | Optional `enum` |

Unknown keywords are rejected, including schema-node `description`, `$ref`,
`$schema`, unions, patterns, formats, defaults and composite schemas. The
top-level contract description carries the behavior specification. Enums have
1..32 distinct scalar values of the declared type and within declared bounds.
Required names must refer to distinct declared properties. Numeric bounds cannot
contradict one another; integer bounds must themselves be integers.

- Schema depth: at most eight nodes along a schema path.
- Object properties: at most 32; additional properties are always rejected.
- Array items: an explicit maximum of at most 128.
- String length: an explicit maximum of at most 8,000 Unicode code points.
- Full contract: at most 64 KiB of canonical UTF-8 JSON.
- Each input: at most 16 KiB; each output: at most 32 KiB.
- Generic JSON traversal: at most 6,000 nodes; contract representation depth at
  most 24, runtime value depth at most eight.
- Numbers: finite, absolute magnitude no greater than 9,007,199,254,740,991;
  booleans are not integers. These bounds do not remove binary-float rounding.
- Plain JSON types only: no non-string object keys, cyclic values, Python-specific
  values, invalid Unicode, or control characters other than tab/CR/LF in values.
- The existing credential-content detector rejects matching strings and
  credential-like key/value assignments. This is a bounded detector, not proof
  that arbitrary content contains no confidential information.

`outputs_equal()` compares compact, sorted-key UTF-8 JSON. Object key order does
not matter. Array order, scalar types, `1` versus `1.0`, and `-0.0` versus `0.0`
do matter; there is no numeric tolerance or string coercion. Invalid JSON raises
`ValueError`. A caller must validate output against the contract before comparison.

## APIs and example

### Continuing a generated worker as a concept

The Work tools expose `bind_generated_concept_version`. Select the exact
`source_work_id`, `build_step_index` and `artifact_sha256` from the generated
library, together with the concept's current revision. The first version uses
`parent_version_id: null`; subsequent versions refer to an earlier version of
that same concept. Existing built-in package versions keep their original shape.

A generated version retains its source, contract, driver, runtime, publication
receipt, acceptance-cohort digest and selected evidence verifier. The exact
committed Work authority selects the reader: `yur.generated-evidence.v1` for
the historical 20-step envelope and `yur.generated-evidence.v2` for the 128-step
envelope. Unknown or modified authority envelopes are rejected. Retained
versions pin that interpretation; rereading an old publication never upgrades
it to a newer verifier.

New bindings also check current admission. Reconstructing earlier history does
not require the current execution runtime to be available or identical.
Historical verification reads committed records and never imports or executes
worker source. When publication and later execution use different supported
envelopes, each is independently verified under its recorded authority while
the publication identity remains unchanged.

Development evidence for this version uses `generated_build` sources for
`artifact` and `build_log`. The build-log receipt anchors the final selected-case
evaluation; the complete cohort digest binds all selected acceptance cases.
It does not invent an aggregate validation event. `instrumentation` uses a
`generated_execution` source with the exact Work ID and step of a later
`run_python_specialist` result. Forge cases alone do not establish that run.

All three records must belong to the same publication, contract, runtime and
acceptance cohort. They can support entry into Stabilization, where further
quality work is required. They do not establish stability scores, deployment,
revenue, unseen-input correctness, or the later Maturation gate. A denied gate
remains recorded without advancing the concept.

Local regression checks use temporary journals and synthetic execution results:

```powershell
.\.desktop-python\Scripts\python.exe -B -m unittest discover -s tests -p test_generated_evidence_v*.py -v
.\.desktop-python\Scripts\python.exe -B -m unittest discover -s tests -p test_generated_concepts.py -v
```

The user-visible smoke entry remains `npm run test:specialists-generated`.
It checks generated-library discovery, reuse, and retained concept evidence in
the real Desktop. It requires an already-running admitted execution resource
and explicit `YUR_RUN_EXECUTION_CELL_TESTS=1`; local synthetic regression passes
do not substitute for that native execution check.

### Contract helpers

```python
checked = validate_contract(document)       # returns a detached copy
digest = contract_digest(checked)            # full contract, including cases
generation_context = public_contract(checked)  # never includes cases
payload = validate_input(checked, value)     # returns a detached copy
actual = validate_output(checked, result)    # returns a detached copy
matched = outputs_equal(actual, expected)
```

`examples/quantity-rollup.specialist.json` contains five manually authored
arithmetic cases: empty input, duplicate grouping, unit separation and ordering,
zero preservation, and summing maximum line values. It groups explicit integer
quantities by `(code, unit)`. It does not interpret drawings, estimate missing
quantities, convert units or make pricing decisions. Its expected sums were
authored for this example; no donor algorithm is claimed. This file is a contract
and does not itself contain a generated or qualified worker implementation.

Run the contract checks with:

```powershell
.\.desktop-python\Scripts\python.exe -B -m unittest discover -s tests -p test_generated_contracts.py -v
```

## Relationship to existing generators

The read-only donor assessment examined
`<yur-ai-core>/agent_pack_bundler/README.md`, `agent-pack.schema.json`,
`yur_agent_pack_generator.py`, `yur_industry_pack.py` and `yur_pack.py`.
Their registry selection, industry roles, instruction templates and session
descriptors are useful specialization context. They do not synthesize new domain
worker implementations or provide independent executable outcome fixtures.

The main generator's `make_pack` (line 804) combines fixed roles with scored
registry metadata. `build_interactive_extension_js` (line 1062) emits a chat
extension whose Captain request sends an agent name and message. `validate_pack`
(line 904) checks metadata and instruction-file presence. Its `source_fingerprint`
(line 664) hashes a source-reference string, not referenced source bytes. The
standalone schema file is not consumed by the three inspected generators and
does not describe all fields emitted by the newer generator.

Donor file SHA-256 at inspection:

| File | SHA-256 |
| --- | --- |
| `yur_agent_pack_generator.py` | `5dcc3d537985580783d07c73cbe62ff973ef9372cf45bf2c07a2cf8151d42c71` |
| `yur_industry_pack.py` | `f2001e3aa1c47d00598e37290bf6afc26e011467586997118dddc603bd9e518a` |
| `yur_pack.py` | `3175f19a9193bd1f3b05a4f7e01234f68f717598a7a8af6b0247879a64d06d53` |

The local `ouroboros/producer.py` provides the reusable untrusted `ProduceResult`
file envelope. Its scaffold emits a `describe()` stub; its HTTP producer acquires
source from another service. Associated structural/AST checks do not establish
domain outcomes. No alternate pipeline or ledger authority is inherited.

The current `foundry/pack_compiler.py` produces real executable packages from
already admitted handlers and verifies their exact trusted runtime revisions.
Generated Python workers need a separate contained artifact and admission path;
their code must never be imported into the trusted host runtime merely because
a digest or an acceptance result exists. Existing package reconstruction and
historical runtime compatibility remain separate guarantees.
