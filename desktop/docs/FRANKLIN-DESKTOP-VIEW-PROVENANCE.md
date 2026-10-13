# Franklin Desktop presentation binding

This presentation adapter reuses Nova's fixed Franklin assistant shell, saved-turn identity and reconciliation flow, status/review presentation, and separation between interface actions and durable backend state. It preserves the owner's blue slate and silver Desktop palette.

Read-only donors inspected on 2026-10-03:

- `<workspace>\2026-10-01\task-4\nova-source\public\copilot.js`
- `<workspace>\2026-10-01\task-4\nova-source\public\copilot.css`
- `<workspace>\2026-10-01\task-4\nova-source\public\copilot-actions.mjs`
- `<workspace>\2026-10-01\task-4\nova-source\lib\copilot-presentation.ts`

The Electron implementation is `src/franklin-view.js` and `src/franklin-view.css`. It mounts once outside changing work surfaces. It receives model choices, messages, context, permissions, requests and receipts through the host's typed assistant contract. It does not fetch model endpoints, use browser storage for memory, create another orchestrator, or confer authority on model output. Browser speech, Nova project mutations, route lists and sessionStorage persistence were not promoted into the Desktop binding.

Host methods: `snapshot()`, `configure({model?,open?,draft?})`, `send({text,request_id})`, `cancel({request_id})`, `onEvent(callback)`. The host supplies persisted preferences, an available-model catalog, bounded conversation messages and action events, active-request identity, compiled context summary and permission state. A retry retains the original request ID. A collapsed panel keeps work and its checkpoint intact. The pill's status reflects reported runtime state; this view does not implement an operating-system background service.

The owner keeps existing approval interfaces. A pending approval is shown as pending; it is never accepted by the presentation layer. Only returned receipts are displayed as committed results. Installed donors remain unchanged.

Live observation reuses the host's existing Activity feed. The assistant shows bounded counts and the latest updated request while the app is open. These are transient observations, not new commit receipts; subscribing does not call a model or save another history. Each requested task still compiles a fresh host snapshot. Native acceptance matched the observer's mission ID to a completed lifecycle Work mission without any additional inference.

The browser remains a native WebContentsView. The assistant is positioned beside its pane when space permits; native view bounds reserve room for the assistant on narrower layouts. Explicit view acknowledgments precede browser operations. Canonical view IDs now distinguish workforce, capabilities, editor, and deployed agents from the legacy renderer's internal section names. The context presentation retains the accepted task's compilation metadata alongside current observations. Runtime failures remain visible after recovery refresh.
