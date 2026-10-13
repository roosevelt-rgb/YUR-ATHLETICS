# YUR Workforce in Desktop

The operator-supplied source is `<unified-root>\agents\workforce`.
`YUR_WORKFORCE_SOURCE` relocates this read-only source; the main process fixes the
root and the model cannot replace it. The live catalog contains 23 profiles:
20 original workforce roles plus HATCH Scope, Quantity and Cost. The source README
still describes 20. No donor files are changed or imported by the Desktop.

## Use

Open **Agents → YUR Workforce**, search the source profiles, and open an agent.
**Genome, signals and source details** retains identity, lineage, affinities,
receptors, cytokines, declared actions, dependencies and lifecycle fields.
**Use in conversation** selects that source profile. Each submitted message
reacquires the complete selected file with its original hash and includes it with
the chosen model's context. Selection and source evidence survive conversation
reload; removing the Agent chip excludes it from subsequent messages. Copilot
instructions and a repository selection can be used in the same conversation.

## Executable HATCH Quantity

Open **HATCH Quantity (Survey)** and use **Run quantity survey** with plans and/or
specification text. The typed `workforce.hatch.quantity` worker recognizes stated
quantity tokens and associates them with nearby CSI headings. It retains exact
field/line/character source references. It does not measure drawings, discover
missing scope, or assume prices. Totals cover the returned positive finite items;
exclusions and the 1,000-item extraction ceiling are reported. Each input field is
limited to 30,000 characters and the combined execution payload to 64 KiB.

The reviewed donor `_survey` behavior was reconciled into the existing
`specialists.py` runtime. Original source/function hashes and the changes made
are recorded in [quantity provenance](workforce-quantity-provenance.json). The
bound source revision is checked again before execution. Both packaging strategies
share this deterministic extraction algorithm; no quality difference is claimed.

The existing OrchestrationManager submits and processes only the selected HATCH
mission, independently validates its candidate packages and commits its artifact.
Only then does it run the bounded worker. CommitService stores execution receipts
and the full result in `workforce.result.committed`; the conversation stores a
compact result reference. **Work details → Read complete quantity result** retrieves
the original committed output after restart. A matching request UUID replays the
same committed result; reusing it with changed input is rejected. Unrelated queued
missions are not processed or recovered by a quantity request.

Results appear as a quantity table, with receipts under **Execution evidence**.
If the response is interrupted, run again with the same text to recover the saved
request and its original result. The pending request survives conversation reload.
Each new request has its own mission, so a failed or cancelled prior mission does
not prevent a new survey. Request identity stays stable across runtime updates.
The input hash is bound before work begins, and the execution completion event
stores the full output atomically; recovery can rebuild a missing result link
without running a completed worker again.

## Authority and source fidelity

Other source profiles remain usable as model context, with unbound actions labeled
as source declarations. They have not been promoted into executable capabilities.
Several source actions are only proposals or stubs: Constructor's deployment
metadata creates no bundle; Herald's queued result sends no email; Oracle's
consultation sentence is not a reasoning engine; Phoenix's clone identifier does
not construct a clone instance. Profiles retain their original source content so
these differences remain inspectable.

The donor `Workforce.boot`, Puppetmaster, Genome authority and ecosystem imports
are not adopted. The source dispatcher allows `ABSTAIN` to reach handlers and
self-approves caller-supplied lifecycle actions; ecosystem imports can create
state outside CommitService. Its Pheromone digest excludes `prev_hash`. The
Desktop uses its existing authority, validation, commit and provenance services
instead. Legacy lifecycle declarations remain distinct from mission and Concept
Lifecycle clocks.

## Verification

`npm test` covers static profile extraction without donor imports, changed-source
rejection, bounded contracts, fixed quantity outcomes, malformed/negative/overflow
quantities, deduplication, source spans, truncation totals, real mission commit and
standalone exported-agent execution. `npm run test:workforce` uses the actual
Electron UI, preload, main process, Python catalog, OrchestrationManager and
CommitService with isolated temporary state. Its portable donor fixture contains
the exact reviewed HATCH source and import tripwires. The model fixture answers
only when source profile content arrives; quantity results use the actual local
worker, with no model fixture involved.

Native checks cover same-shell navigation, profile selection and reload, actual
125 CY / 1,200 SF extraction with source references, artifact and result receipts,
request replay/conflict, preserved unrelated queue, unbound/source-changed denials,
and trusted root/authority boundaries.
