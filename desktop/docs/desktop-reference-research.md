# Desktop workflow reference research

The project-navigation reference was refreshed on 2026-09-15 against the official
Work/Codex and Projects guides. Named projects in the sidebar, project-context
conversation creation and visible mode selection inform the next desktop increment;
cloud synchronization and service access remain separate integration work. See
[project navigation](project-navigation.md) for YUR's implemented scope and checks.

Checked 2026-09-12 against the official sources below and the installed Hermes
source. This is a requirements reference, not evidence that YUR has implemented
every listed capability. `desktop-parity-mission.md` tracks implementation.

## ChatGPT Desktop, Work and Codex

The current OpenAI product separates conversational assistance, deliverable-oriented
Work and software development, while retaining project context and recent work.
Users can inspect progress, provide corrections and continue the same task. Local
file/device access and hosted execution are distinct. Our YUR mapping is a shared
conversation with selectable modes and explicit execution location, rather than
separate disconnected pages. [Official Work and Codex guide](https://help.openai.com/en/articles/20001275)

Projects combine conversations, reference files and instructions. YUR needs durable
project membership and bounded project context on every turn, with editing and
reopening verified. [Official Projects guide](https://help.openai.com/en/articles/10169521)

The desktop browser has visible pages/tabs and explicit site access; remote browser
execution is a separate environment. Browser content must not gain privileged YUR
preload access. [Official browser guide](https://help.openai.com/en/articles/20001277)

## Claude, Claude Code and Cowork

Claude Code's desktop workflows include project/environment selection, streamed
responses, tool progress, terminals, source changes and review beside conversations.
Our acceptance cases require a user to follow work from intent to an actual file,
diff or test result without losing the chat or editor state.
[Claude Code Desktop](https://code.claude.com/docs/en/desktop)

Current Cowork documentation describes a shared Chat/Cowork home and composer,
parallel subtasks and outcome-oriented work. Local resources still depend on the
connected desktop. Official pages differ during rollout about tabs and local versus
cloud work; YUR must show the selected environment accurately.
[Cowork guide](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork)

Cowork artifacts have durable identity and can be reopened and revised. Schedules
have execution-location limits: documented remote scheduling does not automatically
grant access to a local folder. YUR needs real output records, version evidence and
explicit scheduler/runtime requirements.
[Artifacts](https://support.claude.com/en/articles/14729249-use-artifacts-in-claude-cowork),
[Schedules](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork)

## Hermes Agent Desktop

Hermes's documented desktop uses the existing agent core and shares sessions,
skills and memory with its other surfaces. It combines a conversation-first shell,
streaming, visible tool activity, file drop, a preview rail, session drafts, queue
controls, terminal context, capabilities, artifacts and optional companion features.
This reinforces the user's request to bind the YUR ecosystem into one environment.
[Official Desktop guide](https://hermes-agent.nousresearch.com/docs/user-guide/desktop)

Persistent session/workspace context provides the cross-surface continuity reference.
YUR's implementation must keep conversation state and authoritative mission state
separate while linking them through stable identifiers and committed evidence.
[Hermes sessions](https://hermes-agent.nousresearch.com/docs/user-guide/sessions)

The local Hermes launcher resolves to
`%LOCALAPPDATA%\hermes\hermes-agent`. Read-only inspection of
`apps/desktop/README.md`, `apps/desktop/package.json` and `pyproject.toml` found
desktop source package 0.17.0 and runtime source 0.18.2. These are source metadata,
not a verified running-binary version. No Hermes source or credentials were copied
and its controller is not adopted as a competing YUR authority.

## Technical implementation checks

Ollama documents real incremental content and tool calls. Tool outputs must be
returned to the model in a subsequent turn; showing a function name is insufficient.
[Streaming](https://docs.ollama.com/capabilities/streaming),
[Tool calling](https://docs.ollama.com/capabilities/tool-calling)

Ollama reports final-answer content separately from thinking content, and its
chat response includes a finish reason and token counts. An empty final answer
with no native tool calls is not successful Work. The Desktop now retains only
bounded diagnostic counts and an allowlisted finish reason for that failure;
it does not substitute thinking text or invent an answer. The cause of earlier
empty responses cannot be recovered from receipts that lacked those diagnostics.
[Chat API](https://docs.ollama.com/api/chat),
[Thinking](https://docs.ollama.com/capabilities/thinking)

Electron recommends isolating untrusted pages from Node and privileged APIs and
prefers WebContentsView or sandboxed iframes over the webview tag. These rules apply
to YUR's eventual browser/artifact surfaces.
[Electron security](https://www.electronjs.org/docs/latest/tutorial/security),
[Web embeds](https://www.electronjs.org/docs/latest/tutorial/web-embeds/)

The implemented interactive artifact surface uses its own WebContentsView,
ephemeral session and host-owned protocol response. A restrictive response CSP
and sandbox allow local artifact scripts while denying outside resource loads,
navigation, devices, storage and desktop APIs. Its native test verifies a real
interactive calculation and failed network/device attempts. CSP sandbox policy
is delivered as a response header rather than an unsupported meta directive.
[CSP sandbox](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox)

Subscription model access, proprietary cloud services, remote persistence,
account synchronization and hosted connectors do not appear merely by reproducing
a UI. Each requires its own explicit YUR adapter, permission and outcome test.

## September 15 usability follow-through

Official references for this pass were [ChatGPT Projects](https://help.openai.com/en/articles/10169521),
[ChatGPT Work](https://help.openai.com/en/articles/20001275),
[Hermes Desktop](https://hermes-agent.nousresearch.com/docs/user-guide/desktop),
and [Claude Code Desktop](https://code.claude.com/docs/en/desktop).
The implemented YUR changes address shared project references, explicit model
setup, reading continuity while background work proceeds, and discovery of
retained task results. YUR keeps its own permission, orchestration and commit
boundaries. See [the implementation and acceptance guide](desktop-usability.md).
