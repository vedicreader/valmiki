/* A write pauses Rishi's tool loop until it is answered. The question stays in the agent pane
 * rather than a modal, so the rest of the IDE is usable while the model waits. The same event
 * serves agent-chat and notebook prompt-cell streams. */
import {$, $$, esc, api, post, status, renderMarkdown, compactPath, modal, textDialog, confirmDialog} from '../js/kit.js';
import {leeRight} from './budgets.js';
import {agentHost} from './host.js';
import {latestAgentTurn, leeAgentForkTurn, refreshAgentThreads, restoreAgentLive, turnBody, unfoldForApproval} from './live.js';
import {ag} from './panel.js';
import {readableDetail, updateAgentRunstrip} from './steer.js';

// These are the log's own nodes. A detached one is held forever.
export const approvalCards = new Map();
/* A checkpoint the run never answered keeps `proposed`, and a card holding one is never folded and
   never trimmed, so the turn it sits in cannot be collapsed for the rest of the session. `done`
   retires the ones its own stream raised: the run that asked is over, so nothing can answer them. */
export function retireCheckpoints(ids) {
  for (const id of ids || []) {
    const card = approvalCards.get(id);
    if (!card?.classList.contains('proposed')) continue;
    card.classList.remove('proposed'); card.classList.add('refused');
    $$('button', card).forEach(b => b.disabled = true);
    const state = $('.lee-checkpoint-title small', card);
    if (state) state.textContent = 'The turn ended before this ran';
  }
}
function proposalArgs(card) {
  const schema = card._schema, args = {};
  for (const field of (schema?.fields || [])) {
    const input = card.querySelector(`[data-field="${CSS.escape(field.name)}"]`);
    if (!input) continue;
    if (field.kind === 'boolean') args[field.name] = input.checked;
    else {
      const raw = input._leeView ? agentHost.cm.getDoc(input._leeView) : input.value;
      if (!field.required && raw === '') continue;
      if (field.kind === 'integer') args[field.name] = Number.parseInt(raw, 10);
      else if (field.kind === 'number') args[field.name] = Number.parseFloat(raw);
      else args[field.name] = raw;
      if (field.required && (args[field.name] === '' || Number.isNaN(args[field.name])))
        throw new Error(`${field.name} is required`);
    }
  }
  return args;
}
function proposalFields(schema, args) {
  return (schema?.fields || []).map(field => {
    const value = args[field.name] ?? field.default ?? '', required = field.required ? ' required' : '';
    if (field.kind === 'boolean')
      return `<label class="lee-proposal-check"><input type="checkbox" data-field="${esc(field.name)}"${value ? ' checked' : ''}>${esc(field.name)}</label>`;
    const type = field.kind === 'integer' || field.kind === 'number' ? 'number' : 'text';
    const control = field.multiline
      ? `<div class="lee-proposal-field-editor" data-field="${esc(field.name)}" data-value="${esc(value)}"${required}></div>`
      : `<input class="lee-input" type="${type}" data-field="${esc(field.name)}" value="${esc(value)}"${required}>`;
    return `<label><span>${esc(field.name)}${field.required ? ' *' : ''}</span>${control}</label>`;
  }).join('');
}
function mountProposalEditors(card) {
  $$('[data-field-editor], .lee-proposal-field-editor', card).forEach(host => {
    if (host._leeView) return;
    const field = host.dataset.field || '', tool = $('[data-tool]', card)?.value || '';
    const lang = field === 'commands' ? 'json' : field === 'text' || field === 'source'
      ? agentHost.langOf('', proposalArgsSafe(card).path || '') : tool.includes('python') ? 'python' : 'text';
    host._leeView = agentHost.createEditor(host, {doc: host.dataset.value || '', lang, lineNums: true});
  });
}
function proposalArgsSafe(card) { try { return proposalArgs(card); } catch (_) { return {}; } }
function groupedToolOptions(schemas, selected) {
  const groups = new Map();
  for (const schema of schemas) {
    if (!groups.has(schema.group)) groups.set(schema.group, []);
    groups.get(schema.group).push(schema);
  }
  return [...groups].map(([group, tools]) => `<optgroup label="${esc(group)}">` + tools.map(tool =>
    `<option value="${esc(tool.name)}"${tool.name === selected ? ' selected' : ''}>${esc(tool.name)} — ${esc(tool.description)}</option>`).join('') + '</optgroup>').join('');
}
function previewContent(preview) {
  if (!preview) return '<div class="lee-proposal-empty">No preview available.</div>';
  if (preview.kind === 'diff') return `<div class="lee-diff">${agentHost.diffHtml(preview.rows || [])}</div>`;
  return `<pre class="lee-proposal-code">${esc(preview.text || '')}</pre>`;
}
async function refreshProposalPreview(card) {
  const host = $('[data-preview-body]', card), error = $('.lee-proposal-error', card);
  if (!host) return;
  try {
    const args = card._previewArgs || proposalArgs(card), tool = $('[data-tool]', card).value;
    card._previewArgs = null;
    host.innerHTML = '<div class="lee-proposal-loading"><i></i><i></i><i></i><span>Building dry-run preview</span></div>';
    const d = await post('/agent/tool-preview', {tool, args, thread: ag.thread || ''});
    host.innerHTML = previewContent(d.preview); error.textContent = '';
  } catch (e) { host.innerHTML = ''; error.textContent = e.message || String(e); }
}
function checkpointExplanation(tool, args = {}, schema = {}) {
  const target = args.path ? compactPath(args.path) : args.cwd ? compactPath(args.cwd) : '';
  if (tool === 'run_shell') return {
    title: 'Command approval',
    lead: `The agent wants to run a shell command${target ? ` in ${target}` : ''}. Nothing runs until you approve.`,
    detail: 'Commands can read files, use the network, start processes, and change data. Open “Edit call” to review or change the command.'};
  if (tool === 'run_python') return {
    title: 'Python approval', lead: 'The agent wants to execute Python in the live workspace. Nothing runs until you approve.',
    detail: 'This can change variables and process state. Open “Edit call” to review or change the code.'};
  if (schema.changes_state) return {
    title: 'Change approval', lead: `The agent wants to change ${target || 'the workspace'}. Nothing changes until you approve.`,
    detail: 'Review the preview, edit the call if needed, then choose how far the agent may continue.'};
  return {title: 'Tool approval', lead: `The agent wants to use ${tool}. Nothing runs until you approve.`,
    detail: 'This is a read-only call. You can review its inputs now and run it again later with different inputs.'};
}
export function checkpointResult(detail, ok, secs) {
  const result = document.createElement('details'); result.className = 'lee-checkpoint-result';
  const summary = document.createElement('summary');
  summary.innerHTML = `<strong>${ok ? 'Completed' : 'Failed'}</strong><span>${Number(secs || 0).toFixed(1)}s · View output</span>`;
  const pre = document.createElement('pre'); pre.textContent = readableDetail(detail);
  result.append(summary, pre); return result;
}
export function showApproval(a, destination = null) {
  if (!a?.id || approvalCards.has(a.id)) return;
  agentHost.revealPane('right', true); leeRight('agent');
  if (ag.view && ag.view !== 'live') restoreAgentLive();
  const log = $('#agentlog'); if (!log) return;
  /* `pollApproval` and a notebook prompt cell both call this with no destination, and a checkpoint
     that lands beside the turns instead of in the one it belongs to is a checkpoint nobody finds. */
  const host = destination || (ag.timeline?.root?.isConnected ? ag.timeline.root : null)
    || turnBody(latestAgentTurn()) || log;
  const schemas = a.schemas || [], byName = new Map(schemas.map(s => [s.name, s]));
  const card = document.createElement('section');
  card.className = 'lee-approval lee-proposal proposed'; card.dataset.id = a.id; card.dataset.tool = a.tool; card.tabIndex = -1;
  // the row this checkpoint replaces is in the turn it belongs to, not the last one anywhere in the log
  const pendingRow = [...$$('.lee-agent-step.pending', host.closest('.lee-agent-turn') || log)].at(-1);
  if (pendingRow) { pendingRow.hidden = true; card._activityRow = pendingRow; }
  card._schema = byName.get(a.tool) || {name: a.tool, fields: Object.keys(a.args || {}).map(name => ({name, kind: 'string'}))};
  const explanation = checkpointExplanation(a.tool, a.args, card._schema);
  card.innerHTML = `<header class="lee-approval-head"><span class="lee-proposal-mark" aria-hidden="true"></span>` +
    `<span class="lee-checkpoint-title"><strong>${esc(explanation.title)}</strong><small><b>${esc(a.control || 'guided')}</b> paused for your decision</small></span>` +
    `<kbd>↵ run&nbsp;&nbsp; ⇧↵ don’t run&nbsp;&nbsp; E edit&nbsp;&nbsp; S steer</kbd></header>` +
    `<div class="lee-checkpoint-intro"><strong>${esc(explanation.lead)}</strong><span>${esc(explanation.detail)}</span></div>` +
    `<div class="lee-approval-summary"><span>Agent’s reason</span>${esc(a.summary || '')}</div>` +
    `<nav class="lee-proposal-tabs"><button class="active" data-tab="preview">What will happen</button>` +
    `<button data-tab="call">Edit call</button><button data-tab="json">Raw JSON</button></nav>` +
    `<section class="lee-proposal-pane active" data-pane="preview"><div data-preview-body>` +
    `<pre class="lee-proposal-code">${esc(a.preview || '')}</pre></div></section>` +
    `<section class="lee-proposal-pane" data-pane="call"><div class="lee-proposal-fields">` +
    `<label><span>Tool</span><select class="lee-select" data-tool>${groupedToolOptions(schemas, a.tool)}</select></label>` +
    `<div data-schema-fields>${proposalFields(card._schema, a.args || {})}</div></div></section>` +
    `<section class="lee-proposal-pane" data-pane="json"><textarea class="lee-input lee-proposal-json" data-args spellcheck="false"></textarea></section>` +
    `<div class="lee-proposal-error" role="alert"></div>` +
    `<div class="lee-proposal-steer"><label><span>If you don’t run it, tell the agent what to do instead</span>` +
    `<input class="lee-input" data-note placeholder="Optional: use another approach, inspect a different file…"></label></div>` +
    `<footer class="lee-approval-actions"><button class="lee-btn warn" data-ok="0">Don’t run</button>` +
    `<span class="lee-spacer"></span><label class="lee-run-policy-label"><span>After this</span>` +
    `<select class="lee-select" data-run-policy title="how far the agent may continue without another pause">` +
    `<option value="once">Pause again</option><option value="count:3">Allow next 3 tools</option>` +
    `<option value="until_write">Allow reads, pause before changes</option><option value="reads">Allow read-only tools</option>` +
    `<option value="until_failure">Continue until a tool fails</option><option value="completion">Continue until finished</option>` +
    `<option value="approve_session">Trust changes for this session</option></select></label>` +
    `<button class="lee-btn go" data-ok="1">Run this tool</button></footer>`;
  const raw = $('[data-args]', card); raw.value = JSON.stringify(a.args || {}, null, 2); mountProposalEditors(card);
  const switchTab = name => {
    $$('.lee-proposal-tabs button', card).forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    $$('.lee-proposal-pane', card).forEach(p => p.classList.toggle('active', p.dataset.pane === name));
    if (name === 'json') { try { raw.value = JSON.stringify(proposalArgs(card), null, 2); } catch (_) {} }
    if (name === 'preview') refreshProposalPreview(card);
  };
  $$('.lee-proposal-tabs button', card).forEach(b => b.onclick = () => {
    if (b.dataset.tab === 'preview') { try { card._previewArgs = argsFromUI(); } catch (_) {} }
    switchTab(b.dataset.tab);
  });
  $('[data-tool]', card).onchange = e => {
    card._schema = byName.get(e.target.value) || {name: e.target.value, fields: []};
    $('[data-schema-fields]', card).innerHTML = proposalFields(card._schema, {});
    mountProposalEditors(card); switchTab('call');
  };
  const argsFromUI = () => {
    if ($('[data-pane="json"]', card).classList.contains('active')) {
      const parsed = JSON.parse(raw.value || '{}');
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('arguments must be a JSON object');
      return parsed;
    }
    return proposalArgs(card);
  };
  const answer = async ok => {
    const buttons = $$('button', card), error = $('.lee-proposal-error', card);
    // Two different HITL decisions, not one form with a boolean. Approval executes the displayed
    // call, so it must parse and validate edits. Rejection executes no call, so malformed or
    // missing arguments must never trap the user.
    let args = null, tool = null, changed = false;
    if (ok) {
      try {
        args = argsFromUI(); tool = $('[data-tool]', card).value || a.tool;
        changed = tool !== a.tool || JSON.stringify(args) !== JSON.stringify(a.args || {});
        error.textContent = '';
      } catch (e) { switchTab('call'); error.textContent = e.message || String(e); return; }
    }
    buttons.forEach(b => b.disabled = true);
    try {
      const note = $('[data-note]', card).value || '';
      if (ok) {
        const spec = $('[data-run-policy]', card).value, [policy, count] = spec.split(':');
        if (!['once', 'approve_session'].includes(policy))
          await post('/agent/run-policy', {policy, count: Number(count || 1)});
      }
      const session = ok && $('[data-run-policy]', card).value === 'approve_session';
      await post('/agent/approve', {id: a.id, ok, note, session, tool, args, thread: ag.thread || ''});
      card.classList.remove('proposed'); card.classList.add(ok ? 'running' : 'refused'); if (changed) card.classList.add('edited');
      const checkpointState = $('.lee-checkpoint-title small', card);
      if (checkpointState) checkpointState.textContent = ok
        ? (changed ? 'You edited the call · running now' : 'You approved it · running now')
        : 'You chose not to run it';
      const resolvedTool = ok ? tool : a.tool;
      card.dataset.tool = resolvedTool; card.dataset.resolvedTool = resolvedTool;
      card.dataset.retryable = String(!!byName.get(resolvedTool)?.retryable);
      $('.lee-approval-actions', card).innerHTML = `<span>${ok ? (changed ? 'Edited call is running' : 'Running approved tool') : (note ? 'Not run · your direction was sent to the agent' : 'Not run')}</span>` +
        (ok && card.dataset.retryable === 'true' ? `<button class="lee-btn" data-retry title="Run this read-only tool again without changing the conversation">Run again</button>` : '') +
        (ok && ['edit_file','create_file'].includes(resolvedTool) ? `<button class="lee-btn warn" data-rollback disabled>Undo file change</button>` : '');
      $('[data-retry]', card)?.addEventListener('click', () => retryProposal(card, resolvedTool, args));
      const rollback = $('[data-rollback]', card);
      if (rollback) { setTimeout(() => rollback.disabled = false, 700); rollback.onclick = () => rollbackProposal(card, a.id); }
      status(ok ? `${changed ? 'edited and ran' : 'ran'} ${resolvedTool}` : `rejected ${a.tool}`, ok ? 'ok' : 'err');
    } catch (e) { buttons.forEach(b => b.disabled = false); error.textContent = String(e.message || e); }
  };
  $('[data-ok="1"]', card).onclick = () => answer(true);
  $('[data-ok="0"]', card).onclick = () => answer(false);
  card.onkeydown = e => {
    if (e.target.matches('input, textarea, select') && e.key !== 'Escape' && !(e.key === 'Enter' && (e.metaKey || e.ctrlKey))) return;
    if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); answer(false); }
    else if (e.key === 'Enter') { e.preventDefault(); answer(true); }
    else if (/^[1-6]$/.test(e.key)) { e.preventDefault(); $('[data-run-policy]', card).selectedIndex = Number(e.key) - 1; }
    else if (e.key.toLowerCase() === 'e') { e.preventDefault(); switchTab('call'); card.querySelector('[data-field], [data-tool]')?.focus(); }
    else if (e.key.toLowerCase() === 's') { e.preventDefault(); $('[data-note]', card).focus(); }
    else if (e.key === 'Escape') switchTab('preview');
  };
  host.appendChild(card); approvalCards.set(a.id, card);
  unfoldForApproval(card);      // focus and the ↵ / E / S keys do nothing inside a folded turn
  card.focus(); log.scrollTop = log.scrollHeight;
  refreshProposalPreview(card); updateAgentRunstrip({waiting: a.tool});
  status(`${a.tool} is waiting at a checkpoint`, 'err');
}

