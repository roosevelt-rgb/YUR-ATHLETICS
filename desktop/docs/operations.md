# Operating the local factory

## Queue, retry and intervention

- Submissions require an explicit idempotency key. Reuse it on transport retries.
- Processing owns a cross-process OS lock. Other workers refuse concurrent sweeps.
- SQLite transactions bind each mission snapshot and event hash. Publication
  commits artifact contents, completion and provenance atomically.
- After a process interruption, the next worker may retry running/validating
  work under the lock. Three attempts is the ceiling. Failed/cancelled missions
  require a new explicitly keyed submission.
- Cancellation uses compare-and-swap state transitions. A cancelled mission
  cannot publish afterward. Completed packages cannot be cancelled retroactively.
- Continuous processing uses the same manager with an explicit cycle budget.
  Ending the worker leaves queued work durable for a later worker.
- The desktop automatic queue is a main-process cadence timer. It stops on errors,
  budget exhaustion or window closure. Stop lets an active bounded pass finish
  and prevents subsequent passes. Cadence settings are intentionally session-only;
  reopening the desktop does not silently resume an expired operator session.

## Artifacts and execution

The database file mapping is authoritative. Export ZIPs are derived caches under
the factory state's `exports` directory. Existing exports are verified before
reuse. An interrupted export can leave a valid cache without a receipt; retry
verifies bytes and appends the receipt. Modified exports are refused.

Run inputs and outputs are represented in provenance by hashes, not copied
payloads. The UI receives the full output for the requested operation. Mission
names/descriptions are durable user input; avoid including secrets in them.

Generated handlers have no network or durable side effects; rollback of a run
does not require reversing outside state. Artifact publication is immutable;
corrections should create a new mission and artifact. No generic destructive
delete or database-edit API is provided.

## Recovery and backups

If integrity verification fails, the service refuses reads and mutations. Stop
workers and preserve the affected state for investigation. Do not edit hashes or
force completion to make health green. Restore an independently verified backup
of the whole state directory while all writers are stopped. A copied database
with an active WAL may be incomplete; a live backup must use SQLite's backup API
or a consistent filesystem snapshot. Automated backups/restores are not included.

Retain the source release matching exported packages. Validation reconstructs
the current trusted compiler output; changing compiler/runtime source can make
older committed packages require a matching source release or a new validated
build. Multi-version validator admission is a remaining upgrade requirement.

## Security boundary

The factory runs as the current OS user. It does not claim tenant isolation,
cryptographic delegation, encrypted operational data, hardware-key signing, or
tamper-proof storage against a user who can rewrite the whole state directory.
Its desktop window loads local resources only and exposes narrow JSON RPC.

The legacy IDE is an intentional broader-authority tool with file editing,
terminal and code execution. Its remote editor dependencies and historical
write paths remain release-review items. Keep sensitive work in a governed
runtime appropriate to its authority requirements.
