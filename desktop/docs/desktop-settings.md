# Desktop settings

Open **Settings** in the app sidebar. Choose a page, make changes, and select **Save settings**. Settings are stored with the local workspace through CommitService. Loading them finishes before the composer can send a request. Import uses the same validation and revision checks as ordinary saves.

YUR is a purchased desktop application. **License & purchases** replaces subscription billing. The development build does not claim a verified purchase, subscription, or activation. A sales/license issuer must be selected before purchase activation can be connected.

## Pages and current behavior

| Page | Available behavior |
| --- | --- |
| General | Default terminal shell, Terminal header control, prompt shortcuts, conversation-text size, Enter/Ctrl+Enter send shortcut, standalone-chat preference, installed dependency licenses. |
| Notifications | Opt-in desktop notifications for completed responses or errors, optional sound, and a test notification. |
| Import | Copy or paste a typed settings export; imports refresh the form immediately. Chats and credentials are not part of this export. |
| Profile | Local display name and profile description. The name appears in the app sidebar. |
| Appearance | System/light/dark theme, response font size, sidebar spacing, and accent color. |
| Parental controls | App-level restricted session blocks new model requests, Code execution, terminal input, browser navigation, dictation, and scheduled dispatch. This is not a tamper-proof child account. Already running tasks may finish; the existing Stop controls remain available. |
| Trusted contact | Local name and contact details for reference; no automatic contact or external messages. |
| Voice | Discovered local read-aloud voices, playback speed, dictation switch, and the existing offline dictation availability check. |
| Configuration | Default model and the existing model readiness/setup controls. |
| Personalization | Personal instructions and response-detail preference applied to new requests. |
| Pets | Optional named companion beside the composer, reflecting its idle/working state. |
| Keyboard shortcuts | Current app shortcuts and access to the send-shortcut preference. |
| License & purchases | Purchased-product model, app version, local conversation/message counts, and explicit activation status. |
| Account | Local profile access; no cloud identity is invented. |
| Computer use | Controls for selected browser-page context and Code mode. Other Windows application control is not included. |
| Appshots | Capture the YUR window, preview it, and explicitly copy its image. |
| Plugins | Existing Hermes, Copilot, and Workforce instruction libraries, with a host-enforced selection switch. |
| Browser | Integrated-browser switch and access to the existing browser. Disabling it hides the page and revokes selected-page grants. |
| Hooks | Before-send instruction hook applied to Chat, Work, and Code. It does not run shell commands. |
| Connections | Existing harness and Ollama endpoint settings with origin validation. |
| Git | Inspect the selected repository's branch/status; choose whether untracked paths appear. |
| Environments | Existing execution-runtime detection, preparation, and selected-environment controls. |
| Worktrees | Inspect registered worktrees of an explicitly selected repository. No automatic creation or deletion. |
| Archived chats | Open or restore locally archived conversations without replacing their messages. |

## Reference-image boundaries

The 24-page navigation matches the supplied category list, with purchase ownership replacing subscription billing. YUR's available behavior is listed above. This is not a claim of all Codex service functionality: translated app languages, a provider speed tier, configurable queue-versus-steer defaults, global popout-window hotkeys, cloud account relationships, third-party application automation, and storefront activation are not supplied by these pages. The composer remains plain text; existing Work correction/steering controls remain available in an active mission.

## Source and verification

- `settings-preferences.json` defines the shared preference schema and defaults.
- `foundry/settings_contract.py` validates preferences before the existing CommitService writes them.
- `src/settings-view.js` and `src/settings.css` implement the pages.
- `src/desktop-settings.js`, `src/main.js`, and `src/preload.js` provide the fixed desktop operations and host policy checks.
- `src/conversation-view.js`, `src/voice-view.js`, and `src/studio-editor.html` apply the preferences to the existing app.
- `tests/desktop-settings.test.js`, `tests/test_workspace.py`, and `tests/voice-view.test.js` cover policy enforcement, persistence, validation, read-only repository inspection, and voice selection/speed.
- `tests/desktop-parity-smoke.cjs` exercises all 24 pages through real Electron, preload, and CommitService, including save/reload, import, blocked capabilities, and a real window capture. Its model responses and user data are isolated fixtures.

The repository launcher starts the current source. Portable copies under `release/` contain snapshots; an older portable executable will not acquire these changes automatically. Fresh packages are produced with the existing source allowlist and deterministic desktop assembler.
