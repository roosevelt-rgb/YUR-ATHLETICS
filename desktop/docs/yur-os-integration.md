# yur-os source registration

The Desktop registers `yur-os` as an independent, optional, read-only source. It
does not import its Python client, start its Rust service, execute its Wasm
components, consume its keys, or adopt its ledger or agent lifecycle as Desktop
authority. The existing OrchestrationManager and CommitService remain the
execution and persistence boundaries.

## Configuration and public contract

`SourceRegistry(ecosystem_root, yur_os_root=None)` preserves the original
one-argument constructor and `.root` catalog property. Configure each root
independently:

| Logical root | Environment override | Local configuration field |
| --- | --- | --- |
| Existing YUR ecosystem | `YUR_ECOSYSTEM_ROOT` | `ecosystem_root` |
| yur-os source | `YUR_OS_ROOT` | `yur_os_root` |

The existing ignored `studio-electron/.factory-sources.local.json` is a bounded
4,096-byte JSON object. A nonempty environment value wins for its own field;
empty environment values retain the existing local configuration fallback.
Absent, null, or empty configured roots are disabled. Non-string, blank,
NUL-containing, overlong, file, and reparse-point roots are rejected. Missing
directories are reported as unavailable and never created. Relative paths retain
the existing resolution against the process working directory; use absolute
paths for stable operator configuration.

For the user-selected donor, add `"yur_os_root": "<yur-os-root>"` to that local
object while preserving its existing `ecosystem_root`. The absolute donor path
is operator configuration, not a production default. Both nonempty environment
overrides avoid reading unused local configuration.

The existing `sources` command continues to call
`SourceRegistry.from_environment().describe(query, limit)`. Both direct CLI
`sources` and RPC `sources` now use the early acquisition lane before a
CommitService or OrchestrationManager is constructed. With only `yur-os`
configured, it returns one `sources` record and an empty ecosystem catalog. With
neither root, `configured` is false and both source/catalog lists are empty.
`search_catalog` also returns `([], 0)` when the ecosystem root is absent.
Catalog discovery excludes an entry if any returned metadata field contains
credential-like text or control characters, or exceeds its field limit. Safe
entries remain available. Limits are 256 characters for `entry_id`, 500 for
`name`, 100 for `kind`, 200 for `provider`, 300 for `industry`, 1,000 for
`workflow`, and 4,096 for `path`. Returned catalog paths remain untrusted
metadata and are never followed.

The `yur-os` record has `mode: "read-only"`, `classification: "source-only"`,
`execution_admitted: false`, and `runtime_verified: false`. Every available file
has its relative path, actual byte count, and SHA-256. `available` means all
selected source files were readable within the acquisition budget; it does not
mean that dependencies, runtime health, or domain outcomes have been verified.
An unavailable file has no invented hash. Discovery reports total accepted
bytes and its fixed limits.

## Selected source context

`source_acquire` accepts exactly `source_id`, `relative_path`, and
`expected_sha256` over the existing factory RPC. The caller cannot supply a
root, authority override, arbitrary path, or execution flag. Source/file pairs
must occur in the fixed registry; metadata paths inside the ecosystem catalog
do not become valid acquisition paths. The matching 64-character lowercase
SHA-256 must come from a fresh source selection.

`SourceRegistry.acquire(...)` rereads at most 128 KiB for any registered source,
checks the entire raw-file hash, decodes strict UTF-8, rejects binary controls,
and scans the entire decoded file with the repository reader's existing secret
detector. A secret-bearing tail outside the eventual excerpt also rejects the
whole acquisition. Errors return no source text. A changed file requires the
operator to refresh its source evidence.

Successful results use this structure:

```text
schema: yur.source-acquisition.v1
context_only: true
execution_admitted: false
content: first at most 16,000 decoded characters, at most 64 KiB UTF-8
evidence:
  schema: yur.source-evidence.v1
  source_id, root, relative_path
  sha256, bytes                    # entire original raw file
  acquired_at                     # UTC ISO timestamp
  truncated
  excerpt_characters, excerpt_bytes, excerpt_sha256
  context_only: true
  execution_admitted: false
  selection_reason
  limits: {file_bytes: 131072, excerpt_characters: 16000, excerpt_bytes: 65536}
```

