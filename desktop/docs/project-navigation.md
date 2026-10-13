# Project navigation in the desktop

Projects are available by name in the conversation sidebar. Opening a project
shows its shared instructions, selected source folder and related conversations.
It does not move the conversation you were working in or acquire repository files.

Choose **New Chat**, **New Work** or **New Code** from a project to create a
separate conversation using that project's context. Existing drafts and messages
stay with their original conversations. The Chat, Work and Code controls in the
conversation header select the mode for subsequent work; mode changes are disabled
while that conversation has an active response or task.

The composer project selector continues to explicitly assign the current
conversation to a project. The **Projects** overview and existing project editor
remain available. Project names, instructions and folders are data and are rendered
as text, not executable markup.

The conversation row menu updates names, pinned order and archived visibility
after the save is acknowledged. That refresh preserves the current project home
and its controls; a late acknowledgment does not reopen a project you left.

Storage uses the existing conversation/project CommitService records and revision
checks. Project membership is conversation metadata; opening a project does not
create a mission, grant tools, prepare an execution runtime, navigate a browser,
or read every conversation into model context. At Send, existing context compilation
acquires only the selected project's permitted source and instructions. Work and
Code remain subject to the current execution and delivery policies.

## Validation

`node --test tests/conversation-project-navigation.test.js` exercises the renderer's
actual navigation and mode handlers with controlled persistence responses.

`npm run test:projects` uses real Electron, preload, Python storage, OrchestrationManager
and CommitService with temporary projects and an isolated model-response fixture.
It checks project isolation, separate persisted drafts, actual selected-project
Work, rejection of in-flight mode changes and reload without task replay. This is
desktop integration evidence, not a live-model benchmark.

## Reference and remaining scope

The September 15, 2026 review of the official
[ChatGPT desktop Work guide](https://help.openai.com/en/articles/20001275) confirms
project-based task creation and shared conversation navigation as reference
interactions. YUR presents its own Chat, Work and Code modes within the existing
desktop. This change does not supply proprietary cloud services or account sync.

Shared project reference-file storage is implemented through the existing
CommitService, with explicit file selections for each conversation. See the
[shared project files guide](desktop-usability.md) for storage, context and
retention limits. Cross-device synchronization, multi-user project sharing and
project-level deletion/archival remain separate capabilities. Local source
folders and instructions continue to use their established contracts.
