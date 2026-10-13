# How YUR describes its capabilities

YUR's whole desktop includes more than the tools of one Work mission. The
Capabilities page and Chat/Work/Code now share the versioned
`desktop-capabilities.json` description: conversations, projects, shared files,
attachments, browser, voice, scheduled work, Studio, artifacts, specialist
generation/reuse, continuing concepts and registered instruction/source libraries.

The host reads this fixed application resource; callers cannot supply another
path or overwrite its facts through IPC. The manifest is bounded, schema-checked
and hashed. Its source references point to implementation files and are not read
as user context. Both language adapters consume the same file. No donor scanning,
runtime startup, credential access or capability execution happens to describe it.

The overview distinguishes four ways to access features:

- **Desktop controls:** explicit operator actions such as browser navigation,
  project selection, reviewed Apply, artifact export and the manual Studio terminal.
- **Agent tools:** bounded model-callable operations. The actual tool catalog for
  the current mission remains the only executable contract.
- **Requires setup or selection:** optional voice, vision, reviewed execution
  cells and generated Python workers. Listing them does not establish readiness.
- **Reference libraries:** Copilot, Workforce and registered YUR/yur-os sources.
  Source availability and instruction selection are not executable admission.

The description is deliberately not a live service inventory. Settings, execution
runtime checks and existing catalog endpoints report current availability. Current
saved-worker counts require fresh bounded discovery; an old name or sidebar
definition cannot establish a live worker. The existing legacy definitions remain
separate below the implemented desktop overview with their availability warning.

Chat receives the host-owned overview for both Ollama messages and Foundry query
transport. Its retained generation evidence records the source SHA-256 after
provider metadata is received, so provider output cannot forge that field. Chat
still executes no model tool calls. Existing total input limits include the new
context; oversized input is rejected instead of silently dropping user content.

Work and Code receive the description in the existing manager's trusted system
context, alongside existing execution restrictions. The existing `work.started`
event records its source SHA-256. Missing/invalid metadata fails before model or
tool execution and is recorded as a failure. Terminal mission replay returns the
retained result without loading new metadata or calling a model again.

These changes improve product understanding and give users an inspectable overview.
They do not add tools, grant shell authority, certify optional dependencies, import
donor agents, or establish unrestricted autonomous generation across every industry.