`evidence` contains metadata only; the content is separate for task-specific
context compilation. Whole-file and excerpt hashes are distinct when truncated.
For an ecosystem source, `root` is that registered source's fixed subdirectory,
consistent with its discovery record. For `yur-os`, it is its independent
configured root. Source text remains untrusted reference material and cannot
grant capabilities or alter execution authority. The UI must preserve that
boundary when compiling it into a conversation.

This command also runs before journal initialization. It does not save context,
modify donor files, import donor modules, launch a service, or mutate mission
state. Conversation persistence, when requested by the UI, remains a separate
existing CommitService operation.

## Fixed acquisition boundary

Only these 15 relative files are acquired. The per-file limit is 128 KiB and
the aggregate accepted-content limit is 512 KiB. Discovery returns file hashes,
not content; explicit acquisition can return the bounded selected excerpt above.
Files referenced by manifests are never
followed, and no directory enumeration occurs.

```text
__SPINE_NODE__.json
README.md
Cargo.toml
rust-toolchain.toml
proto/spine.proto
yur-types/src/constitution.rs
yur-substrate/src/main.rs
yur-substrate/src/grpc.rs
yur-substrate/src/wasm_jit.rs
yur-substrate/src/rbac.rs
yur-substrate/src/interceptor.rs
yur-cortex-py/client.py
yur-cortex-py/pyproject.toml
yur-cortex-py/tests/test_smoke_round_trip.py
yur-intern/src/lib.rs
```

The shared checked-file reader rejects traversal, reparse points in ancestors
or descendants, nonregular files, changed file identity, and oversized reads.
Runtime `data/`, `target/`, caches, generated protobuf bindings, databases,
credentials, and unrelated files are outside this allowlist.

## Reviewed donor behavior and provenance

Read-only review on 2026-09-12 covered the user-selected `<yur-os-root>` working
tree. Git HEAD was
`bf9a2d2f204c4b8f08098012945b3833b191634b` (`debt bookkeeping: reconcile stale OPEN
rows against closure logs`). The README was modified and `__SPINE_NODE__.json`
was untracked, so HEAD alone does not identify every acquired byte. Current
source hashes are the evidence for this registration.

| Reviewed source | SHA-256 |
| --- | --- |
| `proto/spine.proto` | `d1a3470a62272559d54081d44ca2a5931152b388a2af93a8a5c0ca713c5d5eca` |
| `yur-types/src/constitution.rs` | `99f6e56d42a4495a7a2329040061ab71272a9aafaa5f674de5b295e46df2eff2d` |
| `yur-substrate/src/grpc.rs` | `f710a19762ced6ca610ea690ff7863fe190743149fdfb7d5be6419ff127905ea` |
| `yur-cortex-py/client.py` | `2388ba548ed59aaf8bafa48c8c4050974529604b1d7255ecd1d9aaab300499a3` |

The declared deterministic Rust Spine / probabilistic Python Cortex boundary
has substantive implementation behind it:

- `proto/spine.proto` defines 24 RPCs covering agent/component lifecycle, graph
  acquisition and mutation, ledger/attestation, user branches, agent snapshots
  and rewrites, and economic operations. Trace IDs are 16 bytes; node IDs are
  32 bytes; SHA-384 fields are 48 bytes; semantic vectors contain 1,536 little
  endian float32 values. These contracts are distinct from Desktop mission IDs,
  SHA-256 provenance, and its eight-stage Concept Lifecycle.
- `yur-types/src/constitution.rs:136` evaluates six typed constitutional rules.
  These include trunk immutability and a HardLock policy allowlist. They are
  executable structural guards, not evidence of semantic truth or external
  certification. The README's dormant-rule and state-placeholder descriptions
  lag the reviewed implementation.
- `yur-substrate/src/grpc.rs:120` authenticates and verifies agent spawn,
  retrieves and compiles the content-addressed Wasm component, appends to the
  donor ledger, and updates its registry. `wasm_jit.rs:68` verifies source bytes
  and compiles a Wasmtime component. The reviewed source does not establish a
  Store/Linker instantiation and invocation path. Storing memory/fuel settings
  with a compiled component is not proof of bounded guest execution.
