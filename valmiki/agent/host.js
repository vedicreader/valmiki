/* Everything the pane asks of the application around it, in one object.

   The pane runs in three places: Leela's IDE, Ramabana's own window, and a browser on a phone.
   Only the first has editors, tabs, panes and a vault, so every call into them goes through
   `agentHost` and every entry has a fallback that works without one. Nothing else in this block
   may name an identifier another block declares -- `test_ide_bundle.py` holds that.

   In Leela each entry finds the global the IDE already defines. Lazily, inside the call: the
   bundles share one scope but load in order, and `lee-cm6.js` arrives separately. */

import {$, esc} from '../js/kit.js';

const _ide = (name) => (typeof globalThis[name] === 'function' ? globalThis[name] : null);
const _call = (name, args, dflt = null) => { const f = _ide(name); return f ? f(...args) : dflt; };

/* A textarea standing in for CodeMirror, so the pane still edits where LeeCM never loaded. The
   six calls the pane makes of an editor, and no more. */
const TEXTAREA_CM = {
  create(el, opts = {}) {
    const ta = document.createElement('textarea');
    ta.className = 'lee-input lee-cm-fallback';
    ta.value = String(opts.doc || '');
    ta.readOnly = !!opts.readOnly;
    el.appendChild(ta);
    return ta;
  },
  getDoc: (v) => (v ? v.value : ''),
  setDoc: (v, text) => { if (v) v.value = String(text || ''); },
  cursor: (v) => (v ? v.selectionStart : 0),
  focus: (v) => v && v.focus(),
  replaceRange(v, text, from, to) {
    if (!v) return;
    const a = from == null ? v.selectionStart : from, b = to == null ? v.selectionEnd : to;
    v.value = v.value.slice(0, a) + text + v.value.slice(b);
  },
  destroy: (v) => v && v.remove(),
};

const _elsewhere = {};
const _shared = () => (typeof lee === 'object' && lee) || _elsewhere;

export const agentHost = {
  // panes and tabs
  openFile:   (...a) => _call('leeOpenFile', a),
  revealPane: (...a) => _call('leePane', a),
  expandPane: (...a) => _call('leeExpandPane', a),
  // the IDE reacting to what the agent did: reload open tabs, take the bytes off disk
  reloadAfterEdits:  (...a) => _call('reloadAfterEdits', a),
  reloadRestored:    (...a) => _call('reloadRestored', a),
  reloadFile:        (...a) => _call('scheduleAgentFileReload', a),
  takeDiskVersion:   (...a) => _call('takeDiskVersion', a),
  // the vault
  attachVaultRef: (...a) => _call('attachVaultRef', a),
  // editors
  currentEditor: (...a) => _call('curEditor', a),
  langOf: (name = '', path = '') => {
    const f = _ide('codeLang');
    return f ? f(name, path) : (String(name || '').replace(/^language-/, '') || 'text');
  },
  createEditor(el, opts = {}) { return (_ide('createEditor') || TEXTAREA_CM.create)(el, opts); },
  dropEditors: (...a) => _call('dropCodeSurfaces', a),
  mountEditor(host, code, lang = 'python', promote = false) {
    const f = _ide('mountCodeSurface');
    if (f) return f(host, code, lang, promote);
    const pre = document.createElement('pre');
    pre.className = 'lee-code-fallback';
    pre.textContent = String(code || '');
    host.appendChild(pre);
    return pre;
  },
  get cm() { return (typeof LeeCM !== 'undefined' && LeeCM) || TEXTAREA_CM; },
  /* State the pane shares with the application. In Leela it is `lee`, the same object the editor
     and the terminal use; elsewhere it is a plain object nobody else reads. `busy` and
     `memoryLoaded` are published rather than owned: the terminal dims on one, research reads the
     other. */
  get busy() { return _shared().agentBusy; },
  set busy(v) { _shared().agentBusy = v; },
  get memoryLoaded() { return _shared().memoryLoaded; },
  set memoryLoaded(v) { _shared().memoryLoaded = v; },
  get currentPath() { return _shared().path; },
  get prefs() { return _shared().prefs || {}; },
  get settingsMeta() { return _shared().settingsMeta; },
  get vaultRefs() { return _shared().vaultRefs || (_shared().vaultRefs = new Map()); },
  // notebook diffs
  diffHtml(rows) {
    const f = _ide('diffHtml');
    if (f) return f(rows);
    return (rows || []).map(r => `<div class="lee-drow ${r.kind || ''}">` +
      `<span class="lee-dnum">${r.line || ''}</span><span class="lee-dtext">${esc(r.text)}</span></div>`).join('');
  },
};
