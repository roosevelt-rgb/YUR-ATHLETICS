# Portable desktop candidate

The local assembler creates a Windows x64 folder and a sibling ZIP containing
Electron, the allowlisted Desktop application, production Node dependencies,
and embedded Python with PDF/image intake dependencies. It reads reviewed local
inputs; it does not download, install, launch, or execute dependency code.

**Assembly and runtime-verification code is implemented. Each candidate requires
matching distribution and native acceptance receipts to establish operation
without host Node or Python. This guide does not certify any build.** The output
is an unsigned local candidate, not a signed installer or enterprise-readiness
certification.

## Reviewed inputs

Run the assembler on a build host with Python available. This build prerequisite
is separate from the intended absence of a host-Python requirement at runtime.
The input contract is
[`scripts/desktop_distribution_contract.py`](../scripts/desktop_distribution_contract.py).
It currently admits these inputs:

| Input | Required source and pin |
| --- | --- |
| Electron | Local `electron-v44.3.0-win32-x64.zip`, with the exact publisher URL and SHA-256 pinned in the contract |
| Python | Local `python-3.14.7-embed-amd64.zip`, with the pinned publisher URL, byte count, and SHA-256 |
| Python wheels | Local `pypdf==5.9.0` and `Pillow==12.1.0` wheels, with reviewed filenames, versions, platform tags, byte counts, SHA-256 values, and `files.pythonhosted.org` URLs |
| Node dependencies | An installed `node_modules` tree whose production dependency closure matches this application's `package.json` and `package-lock.json`; pin the assembler's complete inventory digest |

Wheel contents, metadata, compatibility tags, and `RECORD` hashes are checked.
The assembler copies their payload directly into embedded Python; it does not
run pip, wheel entry points, npm lifecycle scripts, or native rebuilds. Installed
native Node binaries remain observed artifacts with hashes and upstream package
provenance. Their inventory does not establish a reproducible upstream build or
successful Electron ABI loading; native acceptance must establish that separately.

From the `studio-electron` directory, first inspect the production Node inventory:

```powershell
$appRoot = (Get-Location).Path
$nodeRoot = Join-Path $appRoot 'node_modules'
python -B scripts/package_desktop.py --app-root "$appRoot" inventory-node --node-root "$nodeRoot"
```

Review the returned package/file inventory. Use its top-level `sha256` value as
`node.inventory_sha256`; this is the canonical inventory digest, not the hash of
a formatted JSON file. The inventory visits the lockfile's production dependency
closure rather than copying every installed package.

Prepare a UTF-8 JSON input document with exactly these fields. Values in angle
brackets below are placeholders to replace with reviewed facts, not usable pins:

```json
{
  "schema": "yur.desktop-distribution-inputs.v1",
  "electron": {
    "path": "<absolute local Electron archive path>",
    "bytes": 1,
    "sha256": "<exact pinned archive SHA-256>",
    "source_url": "<exact pinned publisher URL>"
  },
  "python": {
    "path": "<absolute local embedded Python archive path>",
    "bytes": 1,
    "sha256": "<exact pinned archive SHA-256>",
    "source_url": "<exact pinned publisher URL>"
  },
  "wheels": [
    {
      "path": "<absolute local wheel path>",
      "bytes": 1,
      "sha256": "<reviewed wheel SHA-256>",
      "source_url": "<exact files.pythonhosted.org wheel URL>",
      "filename": "<wheel filename>",
      "name": "pypdf",
      "version": "5.9.0",
      "tags": ["<actual wheel compatibility tag>"]
    },
    {
      "path": "<absolute local wheel path>",
      "bytes": 1,
      "sha256": "<reviewed wheel SHA-256>",
      "source_url": "<exact files.pythonhosted.org wheel URL>",
      "filename": "<wheel filename>",
      "name": "pillow",
      "version": "12.1.0",
      "tags": ["<actual wheel compatibility tag>"]
    }
  ],
  "node": {
    "root": "<absolute installed node_modules path>",
    "inventory_sha256": "<reviewed inventory sha256 field>"
  }
}
```

Replace every placeholder and example byte count. Local input paths stay outside
the application source and do not authorize downloading from the recorded URLs.
The current validator admits only the two base wheels above; optional voice
dependencies cannot be added by simply inserting unreviewed wheel entries.

Then assemble into a **new** folder beneath an existing parent:

```powershell
python -B scripts/package_desktop.py --app-root "$appRoot" build --inputs "D:\local-package-inputs\reviewed-inputs.json" --output "D:\local-releases\YUR Desktop candidate"
```

Both the output folder and its sibling `YUR Desktop candidate.zip` must be absent.
An existing release is never overwritten. A failure can leave a partial new
folder for inspection. The command returns the output/ZIP paths, ZIP SHA-256,
attestation SHA-256, file count, and `signed: false` after completing its checks.
The ZIP uses sorted paths, fixed timestamps, and stored entries; deterministic
packaging requires the same complete source and input bytes.

