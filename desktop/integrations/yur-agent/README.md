# YUR agent integration

This dependency-free ESM adapter implements the `Plugin`, `Action`, `Validator`,
`Handler`, and `ActionResult` shapes in the user's existing YUR agent source.
It adds actions to that runtime; it does not introduce another runtime, model,
or orchestrator. The external YUR agent checkout remains unchanged.

The host supplies an existing **completed and committed** factory mission. The
adapter inspects its status, passed validation and commit provenance, then binds
one action per exact capability in `mission.spec.capabilities`:

- `YUR_FOUNDRY_TEXT_ANALYZE`
- `YUR_FOUNDRY_DATA_PROFILE`
- `YUR_FOUNDRY_SUPPORT_TRIAGE`

Only capabilities present in the committed mission are exposed. Input comes from
`message.content.factoryInput`, subject to the capability's strict JSON contract.
Freeform message text, model-selected paths, executable code, mission identifiers,
and capability overrides cannot change these bindings. Text inside a valid input
is treated as data. Franklin's existing factory OrchestrationManager validates the
artifact and authority again on every run; Commit Service records execution events.
Results include the actual `execution.completed` receipt. The adapter checks that
the receipt names the pinned mission, capability, run and committed artifact digest.

## Host wiring

Import the adapter by the actual local path configured by the host. Supply the
factory checkout and state directory explicitly; there are no network ports or
provider credentials in this integration.

```javascript
import { createFoundryPlugin, createLocalTransport } from './foundry-plugin.mjs';

const invoke = createLocalTransport({
  python: hostConfig.pythonExecutable,
  sourceRoot: hostConfig.factorySourceRoot, // absolute studio-electron directory
  stateRoot: hostConfig.factoryStateRoot,   // absolute existing factory state directory
});
const plugin = await createFoundryPlugin({
  missionId: hostConfig.committedMissionId,
  invoke,
});

// Include this plugin in the existing YUR agent's normal plugins array.
const projectAgent = { character, plugins: [...existingPlugins, plugin] };
```

For a text action, pass a runtime message whose content contains:

```json
{"factoryInput":{"text":"Useful agents produce measurable outcomes.","top_k":3}}
```

The transport spawns `python -B -m foundry.factory_cli rpc` with no shell and a
hidden Windows process. It accepts only `inspect` and `run`, caps requests at
128 KiB and responses at 2 MB, and applies a 30-second timeout. The host may choose
bounded limits with `timeoutMs` and `maxResponseBytes`. On timeout it stops only
that worker process. It inherits a minimal OS environment, omitting provider
credentials and Python import-path overrides. The OS account and host configuration
are the trust boundary; replacing the injected `invoke` transport changes that
trust boundary. Callback output is serialized JSON with a fixed action/source.
Callback delivery failure preserves the completed execution receipt and marks
`data.callback_delivery_failed`; it never silently reruns completed work.

## Validation and admission boundary

Run `node --test tests/yur-agent-plugin.test.js` from studio-electron. Tests build a
real mission through the Python CLI in a temporary store, bind the action, execute
new input and verify its receipt. They also cover invalid input, unbound capabilities,
malformed responses, mismatched receipts, worker timeouts and byte limits.

This proves the adapter contract and the real local factory transport. It does
not claim that the external YUR agent runtime has loaded the plugin or that its
full Bun dependency/build suite has passed. Installing or editing that external
application is a separate integration step.

## Read-only source provenance

The interface was inspected in `<unified-root>\core\agents\yur-agent` after reading
its applicable AGENTS.md files. No source was copied from the donor; this adapter
was independently implemented against its public structural contracts.

| Source relative to the donor root | SHA-256 at inspection |
| --- | --- |
| packages/core/src/types/plugin.ts | EC091C1306BC2C13B07135F7F41732114793B0AB57F808054D91B133D17AC74E |
| packages/core/src/types/components.ts | 0C14FDB99BF2104F0256DFB4249E93E36E9B9B533CCE1F73B578B375A65342DB |
| packages/plugin-starter/src/plugin.ts | DD8E9971051D6C9B94D19910DE18B4FACF74DB45D57E2A523D91EBB55C70EC45 |