- `grpc.rs:807` exposes bounded-depth graph queries with deeper QueryGraph
  traversal still unsupported. `grpc.rs:896` implements HydrateWave traversal
  with edge weight, cosine similarity, attenuation, and first-visit behavior;
  its depth bound is not a total-node or output-byte bound. `grpc.rs:1643`
  implements nonce-bound Ed25519 attestation of ledger height and tail.
  `grpc.rs:1701` returns raw bincode ledger bytes for a requested index.
- `grpc.rs:2129` checks a proposed agent snapshot against graph components;
  `grpc.rs:2333` admits a changed compiled component only after the required
  snapshot. These are donor agent/component transition mechanisms, not the
  Desktop's long-horizon Concept Lifecycle. Their ledger writes and registry
  authority are not promoted by source registration.

The interceptor and RBAC table implement CAT authentication/replay checks and
per-RPC roles; attestation is the explicitly anonymous read. The broad Python
client implements RPC wrappers but uses an insecure gRPC channel, has no
per-call deadlines, and can initialize signing resources. It is not a suitable
directly imported Desktop read-only adapter. Its manifest requires Python
3.12, whereas the inspected Desktop runtime was Python 3.14.7; `grpcio`,
`protobuf`, `cryptography`, and `pqcrypto` were not installed in that Desktop
runtime at review time. No dependencies were installed.

Source tests cover Wasm compilation/CAS tampering, constitutional rule cases,
RBAC, and a Python smoke round trip. The smoke fixture boots its own service
and temporary ledger on Linux/WSL, can skip when the binary is unavailable, and
enables a graceful-degrade mode. These donor tests were read, not executed.
No service health, boot, cryptographic peer identity, or real Wasm invocation
is claimed by this integration. Boot is consequential: `main.rs:47` opens the
donor ledger through `SpineState::new`, with initialization/recovery and key
handling, so registration never launches it.

## Smallest separate executable seam

A future adapter can acquire `GetAttestationReport` from an explicitly resolved,
already running local Spine under read-only acquisition authority. It should
mint a fresh 32-byte nonce and 16-byte trace ID, enforce a deadline and response
budget, validate all lengths, and verify Ed25519 over the returned
nonce/height/tail payload. The returned boot key is not independently trusted
merely because its signature verifies; peer-key enrollment and trust status
must remain explicit. A remote report is evidence about that peer, not a
Desktop commit receipt or hardware-enclave proof.

That adapter would supply acquired facts to the existing environment/context
and capability boundary, with results committed through the current OM and
CommitService. It must not initialize a signing client, exercise mutation RPCs,
or start a second coordinator. Reader-authorized graph acquisition could
follow separately after total-node/output bounds and credential resolution are
defined. Neither adapter is implemented or admitted in this source-only change.

## Verification

From `studio-electron`, the focused tests are:

```powershell
& '.\.desktop-python\Scripts\python.exe' -B -m unittest discover -s tests -p test_source*.py -v
& '.\.desktop-python\Scripts\python.exe' -B -m unittest discover -s tests -p test_factory.py -v
```

They cover old catalog compatibility, independent roots, per-field environment
precedence, invalid configuration, absent roots, exact allowlisted acquisition,
fresh content hashes, reparse/traversal refusal, and byte budgets. Acquisition
tests verify full-file secret checks before truncation, UTF-8/binary refusal,
separate metadata, arbitrary-root/authority refusal, and real CLI success/error
paths without creating a state directory. The source suites passed 32 tests;
the existing factory regression passed 10 tests. Discovery tests additionally
confirm synthetic credential canaries never enter metadata responses while
safe catalog entries remain available. Test fixtures contain source
text and excluded-file canaries; no donor code is executed.

After the operator config is bound, this read-only command emits current source
hash evidence without initializing a journal or importing the donor:

```powershell
& '.\.desktop-python\Scripts\python.exe' -B -c 'import json; from foundry.sources import SourceRegistry; print(json.dumps(SourceRegistry.from_environment().describe(), indent=2))'
```

The command records observed source availability; it does not upgrade the
explicit `execution_admitted: false` status.
