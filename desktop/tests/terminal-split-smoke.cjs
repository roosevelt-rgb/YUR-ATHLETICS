'use strict';
// Real main/preload, xterm and two owned native PowerShell PTYs. Only fixed
// Write-Output commands run; no model request, user file/profile or external UI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow } = require('electron');
const { nativeFixture, sha } = require('./specialists-smoke.cjs');
const files = ['src/terminal-panes.js', 'src/studio-editor.html', 'tests/terminal-split-smoke.cjs'];
const hashes = () => Object.fromEntries(files.map(file => [file, sha(fs.readFileSync(path.join(__dirname, '..', file)))]));
const before = hashes(), ownedPids = [];
function alive(id) { try { process.kill(id, 0); return true; } catch { return false; } }
async function exited(id) { const deadline = Date.now() + 5000; while (alive(id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50)); return !alive(id); }
nativeFixture({ prefix: 'terminal-split', model: 'terminal-no-inference-fixture', timeoutMs: 90000, gracefulShutdown: true,
  handle() { throw new Error('Terminal fixture must not invoke any model.'); },
  async afterShutdown(ctx, observed) {
    assert.equal(observed, true);
    const exits = await Promise.all(ownedPids.map(exited)); assert.ok(exits.every(Boolean), 'Every owned terminal must exit during normal shutdown.');
    const after = hashes(); assert.deepEqual(after, before); ctx.proof.source_hashes = { before, after };
    ctx.proof.owned_terminal_exit = ownedPids.map((pid, index) => ({ pid, exited: exits[index] }));
  },
  async run(ctx) {
    const { evaluate, waitFor } = ctx;
    const primaryText = "Array.from({length:state.term.buffer.active.length},(_,i)=>state.term.buffer.active.getLine(i)?.translateToString(true)||'').join('\\n')";
    const secondaryText = "Array.from({length:window.__ownedSplitTerminal.buffer.active.length},(_,i)=>window.__ownedSplitTerminal.buffer.active.getLine(i)?.translateToString(true)||'').join('\\n')";
    const openEditor = async () => {
      await evaluate("document.querySelector('[data-workspace=files]').click()");
      await waitFor('Boolean(window.yurWorkspace && document.getElementById("yc-main").classList.contains("studio-open"))');
      await evaluate('document.getElementById("yc-intelliflow-files-tab").click()');
      await waitFor('document.getElementById("yc-intelliflow-files-tab").getAttribute("aria-pressed")==="true" && !document.getElementById("yc-studio-editor-toolbar").hidden && document.getElementById("yc-studio-editor-host").getBoundingClientRect().height>0');
    };
    await openEditor();
    // Capture the real xterm instance only inside this isolated fixture. Canvas
    // rendering is not represented by DOM textContent. Production has no debug API.
    await evaluate(`(() => {
      const originalCreate = window.yurTerminalPanes.create;
      window.yurTerminalPanes.create = options => originalCreate({ ...options,
        Terminal: new Proxy(options.Terminal, { construct(Target, args) {
          const terminal = Reflect.construct(Target, args); window.__ownedSplitTerminal = terminal; return terminal;
        } }),
        FitAddon: new Proxy(options.FitAddon, { construct(Target, args) {
          const fit = Reflect.construct(Target, args); window.__ownedSplitFit = fit; return fit;
        } }),
      });
    })()`);
    await evaluate('document.querySelector("#yc-studio-editor-toolbar [data-studio-command=terminal]").click()');
    await waitFor('Boolean(state.ptyId && terminalPanes)');
    await waitFor('document.getElementById("terminal-split").getBoundingClientRect().height>0');
    const first = await evaluate('state.ptyId'); assert.ok(Number.isInteger(first)); ownedPids.push(first);
    await evaluate("document.getElementById('terminal-split').click()");
    await waitFor('Boolean(terminalPanes.state().id && !terminalPanes.state().busy)');
    const second = await evaluate('terminalPanes.state().id'); assert.ok(Number.isInteger(second)); assert.notEqual(second, first); ownedPids.push(second);
    assert.equal(await evaluate('document.querySelectorAll("#yc-studio-terminal-host .xterm").length'), 2);
    assert.equal(await evaluate('document.getElementById("terminal-split").disabled'), true);
    assert.equal(await evaluate('Boolean(window.__ownedSplitTerminal && document.querySelector(".yur-terminal-split .xterm").getBoundingClientRect().height>20 && document.querySelector("#terminal-host .xterm").getBoundingClientRect().height>20)'), true);
    await evaluate('splitTerminal()'); assert.equal(await evaluate('terminalPanes.state().id'), second);
    ctx.checks.push('Actual native split button creates one second PTY/xterm and caps the workspace at two panes');
    const command = suffix => "Write-Output ('NATIVE_SPLIT_' + '" + suffix + "')\r";
    await evaluate('studio.terminal.input(' + first + ',' + JSON.stringify(command('FIRST_a01')) + ')');
    await evaluate('studio.terminal.input(' + second + ',' + JSON.stringify(command('SECOND_b02')) + ')');
    await waitFor(primaryText + ".includes('NATIVE_SPLIT_FIRST_a01')");
    await waitFor(secondaryText + ".includes('NATIVE_SPLIT_SECOND_b02')");
    assert.equal(await evaluate(primaryText + ".includes('NATIVE_SPLIT_SECOND_b02')"), false);
    assert.equal(await evaluate(secondaryText + ".includes('NATIVE_SPLIT_FIRST_a01')"), false);
    ctx.checks.push('Two real PowerShell Write-Output results route exclusively to their owning terminal panes');
    await ctx.capture('two-owned-terminals');
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('/studio-editor.html'));
    assert.ok(window, 'The owned fixture Desktop window must exist.');
    const bounds = window.getBounds();
    const measure = () => evaluate(`({
      viewport:{width:innerWidth,height:innerHeight},
      columns:[state.term.cols,window.__ownedSplitTerminal.cols],
      proposed_columns:[state.fitAddon.proposeDimensions()?.cols,window.__ownedSplitFit.proposeDimensions()?.cols],
      hosts:[state.term.element.parentElement,window.__ownedSplitTerminal.element.parentElement].map(node=>{
        const box=node.getBoundingClientRect();return {width:box.width,height:box.height};
      }), ids:[state.ptyId,terminalPanes.state().id]
    })`);
    const geometry = await measure();
    const resizeProof = ctx.proof.terminal_resize = { before: { bounds, ...geometry } };
    const fitted = 'state.term.cols===state.fitAddon.proposeDimensions()?.cols && window.__ownedSplitTerminal.cols===window.__ownedSplitFit.proposeDimensions()?.cols';
    try {
      await evaluate('document.getElementById("yc-intelliflow-coding-tab").click()');
      await waitFor('!document.getElementById("yc-intelliflow-workspace-host").hidden && !mountedStudioActive');
      window.setBounds({ ...bounds, width: bounds.width - 280 });
      // Windows frameless non-client sizing can differ from requested native
      // dimensions. Require observed viewport and buffer changes, then compare
      // fitted columns with the dimensions proposed for each current host.
      await waitFor('window.innerWidth<' + geometry.viewport.width);
      resizeProof.smaller_hidden = await measure();
      assert.deepEqual(resizeProof.smaller_hidden.columns, geometry.columns, 'Hidden panes retain dimensions until visible.');
      await evaluate('document.getElementById("yc-intelliflow-files-tab").click()');
      resizeProof.smaller_before_fit = await measure();
      await waitFor('mountedStudioActive && state.term.cols<' + geometry.columns[0] + ' && window.__ownedSplitTerminal.cols<' + geometry.columns[1] + ' && ' + fitted);
      resizeProof.smaller = await measure();
      assert.deepEqual(resizeProof.smaller.ids, [first, second]);
      window.setBounds(bounds);
      resizeProof.restore_requested = await measure();
      await waitFor('window.innerWidth>' + resizeProof.smaller.viewport.width);
      resizeProof.restored_before_fit = await measure();
      await waitFor('state.term.cols>' + resizeProof.smaller.columns[0] + ' && window.__ownedSplitTerminal.cols>' + resizeProof.smaller.columns[1] + ' && ' + fitted);
      resizeProof.restored = await measure();
      for (let index = 0; index < 2; index++) assert.ok(resizeProof.restored.hosts[index].width > resizeProof.smaller.hosts[index].width, 'Restored columns must correspond to a wider actual pane.');
      assert.deepEqual(resizeProof.restored.ids, [first, second]);
    } finally {
      resizeProof.last_observed = await measure();
    }
    ctx.checks.push('Resize while Coding hides the editor preserves both PTYs; returning to Editor fits both real terminal buffers to the current viewport');
    await evaluate('document.getElementById("yc-studio-back").click()');
    await openEditor();
    assert.deepEqual(await evaluate('[state.ptyId,terminalPanes.state().id]'), [first, second]);
    ctx.checks.push('Both native terminal IDs survive navigating away and back without replacement');
    await evaluate('document.querySelector(".yur-terminal-split button").click()');
    await waitFor('!terminalPanes.state().split'); assert.equal(await exited(second), true); assert.equal(alive(first), true);
    assert.equal(await evaluate('document.querySelectorAll("#yc-studio-terminal-host .xterm").length'), 1);
    assert.equal(await evaluate('document.getElementById("terminal-split").disabled'), false);
    await evaluate('studio.terminal.input(' + first + ',' + JSON.stringify(command('FIRST_SURVIVES_c03')) + ')');
    await waitFor(primaryText + ".includes('NATIVE_SPLIT_FIRST_SURVIVES_c03')");
    ctx.checks.push('Closing second pane exits only its own shell; original shell remains usable and Split is enabled again');
    assert.equal(ctx.requests.length, 0); ctx.proof.fixed_commands_only = true; ctx.proof.no_model_inference = true;
  },
});
