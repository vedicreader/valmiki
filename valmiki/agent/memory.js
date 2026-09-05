import {$, $$, esc, api, post, status, renderMarkdown, modal, confirmDialog} from '../js/kit.js';
import {leeRight} from './budgets.js';
import {agentHost} from './host.js';
import {ag} from './panel.js';

export function setMemoryView(view) {
  ag.memoryViewSeq += 1;
  const panel = $('.lee-memory');
  if (panel) { panel.classList.remove('memory-view-notes', 'memory-view-sources', 'memory-view-topics', 'memory-view-vault'); panel.classList.add('memory-view-' + view); }
  $$('[data-memory-view]').forEach(button => button.classList.toggle('active', button.dataset.memoryView === view));
}
export async function leeMemoryNotes() {
  const body = $('#memorybody'); if (!body) return;
  agentHost.memoryLoaded = 'loading'; agentHost.revealPane('right', true); leeRight('memory'); setMemoryView('notes');
  const seq = ag.memoryViewSeq;
  body.innerHTML = '<div class="lee-memory-empty">Loading agent memory…</div>';
  try {
    const data = await api('/agent/memory'), selected = Object.fromEntries(
      Object.entries(data.selected || {}).map(([target, ids]) => [target, new Set(ids || [])]));
    if (seq !== ag.memoryViewSeq) return;      // the vault (or another view) is on screen now
    ag.memory = data; agentHost.memoryLoaded = 'notes';
    $('#memorystatus').textContent = `· ${data.notes.length} note${data.notes.length === 1 ? '' : 's'}`;
    if (!data.notes.length) {
      body.innerHTML = `<section class="lee-memory-notes-empty"><strong>Give the models durable context</strong>` +
        `<p>Store project conventions, decisions, preferences, and recurring instructions. You choose which model sees each note.</p>` +
        `<button class="lee-btn go" onclick="leeNewMemoryNote()">Create a memory note</button></section>`; return;
    }
    const labels = {agent: 'Agent', inline: 'Prompt', completion: 'Complete'};
    body.innerHTML = `<div class="lee-memory-notes-intro"><span>Model context</span><strong>Select exactly where each note is used.</strong></div>` +
      data.notes.map(note => `<article class="lee-memory-note-card" data-note-id="${esc(note.id)}"><button class="lee-memory-note-open" data-edit-note>` +
        `<strong>${esc(note.title || 'Untitled note')}</strong><span>${esc(String(note.text || '').replace(/\s+/g, ' ').slice(0, 180))}</span></button>` +
        `<div class="lee-memory-note-routes">${Object.entries(labels).map(([target, label]) => `<label title="Use in ${esc(data.targets[target])}">` +
          `<input type="checkbox" data-quick-target="${target}"${selected[target]?.has(String(note.id)) ? ' checked' : ''}><span>${label}</span></label>`).join('')}</div>` +
        `<button class="lee-memory-note-edit" data-edit-note aria-label="edit ${esc(note.title || 'memory note')}">edit</button></article>`).join('');
    $$('.lee-memory-note-card', body).forEach(card => {
      const note = data.notes.find(item => String(item.id) === card.dataset.noteId);
      $$('[data-edit-note]', card).forEach(button => button.onclick = () => leeAgentMemory(note.id));
      $$('[data-quick-target]', card).forEach(input => input.onchange = async () => {
        const target = input.dataset.quickTarget, id = String(note.id);
        input.checked ? selected[target].add(id) : selected[target].delete(id);
        try {
          const result = await post('/agent/memory/select', {target, ids: [...selected[target]]});
          status(`${data.targets[target]} memory updated · about ${result.tokens.toLocaleString()} tokens`, 'ok');
        } catch (e) { input.checked = !input.checked; status(e.message || String(e), 'err'); }
      });
    });
  } catch (e) { if (seq !== ag.memoryViewSeq) return; agentHost.memoryLoaded = false; body.innerHTML = `<div class="lee-err">${esc(e.message || e)}</div>`; }
}
function leeNewMemoryNote(draft = {}) { leeAgentMemory('__new__', draft); }
window.leeMemoryNotes = leeMemoryNotes; window.leeNewMemoryNote = leeNewMemoryNote;

