# Hermes skills in YUR AI Desktop

YUR AI Desktop carries a versioned snapshot of the complete local Hermes skill
set at `integrations/hermes_skills/v1`. The admitted snapshot combines the 75
installed active skills with the 102 non-overlapping optional skills from
`hermes-agent` 0.18.2. Its catalog records 177 skills, 774 skill support files,
27 package documentation files, and 978 total source assets with 12,818,365
admitted bytes.

The snapshot ID is
`659bf95db24b6e8407f1c5c674fdf548b300b037a70c6769c278dff26699ea39`.
Every file has an admitted SHA-256, upstream SHA-256, source lane, byte count,
role and execution status. Each skill retains its declared version, author,
license, platforms, dependencies, tags and prerequisites when present. Hermes'
MIT license is retained as `LICENSE.hermes`.

## Desktop use

Open **Agents** or **Capabilities**, expand **Explore libraries**, and choose
**Hermes skills**. Search uses the skill name, description, category, tags and
path. The filter separates the installed active library from the package's
optional library. Open a result to inspect its version, instruction size,
support-file count, support byte count and support-manifest hash. **Use in
conversation** attaches the exact skill version to the current conversation.

At send time, the main process reacquires the selected skill from the fixed YUR
snapshot. It verifies the instruction hash and every support-file hash before
the instruction body reaches the selected model. Conversation evidence retains
the snapshot identity, selected instruction hash, support-manifest hash,
verified support counts and acquisition provenance. Raw instruction and support
file bodies are not written to the conversation journal.

## Admission and authority

The import reads every directory containing `SKILL.md` and every non-hidden
package-level documentation or metadata file. Hidden folders and
files, curator backups, hub state, usage state, generated index cache, database
files, private-key formats and reparse points are outside the snapshot. Sixty-nine
source files contained 222 credential-shaped examples. Those matched values
were replaced with `[REDACTED_CREDENTIAL_LIKE_VALUE]`; the catalog records each
redaction and preserves separate upstream and admitted hashes. No source asset
was silently dropped.

Hermes skills provide selected instructions and inert supporting evidence.
They do not own orchestration, execution, validation, commit, provenance,
governance, provider selection or durable state. Foundry and the single
`OrchestrationManager` retain coordination authority. Validation remains
separate from Commit Service, and durable mutations still pass through Commit
Service. Selecting a skill grants no shell, filesystem, network, model, MCP,
browser, desktop-control or credential permission.

Support scripts, templates, schemas, PDFs and reference files are present and
hash-addressed. They are not imported as Python modules or executed. A skill
that names Playwright, Puppeteer, Camoufox, FastMCP, a provider, a CLI or an
environment variable still needs a separately admitted YUR capability and a
live runtime check before Desktop can claim that prerequisite works.

## Refreshing the snapshot

From `studio-electron`, run:

```powershell
python scripts/import_hermes_skills.py --replace
```

The importer resolves its default source paths from `%LOCALAPPDATA%`, validates
the upstream `hermes-agent` package identity and MIT license, applies the same
exclusions and redactions, writes a fresh manifest, and computes a new snapshot
ID. Review the catalog and tests before accepting a refreshed version.

Verification commands:

```powershell
python -B -m unittest discover -s tests -p test_hermes_library.py -v
npm run test:desktop
npm run test:hermes
```