function decodeResponseEntities(text) {
  const area = document.createElement('textarea'); let value = String(text || '');
  for (let i = 0; i < 3 && /&(?:#\d+|#x[\da-f]+|amp|lt|gt|quot|apos);/i.test(value); i++) {
    area.innerHTML = value; const decoded = area.value;
    if (decoded === value) break; value = decoded;
  }
  return value;
}
function editableResponse(raw) {
  const tools = '(?:run_shell|run_python|inspect_python|grep|search_code|similar_code|list_files|ls|view_file|create_file|edit_file|replace_text|view_cell|edit_cell|add_cell|web_search|read_url|research|delegate_[\\w-]+)';
  let text = decodeResponseEntities(raw)
    .replace(/\n?\s*<details>\s*<summary>result<\/summary>[\s\S]*?<\/details>\s*/gi, '\n');
  text = text.split('\n').filter(line =>
    !new RegExp(`^\\s*-\\s*[^\\w<]{0,6}\\s*<code>${tools}\\s*\\(`, 'i').test(line) &&
    !/^\s*(?:#{1,4}\s*)?what i did\s*$/i.test(line)).join('\n');
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

function markTurnUndone(out, bar, files, revise) {
  /* `rollback_turn` restores files and does not touch model history, so the turn is marked rather
     than deleted. The agent still carries it.

     Scoped to the turn's card. This used to walk siblings until it hit a `.lee-user-message`, and
     the bar sits either inside the timeline or beside it depending on whether the turn ended on
     prose or on a tool call, so the marked range differed between two turns that were undone the
     same way. */
  const card = bar.closest('.lee-agent-turn');
  for (const node of (card ? $$('.lee-agent-turn-body > *', card) : [out])) {
    if (node !== bar) node.classList.add('lee-turn-undone');   // the bar carries the explanation
  }
  card?.classList.add('lee-turn-undone-card');
  const note = document.createElement('span');
  note.textContent = `${files} file${files === 1 ? '' : 's'} restored · the agent still remembers this turn`;
  bar.classList.add('lee-turn-undone-bar');
  bar.replaceChildren(note, ...(revise ? [revise] : []));
  return bar;
}

/* The pane is round-tripped through `innerHTML` by the history toggle, a rehydrate, a resume and
   every thread switch, and a bound listener does not survive that. The turn these controls act on
   is written into the DOM, and one delegated listener on the log dispatches them. */
/* A turn that ended on a tool call has no prose, and its files are still its own to restore, so
   the bar is not gated on there being an answer. Every button says why it is unavailable, and
   `known` distinguishes "this turn changed nothing" from "this process no longer holds a boundary
   for it", which is what a turn from before a restart or from past `MAX_CHECKPOINTS` looks like. */
/* An unavailable control is muted and states its reason on the row. `.lee-btn` has no disabled
   appearance in the stylesheet, so a dead button was pixel-identical to a live one down to the
   pointer cursor, and the only explanation was a `title` nobody hovers in the packaged app: the
   report was "I click edit and undo, nothing happens". The reason is carried here rather than in
   `lee-ide.css` so the bar explains itself wherever it is painted. */
const REVISION_MUTED = 'opacity:.4;cursor:default';
const REVISION_NOTE = 'flex:1 0 100%;order:9;margin-top:5px;color:var(--lee-fg4);font:9px/1.45 var(--lee-mono);white-space:normal';
export function addResponseRevision(out, turnId, raw, capabilities = {}) {
  if (!turnId || !out) return;
  const bar = document.createElement('div'); bar.className = 'lee-response-revision';
  const files = capabilities.files || [], gone = capabilities.known === false;
  const unheld = 'this conversation was not run in this session, so there is no turn boundary to act on';
  const controls = [
    ['revise', 'lee-btn', 'Edit what agent remembers', !!capabilities.revisable,
     'Correct this answer and continue the next turn from your version',
     gone ? unheld : 'this turn failed before an assistant response entered model history'],
    ['unsay', 'lee-btn', 'Undo from conversation', !!capabilities.branchable,
     'Forget this turn: branch the conversation to just before it, keeping it in history',
     gone ? unheld : 'this turn has no captured boundary to branch at'],
    ['fork', 'lee-btn', 'Branch from here', !!capabilities.branchable,
     'Start a branch that continues from this turn, leaving this conversation as it is',
     gone ? unheld : 'this turn has no captured boundary to branch at'],
    ['undo', 'lee-btn warn', 'Restore files', !!capabilities.undoable,
     `Restore ${files.length} file${files.length === 1 ? '' : 's'} changed by this turn`,
     gone ? unheld : 'this turn made no reversible file changes']];
  const off = controls.filter(c => !c[3]);
  bar.dataset.turn = turnId;
  bar.dataset.revisable = capabilities.revisable ? '1' : '';
  bar.dataset.undoable = capabilities.undoable ? '1' : '';
  bar.dataset.files = String(files.length);
  bar.innerHTML = `<span>turn ${esc(turnId.split(':').at(-1))}</span>` +
    controls.map(([key, cls, label, on, why, cant]) =>
      `<button class="${cls}" data-${key} title="${esc(on ? why : `Unavailable: ${cant}`)}"` +
      `${on ? '' : ` disabled style="${REVISION_MUTED}"`}>${esc(label)}</button>`).join('') +
    // one shared sentence when nothing is held for the turn, rather than the same one three times
    (off.length ? `<small data-unavailable style="${REVISION_NOTE}">${esc(gone ? `Unavailable: ${unheld}`
      : off.map(c => `${c[2]} is unavailable: ${c[5]}`).join(' · '))}</small>` : '');
  /* Last in the turn's body rather than straight after the answer. A turn that ended on prose has
     that prose inside `.lee-agent-timeline`, so `out.after` put the bar in there too -- inside the
     element `markTurnUndone` dims, which dimmed the bar's own explanation of why. The answer is
     marked instead, because a class survives the `innerHTML` round-trips this pane takes and a
     sibling relationship does not. */
  out.classList.add('lee-turn-answer'); out.dataset.answerFor = turnId;
  const body = out.closest('.lee-agent-turn-body');
  if (body) body.appendChild(bar); else out.after(bar);
  bindResponseRevisions(bar.closest('#agentlog') || $('#agentlog'));
}

/* What the reply said, recovered from the DOM rather than from a closure: `renderMarkdown` keeps
   the markdown it rendered, which is the one copy that survives an `innerHTML` round-trip. */
/* Paired by turn id rather than by position. One card can hold two answers: a feed left following
   after `done` paints a turn another tab or the CLI started into the card already on screen, and
   `.lee-turn-answer` alone then resolved both bars to the first one. */
const turnAnswer = bar => {
  const card = bar.closest('.lee-agent-turn') || document, id = bar.dataset.turn || '';
  return (id && $(`.lee-turn-answer[data-answer-for="${CSS.escape(id)}"]`, card))
    || $('.lee-turn-answer', card) || bar.previousElementSibling;
};
export function turnReplyText(bar) {
  const reply = turnAnswer(bar);
  return reply?.dataset?.markdown ?? reply?.textContent ?? '';
}

function responseTurn(bar) {
  return {turnId: bar.dataset.turn || '', out: turnAnswer(bar),
          raw: turnReplyText(bar), files: Number(bar.dataset.files || 0),
          revisable: !!bar.dataset.revisable, undoable: !!bar.dataset.undoable};
}

async function unsayTurn(bar) {
  const {turnId, out, files, undoable, revisable} = responseTurn(bar);
  const short = turnId.split(':').at(-1);
  /* Undoing the conversation and restoring the files are separate promises. This one is only
     about what the model remembers, so it must never claim to have changed anything on disk. */
  const also = undoable && files
    ? await confirmDialog('Undo from conversation',
        `Branch this conversation to just before turn ${short}. Also restore ${files} file${files === 1 ? '' : 's'} it changed?`,
        'undo and restore files', 'undo conversation only')
    : await confirmDialog('Undo from conversation',
        `Branch this conversation to just before turn ${short}. The turn stays in history.`,
        'undo conversation');
  if (!also) return;
  try { await post('/agent/undo-turn', {thread: ag.thread, turn_id: turnId}); }
  catch (e) { return status(e.message || String(e), 'err'); }
  let restored = null;
  if (also === true) {
    try { restored = await post('/agent/rollback-turn', {turn_id: turnId, thread: ag.thread || ''}); }
    catch (e) { status(`undone from the conversation; these files were not restored: ${e.message || e}`, 'err'); }
  }
  markTurnUndone(out, bar, (restored?.paths || []).length, revisable ? $('[data-revise]', bar) : null);
  noteHeldRestores(await agentHost.reloadRestored(restored?.paths || []));
  await refreshAgentThreads();
  status(restored ? `undone from the conversation · ${(restored.paths || []).length} file(s) restored`
                  : 'undone from the conversation; files left as they are', 'ok');
}

/* Naming what was left alone matters more here than anywhere else: a tab held back still holds the
   version from before the restore, and the person is the only one who can decide between the two. */
const noteHeldRestores = held => held.length && status(
  `${held.length} file${held.length === 1 ? '' : 's'} with unsaved edits ${held.length === 1 ? 'was' : 'were'} not reloaded: `
  + held.map(p => p.split('/').pop()).join(', '), 'err');

async function restoreTurnFiles(bar) {
  const {turnId, out, revisable} = responseTurn(bar);
  {
    try {
      const tx = await api('/agent/turn-transaction?turn_id=' + encodeURIComponent(turnId) +
        (ag.thread ? '&thread=' + encodeURIComponent(ag.thread) : ''));
      const files = tx.transaction.files || [], warning = (tx.transaction.irreversible || []).length
        ? `\n\nCannot undo external effects: ${tx.transaction.irreversible.join(', ')}` : '';
      if (!await confirmDialog('Restore files changed by this turn', `Restore ${files.length} file${files.length === 1 ? '' : 's'} changed by this turn?${warning}`, 'restore files')) return;
      const d = await post('/agent/rollback-turn', {turn_id: turnId, thread: ag.thread || ''});
      // Marked before the files are reloaded, so a reload that raises still shows the turn undone.
      markTurnUndone(out, bar, (d.paths || []).length, revisable ? $('[data-revise]', bar) : null);
      noteHeldRestores(await agentHost.reloadRestored(d.paths || []));
      status('turn changes rolled back', 'ok');
    } catch (e) { status(e.message || String(e), 'err'); }
  }
}

function reviseTurn(bar) {
  const {turnId, out, raw} = responseTurn(bar);
  {
    const original = editableResponse(raw);
    const box = modal(`<div class="lee-mhead">Shape the next turn<span class="sub">edit what the agent remembers, not the files it touched</span></div>` +
      `<section class="lee-revision-explainer"><strong>You are correcting the conversation.</strong>` +
      `<span>Tools will not run again and files will not change. The agent’s next reply will continue as if it gave your edited answer. The original stays in history.</span></section>` +
      `<div class="lee-revision-layout"><label class="lee-revision-editor"><span>Answer the agent should remember <b>Markdown</b></span>` +
      `<textarea class="lee-keyedit" data-revision spellcheck="true" aria-label="answer the agent should remember"></textarea></label>` +
      `<section class="lee-revision-preview"><header><span>How it will read</span><small>live preview</small></header>` +
      `<div class="lee-md" data-revision-preview></div></section></div>` +
      `<div class="lee-mfoot"><button class="lee-btn" data-cancel>Keep original</button><span class="lee-spacer"></span>` +
      `<span class="lee-dim">Creates a new conversation branch</span><button class="lee-btn go" data-apply>Use edited answer</button></div>`,
      null, null, {className: 'lee-response-editor-modal', storageKey: 'response-editor'});
    const editor = $('[data-revision]', box), preview = $('[data-revision-preview]', box);
    editor.value = original;
    let previewTimer = null;
    const paint = () => { clearTimeout(previewTimer); previewTimer = setTimeout(() => renderMarkdown(preview, editor.value), 90); };
    editor.addEventListener('input', paint); paint();
    $('[data-cancel]', box).onclick = () => box.remove();
    $('[data-apply]', box).onclick = async () => {
      const text = editor.value.trim();
      if (!text) return status('the remembered answer cannot be empty', 'err');
      const d = await post('/agent/revise', {turn_id: turnId, text});
      renderMarkdown(out, text); out.dataset.userRevised = '1';
      bar.innerHTML = `<span>Your edited answer now guides the next turn · ${esc(d.branch_id)}</span>`;
      box.remove(); status('edited answer is now the active conversation branch', 'ok');
    };
  }
}

/* One listener, on the log element itself. Its contents are replaced constantly and it is not, so
   a listener here outlives every repaint where a per-button binding does not. */
function bindResponseRevisions(log) {
  if (!log || log._leeRevisionsBound) return;
  log._leeRevisionsBound = true;
  log.addEventListener('click', e => {
    const button = e.target.closest?.('.lee-response-revision button'); if (!button) return;
    const bar = button.closest('.lee-response-revision');
    if (!bar?.dataset.turn || button.disabled) return;
    if (button.hasAttribute('data-unsay')) unsayTurn(bar);
    else if (button.hasAttribute('data-undo')) restoreTurnFiles(bar);
    else if (button.hasAttribute('data-revise')) reviseTurn(bar);
    else if (button.hasAttribute('data-fork')) leeAgentForkTurn(bar.dataset.turn, ag.thread);
  });
}

async function retryProposal(card, tool, args) {
  const copy = structuredClone(args), number = card.querySelectorAll('.lee-proposal-branch').length + 1;
  try {
    const d = await post('/agent/retry-tool', {tool, args: copy, thread: ag.thread || ''});
    const row = document.createElement('section'); row.className = 'lee-proposal-branch';
    row.innerHTML = `<header><strong>Rerun ${number}</strong><span>${esc(tool)} completed with the inputs shown below</span>` +
      `<button class="lee-btn" data-edit-retry>Edit inputs and run</button></header>` +
      `<details class="lee-checkpoint-result"><summary><strong>Result</strong><span>View output</span></summary><pre>${esc(d.result)}</pre></details>` +
      `<footer><span>This result is not in the conversation yet.</span><button class="lee-btn" data-use-result>Use in next message</button></footer>`;
    $('[data-edit-retry]', row).onclick = async () => {
      const text = await textDialog('Run tool with different inputs', 'Arguments as JSON', JSON.stringify(copy, null, 2)); if (!text) return;
      try { await retryProposal(card, tool, JSON.parse(text)); }
      catch (e) { status(e.message || String(e), 'err'); }
    };
    $('[data-use-result]', row).onclick = () => {
      const prompt = $('#agentprompt'); if (!prompt) return;
      const result = String(d.result || '').slice(0, 20_000);
      prompt.value = `Use this rerun of ${tool} to reconsider your previous answer. Explain what changed and what I should do next.\n\n<rerun-result tool="${tool}">\n${result}\n</rerun-result>`;
      prompt.dispatchEvent(new Event('input', {bubbles: true})); prompt.focus();
      row.scrollIntoView({block: 'nearest'}); status('rerun result added to your next message; review it before sending', 'ok');
    };
    card.appendChild(row); status(`rerun ${number} completed; previous conversation is unchanged`, 'ok');
  } catch (e) { status(e.message || String(e), 'err'); }
}
async function rollbackProposal(card, id) {
  try {
    const d = await post('/agent/rollback-tool', {id, thread: ag.thread || ''});
    card.classList.add('rolled-back'); $('[data-rollback]', card).disabled = true;
    status(`${d.path.split('/').pop()} rolled back`, 'ok');
    if (d.path === agentHost.currentPath && !$('.lee-tab.active')?.classList.contains('dirty')) await agentHost.takeDiskVersion(d.path);
  } catch (e) { status(e.message || String(e), 'err'); }
}
export function runPolicyLabel(policy) {
  if (!policy) return '';
  const names = {once: 'next call', count: `next ${policy.remaining}`, until_write: 'until next write',
    reads: 'read-only calls', until_failure: 'until failure', completion: 'to completion'};
  return names[policy.kind] || policy.kind;
}