async function leeAgentMemory(focusId = '', draft = {}) {
  try {
    const data = await api('/agent/memory'), selected = Object.fromEntries(
      Object.entries(data.selected || {}).map(([target, ids]) => [target, new Set(ids || [])]));
    let active = focusId === '__new__' ? {id: '', title: draft.title || '', text: draft.text || ''} :
      (data.notes || []).find(note => String(note.id) === String(focusId)) || data.notes?.[0] || null;
    let saveNote = async () => false;
    const box = modal(`<div class="lee-mhead">Agent memory<span class="sub">durable notes with explicit model routing</span></div>` +
      `<div class="lee-memory-workbench"><aside class="lee-memory-note-list"><header><strong>Notes</strong>` +
      `<button class="lee-btn" data-new-note>New note</button></header><input class="lee-input" data-note-filter placeholder="Filter notes…">` +
      `<div data-note-list></div></aside><section class="lee-memory-note-editor"><div class="lee-memory-note-empty" data-note-empty>` +
      `<strong>No memory note selected</strong><span>Create a note for conventions, architectural decisions, preferences, or recurring context.</span>` +
      `<button class="lee-btn go" data-empty-new>Create first note</button></div><div data-note-form hidden>` +
      `<label class="lee-fieldlabel">Title<input class="lee-input" data-note-title placeholder="e.g. API compatibility rules"></label>` +
      `<div class="lee-memory-editor-head"><span>Memory note</span><small>Markdown · editable</small></div>` +
      `<div class="lee-memory-note-cm" data-note-text></div></div></section>` +
      `<aside class="lee-memory-routing"><header><strong>Use this note in</strong><span>${active?.id ? 'Changes apply to live model context immediately.' : 'Choose now; routing starts when you save.'}</span></header>` +
      `<div data-memory-targets></div><section class="lee-memory-routing-help"><strong>How routing works</strong>` +
      `<p><b>Agent</b> guides the long-running conversation and tools.</p><p><b>Prompt cells</b> guides notebook AI cells independently.</p>` +
      `<p><b>Completion</b> adds a bounded excerpt to one-shot code suggestions. Keep these notes short.</p></section>` +
      `<div class="lee-memory-budget" data-memory-budget></div></aside></div>` +
      `<div class="lee-mfoot"><button class="lee-btn warn" data-delete-note disabled>Delete note</button>` +
      `<span class="lee-spacer"></span><span class="lee-dim" data-note-status>Notes are durable; routing is saved with this workspace.</span>` +
      `<button class="lee-btn go" data-save-note disabled>Save note</button></div>`, e => {
        if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's') {
          e.preventDefault(); e.stopPropagation(); saveNote();
        }
      }, null, {className: 'lee-agent-memory-modal', storageKey: 'agent-memory-v2'});
    const list = $('[data-note-list]', box), form = $('[data-note-form]', box), empty = $('[data-note-empty]', box);
    const title = $('[data-note-title]', box), textHost = $('[data-note-text]', box), targets = $('[data-memory-targets]', box);
    const stateView = agentHost.createEditor(textHost, {doc: '', lang: 'markdown', lineNums: true, settings: {wordWrap: 'viewport'},
      placeholder: '# Context\n\nWrite only information that should influence a model…'});
    const noteText = {get value() { return agentHost.cm.getDoc(stateView); }, set value(value) { agentHost.cm.setDoc(stateView, String(value || '')); }};
    const labels = data.targets || {agent: 'Agent conversation', inline: 'Prompt cells', completion: 'Code completion'};
    let saveTimer = null, saving = null;
    const hasUnsavedChanges = () => !!active && (title.value !== (active.title || '') || noteText.value !== (active.text || ''));
    const mayLeaveNote = async () => !hasUnsavedChanges() || await confirmDialog(
      'discard unsaved note changes', 'Switch notes without saving the edits in the current note?', 'discard edits');
    const isSelected = (target, id) => selected[target]?.has(String(id));
    const selectionCount = id => Object.keys(labels).filter(target => isSelected(target, id)).length;
    const routeBadges = id => [['agent','A'],['inline','P'],['completion','C']]
      .map(([target, label]) => `<i class="${isSelected(target, id) ? 'active' : ''}" title="${esc(labels[target])}">${label}</i>`).join('');
    const paintList = (query = '') => {
      const q = query.trim().toLowerCase(), notes = (data.notes || []).filter(note =>
        !q || `${note.title} ${note.text}`.toLowerCase().includes(q));
      list.innerHTML = notes.map(note => `<button class="lee-memory-note-row${String(note.id) === String(active?.id) ? ' active' : ''}" data-note-id="${esc(note.id)}">` +
        `<span><strong>${esc(note.title || 'Untitled note')}</strong><small>${esc(String(note.text || '').replace(/\s+/g, ' ').slice(0, 110))}</small></span>` +
        `<b class="lee-memory-route-badges">${routeBadges(note.id)}</b></button>`).join('') ||
        '<div class="lee-memory-note-none">No matching notes.</div>';
      $$('[data-note-id]', list).forEach(row => row.onclick = async () => {
        const next = data.notes.find(note => String(note.id) === row.dataset.noteId);
        if (next === active || !await mayLeaveNote()) return; active = next; paint();
      });
    };
    const paintTargets = () => {
      targets.innerHTML = Object.entries(labels).map(([target, label]) => `<label class="lee-memory-target${active && isSelected(target, active.id) ? ' active' : ''}">` +
        `<input type="checkbox" data-memory-target="${target}"${active?.id && isSelected(target, active.id) ? ' checked' : ''}>` +
        `<span><strong>${esc(label)}</strong><small>${target === 'agent' ? 'conversation + tools' : target === 'inline' ? 'notebook prompt cells' : 'one-shot suggestions'}</small></span></label>`).join('');
      $$('[data-memory-target]', targets).forEach(input => input.onchange = async () => {
        const target = input.dataset.memoryTarget, id = String(active.id);
        if (!id) { $('[data-note-status]', box).textContent = 'Routing will activate when you save this note.'; paintBudget(); return; }
        input.checked ? selected[target].add(id) : selected[target].delete(id);
        try {
          const result = await post('/agent/memory/select', {target, ids: [...selected[target]]});
          $('[data-note-status]', box).textContent = `${labels[target]} updated · about ${result.tokens.toLocaleString()} context tokens`;
          paintList($('[data-note-filter]', box).value); paintTargets(); paintBudget();
        } catch (e) { input.checked = !input.checked; status(e.message || String(e), 'err'); }
      });
    };
    const paintBudget = () => {
      if (!active) { $('[data-memory-budget]', box).textContent = 'Select a note to route it.'; return; }
      const tokens = Math.max(1, Math.ceil(noteText.value.length / 4));
      $('[data-memory-budget]', box).innerHTML = active.id
        ? `<strong>~${tokens.toLocaleString()} tokens</strong><span>this note · active on ${selectionCount(active.id)} of 3 surfaces</span>`
        : `<strong>Unsaved note</strong><span>Save it before adding it to model context.</span>`;
    };
    const paint = () => {
      empty.hidden = !!active; form.hidden = !active;
      $('[data-save-note]', box).disabled = !active; $('[data-delete-note]', box).disabled = !active;
      if (active) { title.value = active.title || ''; noteText.value = active.text || ''; }
      paintList($('[data-note-filter]', box).value); paintTargets(); paintBudget();
    };
    const newNote = async () => { if (!await mayLeaveNote()) return; active = {id: '', title: '', text: ''}; paint(); title.focus(); };
    $('[data-new-note]', box).onclick = newNote; $('[data-empty-new]', box).onclick = newNote;
    $('[data-note-filter]', box).oninput = e => paintList(e.target.value);
    const button = $('[data-save-note]', box), noteStatus = $('[data-note-status]', box);
    saveNote = async () => {
      clearTimeout(saveTimer);
      if (!active || !hasUnsavedChanges()) return true;
      if (saving) return saving;
      const oldId = String(active.id || ''), nextTitle = title.value, nextText = noteText.value;
      const requestedTargets = $$('[data-memory-target]:checked', targets).map(input => input.dataset.memoryTarget);
      button.disabled = true; button.textContent = 'Saving…'; noteStatus.textContent = 'Saving changes…';
      saving = post('/agent/memory/save', {id: oldId, title: nextTitle, text: nextText, targets: requestedTargets}).then(result => {
        const id = String(result.id || oldId), previous = active;
        active = {...previous, id, title: nextTitle, text: nextText};
        const at = data.notes.findIndex(note => String(note.id) === oldId);
        if (at >= 0) data.notes[at] = active; else data.notes.push(active);
        for (const target of Object.keys(selected)) { selected[target].delete(oldId); if (requestedTargets.includes(target)) selected[target].add(id); }
        noteStatus.textContent = 'Saved'; button.textContent = 'Save note'; paintList($('[data-note-filter]', box).value); paintTargets(); paintBudget();
        agentHost.memoryLoaded = false; status(oldId ? 'memory note updated' : 'memory note created', 'ok'); return true;
      }).catch(e => {
        noteStatus.textContent = `Save failed · ${e.message || e}`; button.textContent = 'Retry save'; status(e.message || String(e), 'err'); return false;
      }).finally(() => { saving = null; button.disabled = !active; });
      return saving;
    };
    const markDirty = () => {
      noteStatus.textContent = 'Unsaved changes'; paintBudget(); clearTimeout(saveTimer);
      if (noteText.value.trim()) saveTimer = setTimeout(saveNote, 700);
    };
    title.oninput = markDirty;
    stateView.dom.addEventListener('input', markDirty);
    button.onclick = saveNote;
    box.beforeClose = async () => { clearTimeout(saveTimer); if (saving) await saving; return !hasUnsavedChanges() || await saveNote(); };
    $('[data-delete-note]', box).onclick = async () => {
      if (!active?.id || !await confirmDialog('delete memory note', `Delete “${active.title || 'Untitled note'}” from memory and every model route?`, 'delete')) return;
      await post('/agent/memory/delete', {id: active.id}); box.remove(); agentHost.memoryLoaded = false; status('memory note deleted', 'ok'); leeMemoryNotes();
    };
    paint();
  } catch (e) { status(e.message || String(e), 'err'); }
}
window.leeAgentMemory = leeAgentMemory;

