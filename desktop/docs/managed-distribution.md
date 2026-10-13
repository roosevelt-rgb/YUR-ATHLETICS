# Managed Desktop distribution components

The existing `scripts/package_desktop.py` assembler can include both reviewed
IntelliFlow native gateway bundles in the same portable Desktop folder and ZIP.
This extends the existing assembler and installed engine bindings. It does not
install or replace an application, migrate saved sessions, create another
orchestrator, or admit a new authority.

This is a native-engine packaging candidate. The Marketplace engine and its
prepared Python environment, music application source, workforce donor sources,
model providers, Construction department transport, WSL execution resources,
and offline voice models remain separate dependencies. The generated
attestation records these limits; native engine inclusion alone does not establish
complete product self-containment or live capability readiness.

The Marketplace sidecar can use an existing engine installation selected through
`YUR_HARNESS_ENGINE_ROOT`. Set this to the absolute engine directory containing
`yur_harness/__main__.py`; its prepared `.venv` supplies Python by default.
`YUR_HARNESS_PYTHON` can select a compatible prepared interpreter explicitly.
An invalid explicit engine selection is unavailable and does not fall back to
another installation. With no override, the existing source-installation layout
`<unifiedRoot>/marketplace/engine` still applies.

The portable candidate does not bundle that directory or a Marketplace virtual
environment. Its embedded Desktop Python serves a different runtime contract.
The root launchers keep harness autostart disabled; connecting the Marketplace
starts the explicitly selected engine under the existing loopback and authority
controls. A startup test with the sidecar stopped does not validate this connection.

## Reviewed inputs

The existing `yur.desktop-distribution-inputs.v1` document remains valid without a
`components` field. To include the native engines, add an optional `components`
object with exactly the two entries below. All paths must be absolute local paths.
Pin the exact byte count and SHA-256 of each existing donor manifest before building.
The source bindings independently pin each gateway executable's digest.

```json
{
  "components": {
    "intelliflow": {
      "root": "<installed resources/gateway-runtime directory>",
      "manifest_path": "<installed resources/gateway-runtime.manifest.json>",
      "manifest_sha256": "<reviewed exact donor-manifest SHA-256>",
      "manifest_bytes": 1,
      "source_identity": "<reviewed donor origin and selection>"
    },
    "construction-v1": {
      "root": "<installed resources/gateway-runtime-v11 directory>",
      "manifest_path": "<installed resources/gateway-runtime-v11.manifest.json>",
      "manifest_sha256": "<reviewed exact donor-manifest SHA-256>",
      "manifest_bytes": 1,
      "source_identity": "<reviewed donor origin and selection>"
    }
  }
}
```

This fragment must be merged into the complete reviewed base input document;
its placeholders and example byte counts are not usable build inputs. Partial
native component sets and unknown component names are rejected. The installed
donor locations are resolved under local application data:

- IntelliFlow: `Intelliflow/resources/gateway-runtime`, with its sibling
  `gateway-runtime.manifest.json`; source pin `src/glider-rc6-binding.json`.
- Construction V1: `Intelliflow Construction V1/resources/gateway-runtime-v11`,
  with its sibling `gateway-runtime-v11.manifest.json`; source pin
  `src/construction-v1-binding.json`.

The assembler reads only each manifest-listed one-directory bundle. It checks the
complete file inventory, executable identity, every file's bytes/digest, bounded
size, path spelling, and changes during assembly. The required `_internal`
dependency payload is retained. Links, reparse points, hard-linked files,
unlisted files, credential/state/cache paths, databases, logs, and bytecode caches
are rejected. Exact donor manifest bytes, including an existing UTF-8 BOM, are
retained with their original digest. Native upstream build reproducibility and
redistribution licensing are not established by this byte inventory.

Use the existing build command after the source allowlist and reviewed inputs
are final:

```powershell
python -B scripts/package_desktop.py --app-root "$appRoot" build --inputs "$reviewedInputs" --output "$freshCandidate"
```

The output folder and sibling ZIP must not exist. The assembler never downloads,
executes dependency code, installs components, or copies user profiles.

## Fixed packaged resources

```text
candidate/
  electron.exe
  Start YUR AI Desktop.cmd
  Start IntelliFlow Unified.cmd
  DISTRIBUTION_ATTESTATION.json
  resources/
    app/
      .desktop-distribution.json
      .desktop-native-components.json
      ...allowlisted Desktop source and Node dependencies...
    python/
      ...verified embedded Desktop Python...
    native/
      intelliflow/
        yur-gateway.exe
        _internal/...
        donor-manifest.json
        runtime.json
      construction-v1/
        yur-gateway.exe
        _internal/...
        donor-manifest.json
        runtime.json
```

The root launchers are generated for this packaged layout. Both enable the same
Code Glider shell, disable the separate sidecar autostart, clear Electron's
Node-only mode, bind the package root without parent traversal, and use the
existing per-user `yur-intelliflow-glider-rc6` conversations/factory directories.
They forward explicit arguments and check the packaged Electron/application entry.
Retained source launchers under `resources/app` are source artifacts, not the
public packaged entry points.

`src/rc6-transport.js` prefers the fixed attested packaged gateway resources when
their marker exists. It verifies the entire selected native payload before
creating private state or starting a process. Missing/corrupt declared native
resources fail without falling back to an installed gateway. Without native
resources, the previous installed-runtime development binding remains supported.
Normal isolated native profiles, selected workspaces, provider selection, tool
approvals, validation, and engine authority behavior remain unchanged.

The resource marker pins each generated native `runtime.json`; that manifest
pins all copied engine files and the exact donor manifest, and its executable
digest must also match the source binding. `DISTRIBUTION_ATTESTATION.json`
records the native inventory, donor identity/digest, and output hashes. These are
unsigned local build attestations, not publisher signatures.

## Acceptance and remaining dependencies

The focused distribution tests assemble inert synthetic native components. The
transport tests use a synthetic process fixture and prove packaged preference,
private-state separation, full dependency verification, and rejection before
process/state creation when resources drift. These tests do not run a native
gateway or prove live model/tool results.

Each actual candidate still needs the existing portable Desktop acceptance and
an isolated native gateway inventory/readiness check using its bundled binaries.
Identify the exact candidate/ZIP/manifest hashes, preserve its untouched payload,
and keep test state outside the distribution. A production launch and any fixture
derivative must be separately recorded as described in `portable-desktop.md`.

Music remains external because its selected application and runtime binding are
not admitted by this native component extension. Its required Foundry sources
and explicit D-drive source/data contract must be reconciled before packaging
Music. Workforce source roots also remain explicit external inputs. Embedded
native knowledge/ingest providers and managed skills/memory services are retained
inside the copied native bundles; their presence does not imply every provider,
scheduler, database, model, department, or external dependency is connected.
