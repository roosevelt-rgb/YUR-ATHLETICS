# Operator preparation of the execution runtime

Settings provides an explicit preparation workflow backed by the existing
OrchestrationManager and CommitService. Native receipts record the resource and
cleanup observed during each acceptance run; this document describes behavior.

The generated-worker checkpoint demonstrated a complete live-model build and
reuse, but it required explicit development preparation outside the desktop.
The Settings connection indicators concern model providers. Execution runtime
readiness is displayed separately.

## Operator workflow

Settings has an **Execution runtime** card. **Check** acquires installed and
running resource metadata and verifies the selected running resource against the
existing reviewed fingerprints. A timeout leaves status unknown. An installed,
stopped resource cannot be described as verified before preparation.

**Prepare** is an explicit operator action for the exact checked resource. It
starts or reuses that resource, holds one passive process for at most fifteen
minutes, and reports verified identity, expiry and its committed setup receipt.
It performs no installation. **Release** closes only the owned preparation
process; it does not terminate the distribution or unrelated work.

The `YUR_EXECUTION_DISTRO` environment override remains visible and authoritative
for selection. Otherwise, the operator's selected `execution_distro` preference
is forwarded to Work. A preference selects a resource; it does not authorize its
startup. The resource displayed in Settings and the resource used by subsequent
execution must match.

Execution failures can link to this Settings card. Opening it does not start a
resource or retry a mission. Work and Code do not prepare runtimes automatically.
Other Work tools remain available when a cell runtime is not ready.

## Existing authority and resource boundaries

The existing OrchestrationManager delegates preparation to a narrow adapter.
CommitService records setup acceptance, transitions and terminal evidence in a
separate operational record. Work, conversation, Concept and execution-cell
clocks and authority objects remain unchanged.

The setup record uses exact revisions, operation identity and a bounded active
lease. It must not hold the Work worker lock while the passive process waits.
Validation precedes the ready commit. A receipt about an earlier check is not a
substitute for current resource verification.

Check and Prepare share a fixed, bounded desktop-owned pipe protocol. A
short-lived token lives only in that session and is bound to its exact checked
selection. Only its digest belongs in persistent evidence. Prepare rechecks
selection before committing acceptance and launching fixed arguments. The
renderer and model supply no shell text, scripts, process IDs or authority.

Lost acknowledgment resolves the same operation ID. It never authorizes another
startup. EOF, explicit release and deadline clean up only the actual owned
process. An unconfirmed exit remains uncertain; a stored PID or elapsed expiry
alone is not evidence that a process was killed.

## Required acceptance

- Installed, stopped, verified, unavailable and timeout states remain distinct.
- Exact selection, environment override and check-token changes cannot silently
  redirect preparation or subsequent Work.
- Duplicate requests, interrupted acknowledgments and reload preserve committed
  setup identity without another startup.
- Existing Work and Concept history survives the additive schema migration.
- Native Settings performs Check, explicit Prepare, one actual Code cell using
  the displayed resource, Release, and receipt inspection after reopening.
- Unknown senders, arbitrary commands, installation and distribution shutdown
  remain unavailable through this interface.

Synthetic process tests, actual native preparation and live-model outcomes must
be labeled separately. The prior verified source checkpoint remains preserved
under `release/yur-specialist-factory-0.2.0-1ea12d981f08cc38-source.zip`.

## Validation and remaining limits

The first native run passed four groups with two fixture model responses and one
actual contained compile. Ubuntu-24.04 was already running at Check. Its setup
reached ready revision 3, then released revision 5 with confirmed owned-process
exit. Renderer reload, another explicit Check, and normal desktop shutdown
preserved the same setup receipt. This proves the observed running-resource
path; it does not establish a stopped-resource startup on that run.

The final native evidence is recorded separately in
`execution-runtime-native-verified.json` and its copied artifacts. The default
regression receipt is `desktop-verification-execution-runtime-verified-final.json`.
These filenames identify intended receipt locations; their recorded pass/fail
outcomes and source hashes determine the evidence, not this document.

The final native run passed in 5.486 seconds with four groups, two fixture model
responses and one actual cell. Its setup operation was
`<setup-operation-id>`; Work was
`<work-id>`. The released receipt was
`ed11ad888a29512570ba0d003f6ca7d0cc885cccf4f874b2c693ba996cab46dc`.
Normal shutdown was observed, and a separate inspect-only process confirmed
the same released record and owned-process exit afterward. Monitored source
was unchanged, with zero renderer errors or external browser requests. The
final UI also distinguishes a fresh Check from retained historical setup facts.

`execution-runtime-native-failure-cleanup.json` separately verifies an
intentional fixture-handler failure while a real hold was active. The native
mission failed as intended, with one fixture request and no Code cell. Normal
desktop shutdown released the hold, and post-shutdown inspection confirmed
its terminal receipt. This is cleanup evidence, not a successful mission.

The earlier full regression in `desktop-verification-execution-runtime-final.json`
retains two migration-fixture errors: the simulated schema-1 and schema-4
databases still contained new setup tables. The corrected fixtures remove
those tables when constructing historical schemas. Production migration
behavior was unchanged by that correction.

Metadata parsing supports the bounded English WSL list format. Unsupported
formats and timeouts remain unknown. Running-state acquisition and the existing
WSL verification invocation are separate OS operations; a concurrent external
distribution stop can race them. This pass does not prove an atomic OS-level
"execute only if still running" guarantee.

A crashed owner's retained active lease remains inspectable and is never
silently cleared from an elapsed deadline or stored process identifier. A
different session cannot release that owner's process. Orphan reconciliation
remains an explicit gap. Runtime preparation records are currently bounded to
200 operations and 16 events each; indefinite operational history and retention
management are not established by this implementation.

The native fixture does not use a live model, install a runtime, validate a
portable binary, or claim general specialist reliability. Existing generated
worker live-model evidence remains in its earlier source-bound checkpoint.