function memoryRows(rows, kind = 'doc') {
  return rows.map((row, i) => {
    const title = row.breadcrumb || row.title || row.label || row.source || 'Untitled';
    const detail = row.source || row.summary || row.note || `${row.size || row.nchunks || 0} items`;
    const excerpt = (row.snippets || [])[0] || row.text || '';
    return `<button class="lee-memory-${kind}" data-i="${i}"><span class="lee-memory-index">${String(i + 1).padStart(2, '0')}</span>` +
      `<span class="lee-memory-copy"><strong>${esc(title)}</strong><small>${esc(detail)}</small>` +
      `${excerpt ? `<p>${esc(String(excerpt).replace(/\s+/g, ' ').slice(0, 220))}</p>` : ''}</span>` +
      `<span class="lee-memory-kind">${esc(row.kind || (kind === 'hit' ? 'section' : kind))}</span></button>`;
  }).join('');
}
async function leeMemoryHome() {
  const body = $('#memorybody'); if (!body) return;
  agentHost.memoryLoaded = 'loading'; agentHost.revealPane('right', true); leeRight('memory'); setMemoryView('sources');
  body.innerHTML = '<div class="lee-memory-empty">Opening durable memory…</div>';
  try {
    const d = await api('/memory/info'); agentHost.memoryLoaded = true; ag.memoryDocs = d.items || [];
    $('#memorystatus').textContent = `· ${d.documents} docs · ${d.nodes} sections`;
    body.innerHTML = ag.memoryDocs.length ? memoryRows(ag.memoryDocs) :
      '<div class="lee-memory-empty">Pages you read and research will be indexed here automatically.</div>';
    $$('.lee-memory-doc', body).forEach((row, i) => row.onclick = () => leeMemoryTree(ag.memoryDocs[i].id));
  } catch (e) { agentHost.memoryLoaded = false; body.innerHTML = `<div class="lee-err">${esc(e.message || e)}</div>`; }
}
async function leeMemoryPurge() {
  let docs = ag.memoryDocs;
  if (!docs) docs = (await api('/memory/info')).items || [];
  if (!docs.length) return status('memory is already empty', 'info');
  const m = modal(`<div class="lee-mhead">Purge memory<span class="sub">remove bad or irrelevant sources</span></div>` +
    `<div class="lee-memory-purge-list">${docs.map((doc, i) => `<label><input type="checkbox" value="${esc(doc.id)}">` +
      `<span><strong>${esc(doc.title)}</strong><small>${esc(doc.source || doc.kind || '')}</small></span></label>`).join('')}</div>` +
    `<div class="lee-mfoot"><button class="lee-btn warn" data-selected>purge selected</button>` +
    `<span class="lee-spacer"></span><button class="lee-btn warn" data-all>purge everything</button></div>`);
  $('[data-selected]', m).onclick = async () => {
    const ids = $$('input:checked', m).map(x => x.value);
    if (!ids.length) return status('select at least one source to purge', 'err');
    if (!await confirmDialog('purge selected memory', `Remove ${ids.length} document${ids.length === 1 ? '' : 's'} and all indexed sections?`, 'purge')) return;
    await post('/memory/purge', {ids}); m.remove(); agentHost.memoryLoaded = false; ag.memoryDocs = null; leeMemoryHome();
  };
  $('[data-all]', m).onclick = async () => {
    if (!await confirmDialog('purge all research memory', `Remove all ${docs.length} documents, trees, chunks and vectors?`, 'purge')) return;
    await post('/memory/purge', {ids: null}); m.remove(); agentHost.memoryLoaded = false; ag.memoryDocs = null; leeMemoryHome();
  };
}
async function leeMemorySearch() {
  const input = $('#memoryquery'), body = $('#memorybody'), q = input?.value.trim(); if (!q || !body) return;
  body.innerHTML = '<div class="lee-memory-empty">Searching remembered sections…</div>';
  try {
    const d = await api('/memory/search?q=' + encodeURIComponent(q)); ag.memoryHits = d.results || [];
    $('#memorystatus').textContent = `· ${d.note || ''}`;
    body.innerHTML = ag.memoryHits.length ? memoryRows(ag.memoryHits, 'hit') : '<div class="lee-memory-empty">Nothing remembered matches this query.</div>';
    $$('.lee-memory-hit', body).forEach((row, i) => row.onclick = () => leeMemoryRead(ag.memoryHits[i].node_id));
  } catch (e) { body.innerHTML = `<div class="lee-err">${esc(e.message || e)}</div>`; }
}
async function leeMemoryTree(doc) {
  const body = $('#memorybody'); if (!body) return;
  body.innerHTML = '<div class="lee-memory-empty">Reading document structure…</div>';
  const d = await api('/memory/toc?doc=' + encodeURIComponent(doc || ''));
  const flatten = (node, depth = 0, out = []) => {
    if (node) { out.push({...node, depth}); (node.children || []).forEach(child => flatten(child, depth + 1, out)); }
    return out;
  };
  const document = (d.documents || [])[0], rows = document ? flatten(document.tree) : [];
  body.innerHTML = `<div class="lee-memory-tree-actions"><button class="lee-btn lee-memory-back" onclick="leeMemoryHome()">Back to memory</button>` +
    `${document ? '<button class="lee-btn warn" data-forget>Forget document</button>' : ''}</div>` +
    `<div class="lee-memory-breadcrumb">${esc(document?.title || 'Document tree')}</div>` +
    (rows.length ? rows.map((row, i) => `<button class="lee-memory-hit lee-memory-tree" style="--depth:${row.depth}" data-node="${esc(row.id)}">` +
      `<span class="lee-memory-index">${String(i + 1).padStart(2, '0')}</span><span class="lee-memory-copy"><strong>${esc(row.title)}</strong>` +
      `<small>${esc(row.summary || `${row.nchunks || 0} chunks`)}</small></span><span class="lee-memory-kind">L${row.level}</span></button>`).join('') :
      '<div class="lee-memory-empty">No section tree is available.</div>');
  $$('[data-node]', body).forEach(row => row.onclick = () => leeMemoryRead(row.dataset.node));
  const forget = $('[data-forget]', body);
  if (forget) forget.onclick = async () => {
    if (!await confirmDialog('forget research document', `Remove ${document.title} and all of its remembered sections?`, 'forget')) return;
    await post('/memory/forget', {id: document.doc_id}); agentHost.memoryLoaded = false; leeMemoryHome();
  };
}
async function leeMemoryRead(node) {
  if (!node) return;
  const body = $('#memorybody'); body.innerHTML = '<div class="lee-memory-empty">Assembling the section…</div>';
  const d = await api('/memory/read?node=' + encodeURIComponent(node)), section = d.section || {};
  body.innerHTML = `<button class="lee-btn lee-memory-back" onclick="leeMemoryHome()">Back to memory</button>` +
    `<div class="lee-memory-breadcrumb">${esc(section.breadcrumb || section.title || node)}</div><article class="lee-memory-reader"></article>`;
  renderMarkdown($('.lee-memory-reader', body), section.text || 'No section text was retained.');
}
async function leeMemoryTopics() {
  const body = $('#memorybody'); if (!body) return;
  agentHost.memoryLoaded = 'loading'; agentHost.revealPane('right', true); leeRight('memory'); setMemoryView('topics'); body.innerHTML = '<div class="lee-memory-empty">Clustering remembered research…</div>';
  const d = await api('/memory/clusters'); ag.memoryTopics = d.clusters || [];
  $('#memorystatus').textContent = `· ${d.note || 'topics'}`;
  body.innerHTML = ag.memoryTopics.length ? memoryRows(ag.memoryTopics, 'topic') : `<div class="lee-memory-empty">${esc(d.note || 'Not enough remembered material to form topics.')}</div>`;
  $$('.lee-memory-topic', body).forEach((row, i) => row.onclick = () => {
    const topic = ag.memoryTopics[i], members = topic.members || [];
    body.innerHTML = `<button class="lee-btn lee-memory-back" onclick="leeMemoryTopics()">Back to topics</button>` +
      `<div class="lee-memory-breadcrumb">${esc(topic.label || 'Topic')} · ${topic.size || members.length} sections</div>` +
      (members.length ? memoryRows(members, 'hit') : '<div class="lee-memory-empty">No representative sections.</div>');
    $$('.lee-memory-hit', body).forEach((member, at) => member.onclick = () => leeMemoryRead(members[at].node_id));
  });
}
window.leeMemoryHome = leeMemoryHome; window.leeMemorySearch = leeMemorySearch; window.leeMemoryPurge = leeMemoryPurge;
window.leeMemoryTree = leeMemoryTree; window.leeMemoryRead = leeMemoryRead; window.leeMemoryTopics = leeMemoryTopics;

