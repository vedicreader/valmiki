/* How much work one turn may do. `auto` lets ramabana size it from the prompt; a number pins it.
   The fields are written back from the answer, so a refusal leaves the box showing what is
   actually in force rather than the rejected text. */
import {$, $$, api, post, status} from '../js/kit.js';
import {agentHost} from './host.js';
import {stickAgentLog} from './live.js';
import {leeMemoryNotes} from './memory.js';
import {ag} from './panel.js';
import {paintAgentAttachments} from './steer.js';

/* The highlighted range, queued as context for the next turn. Sent as text rather than as
   `path:from-to` for the agent to read, because the buffer may be unsaved and what you highlighted
   is what you meant. */
function leeAgentSelection() {
  const v = agentHost.currentEditor();
  if (!v) return status('put the cursor in some code first', 'err');
  const sel = v.state.selection.main;
  if (sel.empty) return status('select the code you want the agent to see', 'err');
  const doc = v.state.doc, from = doc.lineAt(sel.from).number, to = doc.lineAt(sel.to).number;
  const path = agentHost.currentPath || 'untitled', name = path.split('/').pop() || 'untitled';
  ag.selections.push({
    label: `${name}:${from}${to > from ? '–' + to : ''}`,
    path,
    ref: {kind: 'selection', path, from, to, text: doc.sliceString(sel.from, sel.to)},
  });
  agentHost.revealPane('right', true); leeRight('agent'); paintAgentAttachments();
  $('#agentprompt')?.focus();
  status(`selection queued for the agent · ${from}${to > from ? '–' + to : ''}`, 'ok');
}
window.leeAgentSelection = leeAgentSelection;

async function leeAgentBudget() {
  const tools = $('#toolbudget'), steps = $('#stepbudget');
  try {
    const d = await post('/agent/budget', {tools: tools?.value.trim(), steps: steps?.value.trim()});
    if (tools) tools.value = String(d.tools);
    if (steps) steps.value = String(d.steps);
    const quick = $('#agenttoolbudget'); if (quick) quick.value = String(d.tools);
    status(d.note, 'ok');
  } catch (e) {
    status(e.message || String(e), 'err');
    try { const d = await api('/agent/budget/state');
      if (tools) tools.value = String(d.tools); if (steps) steps.value = String(d.steps);
      const quick = $('#agenttoolbudget'); if (quick) quick.value = String(d.tools);
    } catch (_) { /* leave the boxes alone rather than blank them on a second failure */ }
  }
}
window.leeAgentBudget = leeAgentBudget;

async function leeAgentQuickBudget() {
  const quick = $('#agenttoolbudget'), tools = $('#toolbudget');
  if (tools) tools.value = quick?.value || 'auto';
  await leeAgentBudget();
}
window.leeAgentQuickBudget = leeAgentQuickBudget;

async function paintAgentBudget() {
  const el = $('#agentbudgetstatus'); if (!el) return;
  try {
    const d = await api('/agent/status');
    el.textContent = `${d.tool_calls || 0} / ${d.tool_limit || '—'}`;
    el.title = `${d.tool_calls || 0} of ${d.tool_limit || 'unknown'} tool calls used this turn`;
  } catch (_) {}
}
/* This used to be called straight from the stream's `activity` handler, so a turn making a hundred
   tool calls asked the server a hundred times for a counter that reads "12 / 40". Leading edge, so
   the first call of a turn still paints at once; trailing, so the number on screen is the last one. */
const BUDGET_GAP = 1000;
let budgetTimer = 0, budgetAt = -Infinity;
export function refreshAgentBudget() {
  const wait = BUDGET_GAP - (performance.now() - budgetAt);
  if (wait <= 0) { budgetAt = performance.now(); return paintAgentBudget(); }
  clearTimeout(budgetTimer);
  budgetTimer = setTimeout(() => { budgetAt = performance.now(); paintAgentBudget(); }, wait);
}

async function leeLocalMultimodal(enabled) {
  const box = $('#localmultimodal');
  const d = await post('/agent/settings', {local_multimodal: !!enabled});
  if (!d.ok && box) box.checked = !enabled;
  status(d.ok ? d.note : (d.error || 'local multimodal setting failed'), d.ok ? 'ok' : 'err');
}
window.leeLocalMultimodal = leeLocalMultimodal;

async function leeWorkspaceRepoWrites(enabled) {
  const box = $('#workspace-repo-writes');
  try {
    const d = await post('/agent/workspace-repo-writes', {enabled: !!enabled});
    if (!d.ok && box) box.checked = !enabled;
    status(d.ok ? d.note : (d.error || 'workspace repository write setting failed'), d.ok ? 'ok' : 'err');
  } catch (e) {
    if (box) box.checked = !enabled;
    status(String(e.message || e), 'err');
  }
}
window.leeWorkspaceRepoWrites = leeWorkspaceRepoWrites;

async function leeAgentReadOutside(enabled) {
  const box = $('#agent-read-outside');
  try {
    const d = await post('/agent/read-outside', {enabled: !!enabled});
    if (!d.ok && box) box.checked = !enabled;
    status(d.ok ? d.note : (d.error || 'read-outside setting failed'), d.ok ? 'ok' : 'err');
  } catch (e) {
    if (box) box.checked = !enabled;
    status(String(e.message || e), 'err');
  }
}
window.leeAgentReadOutside = leeAgentReadOutside;

/* Three-valued, so the control is a select and the recovery is putting the old value back rather
   than flipping a box. The policy is the workspace's: the model is never asked to respect it. */
async function leeVaultPii(policy) {
  const sel = $('#vault-pii'), was = sel ? sel.dataset.was || 'off' : 'off';
  try {
    const d = await post('/agent/vault-pii', {pii: policy});
    if (!d.ok && sel) sel.value = was; else if (sel) sel.dataset.was = policy;
    status(d.ok ? d.note : (d.error || 'vault privacy setting failed'), d.ok ? 'ok' : 'err');
  } catch (e) {
    if (sel) sel.value = was;
    status(String(e.message || e), 'err');
  }
}
window.leeVaultPii = leeVaultPii;

async function leeSubagentWrites(enabled) {
  const box = $('#subagent-writes');
  try {
    const d = await post('/agent/subagent-writes', {enabled: !!enabled});
    if (!d.ok && box) box.checked = !enabled;
    status(d.ok ? d.note : (d.error || 'sub-agent write setting failed'), d.ok ? 'ok' : 'err');
  } catch (e) {
    if (box) box.checked = !enabled;
    status(String(e.message || e), 'err');
  }
}
window.leeSubagentWrites = leeSubagentWrites;

function leeAgentExpand() { leeRight('agent'); agentHost.expandPane('right'); }
window.leeAgentExpand = leeAgentExpand;

export function leeRight(which) {
  const right = $('#right'); if (!right) return;
  try { localStorage.setItem('lee-right-view', which); } catch (_) {}
  right.classList.toggle('right-agent', which === 'agent');
  right.classList.toggle('right-vars', which === 'vars');
  right.classList.toggle('right-memory', which === 'memory');
  $$('.lee-righttab', right).forEach(b => {
    const active = b.dataset.right === which;
    b.classList.toggle('active', active); b.setAttribute('aria-selected', String(active));
  });
  if (which === 'agent') requestAnimationFrame(() => stickAgentLog());
  if (which === 'memory' && !agentHost.memoryLoaded) leeMemoryNotes();
}
window.leeRight = leeRight;

// Every memory view is fetched asynchronously into one `#memorybody`, so a slow answer must not
// paint over the view you switched to. Each switch takes the next token, and a fetch that finds the
// token moved drops its result.