## Output and source boundary

```text
YUR Desktop candidate/
  electron.exe
  Start YUR AI Desktop.cmd
  DISTRIBUTION_ATTESTATION.json
  resources/
    app/
      package.json
      .desktop-distribution.json
      src/  foundry/  ...allowlisted source...
      node_modules/  ...reviewed production dependencies...
    python/
      python.exe
      python314.dll
      python314.zip
      python314._pth
      runtime.json
      Lib/site-packages/
```

Use the **top-level** `Start YUR AI Desktop.cmd`. It clears `ELECTRON_RUN_AS_NODE`
for the launch and starts the adjacent Electron. The source-checkout launcher
inside `resources/app` is a different, retained source artifact.

Application files come only from
[`scripts/source-files.json`](../scripts/source-files.json), using the existing
source packager's checks. The assembler separately acquires the pinned runtimes,
wheels, and reviewed production Node files. It excludes source-tree Python
environments, model directories, credentials, caches, and machine state. It
rejects reparse paths, unsafe archive paths, aliases, collisions, unexpected
output files, and changed source/dependency inventories during assembly.

`DISTRIBUTION_ATTESTATION.json` records the source allowlist/file hashes, npm lock
hash, Node inventory and native-artifact provenance, runtime archives, wheels,
license/notice paths, and output file inventory. Its output inventory excludes
the attestation itself; the command reports that file's hash separately.
`signed` remains false, `release_status` is `local-unsigned-candidate`, and
`first_party_license` remains `unset`. These records describe bytes and their
provenance; they do not authenticate a publisher signature or grant execution
authority to a pack.

The generated `.desktop-distribution.json` binds `../python` to the exact
`runtime.json` hash. With no explicit `YUR_FACTORY_PYTHON` override,
`desktopPython()` verifies that sibling runtime's manifest, complete payload
inventory, and current hashes before returning its executable. Packaged runtime
corruption fails instead of falling back to checkout or PATH Python. An explicit
host override remains supported and must be cleared when testing portability.
The controlled `python314._pth` includes the bundled standard library,
site-packages, and `../app`, without site initialization. Use `-B` for Python
probes; unlisted bytecode caches would change the verified payload.

## Resources that remain separate

Model providers, selected repositories, and the reviewed WSL2 execution runtime
remain external. This assembler does not start or install them. Chat/Work needs
the configured provider; bounded Python cells still require the existing
verified execution runtime and its explicit preparation flow. The terminal also
uses an available Windows shell through the bundled native Node dependency.

Terminal startup resolves the selected admitted shell to a verified absolute
executable from Windows PATH or the modeled system directory. It includes the
final PATH entry and does not search implicit current-directory entries. This
avoids the bundled node-pty resolver's omission of the final PATH directory;
the portable fixture retains a minimal PATH with PowerShell in that position.

Voice recognition model files are external. The current wheel admission set does
not include Vosk or its dependency closure, so the attestation reports
`voice-python-dependencies` under `resources.missing_optional`. Assembling the
base candidate does not establish offline dictation availability. Platform
read-aloud voices are also host resources. No selected repository contents,
conversation journal, runtime setup state, or provider credential is packaged
as source.

## Acceptance for each candidate

[`tests/portable-desktop-smoke.cjs`](../tests/portable-desktop-smoke.cjs) is prepared
for isolated native checks using the distribution's Electron and Python, with no
host Node/Python in PATH. It uses temporary journals and synthetic files plus a
loopback fixture provider. Its intended checks cover real conversation commit
and reload, finite specialist build/run, PDF/image intake, DOCX export/readback,
native PTY output, normal shutdown, and unchanged distribution inventories.
Fixture provider responses are not evidence of live-model quality.

A packaged Electron finds `resources/app/package.json` and runs its `main`.
Passing a test script as a positional argument does **not** select that test entry.
For acceptance, create a separately identified test copy and change only that
copy's `resources/app/package.json` `main` to
`tests/portable-desktop-smoke.cjs`. Record this derivative change and preserve the
original candidate and attestation. Launch the copied `electron.exe` without a
positional script. Require the fixture's startup marker and final receipt; a
normal app window alone does not prove that the fixture ran. The derivative's
package-file hash differs from the original attestation and must be reported.

Run this fixed fixture from two relocated folders containing spaces and Unicode
characters. Retain its before/after inventories, receipts, and screenshots for
each location. Separately launch the **untouched** production candidate through
its normal entry in isolated test state, check the actual main/preload and UI,
and confirm normal shutdown and unchanged payload. The fixture derivative and
the production-entry check prove different things; both are required before
claiming that particular candidate works without host Node/Python. Acceptance
receipts must identify its exact distribution bytes and disclose any test-copy
changes; receipts for another build do not establish this candidate's result.
