/* Following a feed is sticking to its bottom; it is not dragging a reader back down. Every paint in
   this pane used to write `scrollTop = scrollHeight` unconditionally, and to write it *before* the
   markdown render it had just asked for had landed, so the pane was measured short, jumped when the
   text arrived, and took the reader with it however far up they had scrolled to read.

   Stickiness is sampled from the reader's own scrolling: once they leave the bottom nothing the
   stream paints moves them, and scrolling back down opts in again. `force` is for the moves that
   are the reader's, not the stream's: taking the live pane back from History, and sending a turn. */
import {$, $$, esc, api, post, status, renderMarkdown, prefGet, prefSet, modal, textDialog, confirmDialog} from '../js/kit.js';
import {addResponseRevision, approvalCards} from './approvals.js';
import {agentHost} from './host.js';
import {agentListen, agentTimeline, reduceAgentTimeline, setAgentStatus} from './media.js';
import {ag} from './panel.js';
import {pollApproval, renderAgentStep, updateAgentRunstrip} from './steer.js';

const BOTTOM_SLACK = 60;
const nearAgentBottom = log =>
  !log.clientHeight || log.scrollHeight - log.scrollTop - log.clientHeight <= BOTTOM_SLACK;
export function stickAgentLog(log, force = false) {
  log = log || $('#agentlog'); if (!log) return;
  if (!log._leeStickBound) {
    log._leeStickBound = true; log._leeStick = true;
    log.addEventListener('scroll', () => { log._leeStick = nearAgentBottom(log); }, {passive: true});
  }
  if (force) log._leeStick = true;
  if (log._leeStick) log.scrollTop = log.scrollHeight;
}
/* A render lands a frame or more after the call that asked for it, so the pane is re-stuck when the
   content is actually there. `renderMarkdown` announces every one of its renders.

   Only the reply prose, not every render inside the pane: a checkpoint's proposal editor and the
   agent-state box re-render as a person types in them, and re-pinning the log to the bottom on
   every keystroke is the exact thing this change is here to stop. */
document.addEventListener('lee-markdown-rendered', e => {
  const log = $('#agentlog'), el = e.target;
  if (!log || !log.contains(el)) return;
  if (!el.closest('.lee-agent-turn') || el.closest('.lee-approval, .lee-proposal')) return;
  stickAgentLog(log);
});

/* The live pane is set aside as its own nodes, not as `innerHTML`. Serialising a long conversation
   and parsing it back paid for the whole log on every History toggle, and threw away every code
   surface the replies had mounted: the fragment keeps them alive and costs one pointer.
   `null` means "the live pane is whatever is on screen", which is the case until History takes it. */
function rememberAgentLive() {
  const log = $('#agentlog');
  if (!log || (ag.view && ag.view !== 'live')) return;
  const held = document.createDocumentFragment();
  held.append(...log.childNodes);
  ag.live = held;
}
export function restoreAgentLive() {
  const log = $('#agentlog'); if (!log) return;
  log.replaceChildren(ag.live || document.createDocumentFragment());
  ag.live = null; ag.view = 'live';
  $('#agenthistory')?.classList.remove('active');
  stickAgentLog(log, true);
}
export function userMessage(text) {
  const raw = String(text || '').trim(), long = raw.length > 900 || raw.split('\n').length > 14;
  const card = document.createElement('section'); card.className = 'lee-user-message';
  const head = document.createElement('header');
  head.innerHTML = '<strong>You</strong><span>request</span>'; card.appendChild(head);
  if (!long) {
    const body = document.createElement('div'); body.className = 'lee-user-message-body';
    body.textContent = raw; card.appendChild(body); return card;
  }
  const lines = raw.split('\n');
  const preview = lines.slice(0, 6).join('\n').slice(0, 620).trimEnd();
  const body = document.createElement('div'); body.className = 'lee-user-message-body preview';
  body.textContent = preview + (preview.length < raw.length ? '\n…' : ''); card.appendChild(body);
  const more = document.createElement('details'); more.className = 'lee-user-message-more';
  more.innerHTML = `<summary>Show full request <span>${raw.length.toLocaleString()} characters · ${lines.length} lines</span>` +
    `<i class="lee-agent-step-chevron" aria-hidden="true"></i></summary><pre></pre>`;
  more.querySelector('pre').textContent = raw; card.appendChild(more);
  return card;
}
export function usageMeta(usage, label = '', model = '') {
  if (!usage && !label) return null;
  const u = usage || {}, parts = [];
  if (Number(u.total)) parts.push(`${Number(u.total).toLocaleString()} tokens`);
  if (Number(u.input)) parts.push(`${Number(u.input).toLocaleString()} input`);
  if (Number(u.output)) parts.push(`${Number(u.output).toLocaleString()} output`);
  if (Number(u.cached)) parts.push(`${Number(u.cached).toLocaleString()} cached`);
  if (Number(u.reasoning)) parts.push(`${Number(u.reasoning).toLocaleString()} reasoning`);
  if (Number(u.cost)) parts.push(`$${Number(u.cost).toFixed(4)}`);
  if (!parts.length && label) parts.push(label);
  if (model || u.model) parts.push(String(model || u.model).split('/').pop());
  const el = document.createElement('footer'); el.className = 'lee-turn-usage';
  el.setAttribute('aria-label', 'Token usage and estimated cost for this turn');
  el.innerHTML = `<span class="lee-turn-usage-mark" aria-hidden="true">∑</span>` + parts.map((part, i) => `<span${i === parts.length - 1 ? ' class="model"' : ''}>${esc(part)}</span>`).join('');
  return el;
}

/* One turn is one card, so what has been read can be folded away. Everything a turn paints goes
   in its body: the live path used to append the prompt, the progress strip, the timeline and the
   closing diffs as flat siblings of the log, which is why `markTurnUndone` had to guess a turn's
   extent by walking to the next `.lee-user-message`. */
/* Scoped to whatever session was painted, which is not always the live thread: history view paints
   another conversation's turns while `ag.thread` still names the live one. */
const foldScope = () => $('#agentlog')?.dataset.foldScope || ag.thread || 'default';
const foldKey = () => `lee-agent-folded:${foldScope()}`;
const foldedTurns = () => { try { return new Set(JSON.parse(localStorage.getItem(foldKey()) || '[]')); } catch { return new Set(); } };
const saveFolded = set => { try { localStorage.setItem(foldKey(), JSON.stringify([...set].slice(-400))); } catch {} };

export function agentTurnCard({prompt = '', model = '', route = '', turnId = ''} = {}) {
  const card = document.createElement('article'); card.className = 'lee-agent-turn';
  if (turnId) card.dataset.turn = turnId;
  const meta = [model, route].filter(Boolean).join(' · ');
  card.innerHTML = `<header class="lee-agent-turn-head"><button class="lee-agent-turn-fold" type="button"` +
    ` aria-expanded="true" title="fold this turn. Hold alt for every turn">` +
    `<i class="lee-agent-step-chevron" aria-hidden="true"></i></button>` +
    `<span class="lee-agent-turn-title"></span><span class="lee-agent-turn-meta">${esc(meta)}</span></header>` +
    `<div class="lee-agent-turn-body"></div>`;
  // textContent, not the template: a prompt is whatever was typed
  $('.lee-agent-turn-title', card).textContent = String(prompt).replace(/\s+/g, ' ').trim() || '(no prompt)';
  return card;
}
export const turnBody = card => card && $('.lee-agent-turn-body', card);
/* A checkpoint the agent is blocked on must never sit behind a fold: its buttons and its ↵ / E / S
   keys are the only way the run continues, and a folded body cannot be focused or clicked. */
export const turnAwaitingApproval = card => !!$('.lee-approval.proposed', card);
export const unfoldForApproval = node => foldAgentTurn(node?.closest?.('.lee-agent-turn'), false);

export function foldAgentTurn(card, folded) {
  if (!card || (folded && turnAwaitingApproval(card))) return;
  card.classList.toggle('folded', folded);
  $('.lee-agent-turn-fold', card)?.setAttribute('aria-expanded', String(!folded));
  turnBody(card)?.setAttribute('aria-hidden', String(folded));
  const id = card.dataset.turn; if (!id) return;
  const set = foldedTurns(); folded ? set.add(id) : set.delete(id); saveFolded(set);
}
export const agentTurnCards = () => $$('.lee-agent-turn', $('#agentlog') || document);
export function foldAgentTurns(folded) { for (const card of agentTurnCards()) foldAgentTurn(card, folded); }
/* What has been answered is not what is being read. A conversation of any length is mostly turns
   already dealt with, so every one before the newest is folded away: on a paint, and again when the
   next turn begins. A turn holding a checkpoint is never folded, because `foldAgentTurn` refuses. */
export function foldOlderTurns(log, keep = 1) {
  const cards = $$('.lee-agent-turn', log || $('#agentlog') || document);
  cards.slice(0, Math.max(0, cards.length - keep)).forEach(card => foldAgentTurn(card, true));
}
/* Folding hides a turn from layout; it does not free it. Every turn of a session stays in the live
   pane holding its rendered replies and one CodeMirror view per code block in them, so a long day's
   conversation is hundreds of live views the pane carries through every paint. The pane keeps the
   last `LIVE_TURNS` and History holds the rest, which is where a conversation already lives.

   A turn holding a checkpoint is never dropped: its buttons are the only way that run continues. */
export const LIVE_TURNS = 30;
export function trimAgentLog(log, keep = LIVE_TURNS) {
  log = log || $('#agentlog');
  if (!log || (ag.view && ag.view !== 'live')) return 0;
  const cards = $$('.lee-agent-turn', log);
  let dropped = 0;
  for (const card of cards.slice(0, Math.max(0, cards.length - keep))) {
    if (turnAwaitingApproval(card)) continue;
    agentHost.dropEditors(card); card.remove(); dropped += 1;
  }
  if (!dropped) return 0;
  for (const [id, node] of approvalCards) if (!node.isConnected) approvalCards.delete(id);
  if (!$('.lee-agent-trimmed', log)) {
    const note = document.createElement('div'); note.className = 'lee-agent-trimmed';
    note.textContent = 'Earlier turns in this conversation are in History.';
    log.prepend(note);
  }
  return dropped;
}
/* The newest turn is the one being read, so it is never folded from storage: a turn folded before
   a resume would otherwise hide the answer a person came back for. */
function applyStoredFolds(log) {
  const cards = $$('.lee-agent-turn', log), stored = foldedTurns();
  cards.forEach((card, i) => { if (i < cards.length - 1 && stored.has(card.dataset.turn)) foldAgentTurn(card, true); });
}
/* `renderTurns` paints durable turns only, so on a resync the turn in flight is appended after it
   has already decided which card is newest. Re-applied once that card exists. */
export const refoldAfter = log => applyStoredFolds(log);
/* One listener on the log, bound from `initAgentComposer` rather than from a paint: a conversation
   with no turns paints nothing, and the log element itself outlives every repaint. */
export function bindAgentTurnFolds(log) {
  if (!log || log._leeFoldsBound) return;
  log._leeFoldsBound = true;
  log.addEventListener('click', e => {
    const button = e.target.closest?.('.lee-agent-turn-fold'); if (!button) return;
    const card = button.closest('.lee-agent-turn'), folded = !card.classList.contains('folded');
    if (e.altKey) foldAgentTurns(folded); else foldAgentTurn(card, folded);
  });
}
export const latestAgentTurn = () => agentTurnCards().at(-1);
/* the turn being read: whichever card holds focus, or the newest, which is where focus is when it
   is in the composer. Only for what a person aimed at; anything the server sends goes to the
   newest, or a checkpoint would land in whichever old turn happened to hold focus */
export const currentAgentTurn = () => document.activeElement?.closest?.('.lee-agent-turn') || latestAgentTurn();

export function renderTurns(log, turns, heading, fold = true) {
  if (heading) log.insertAdjacentHTML('beforeend', `<div class="lee-vgroup">${esc(heading)}</div>`);
  for (const turn of (turns || [])) {
    const card = agentTurnCard({prompt: turn.prompt, model: turn.model, route: turn.plan?.route || 'direct',
                               turnId: turn.turn_id || ''});
    const item = turnBody(card);
    item.appendChild(userMessage(turn.prompt));
    let closing = null;
    if ((turn.timeline || []).length) {
      const root = document.createElement('div'); root.className = 'lee-agent-timeline'; item.appendChild(root);
      const paint = agentTimeline(root);
      const paintActivity = part => {
        paint.activity(part.data);
        for (const child of part.children || []) paintActivity(child);
      };
      for (const part of reduceAgentTimeline(turn.timeline)) {
        if (part.kind === 'prose') closing = paint.chunk(part.text);
        else if (part.kind === 'activity') paintActivity(part);
        // what the person said mid-turn, in the place they said it
        else if (part.kind === 'steer' && part.data?.text) paint.append(userMessage(part.data.text));
      }
      closing = closing || root;
    } else {
      if ((turn.activity || []).length) {
        const steps = document.createElement('div'); steps.className = 'lee-agent-steps';
        for (const activity of turn.activity) {
          const row = document.createElement('details'); renderAgentStep(row, activity); steps.appendChild(row);
        }
        item.appendChild(steps);
      }
      const reply = document.createElement('div'); reply.className = 'lee-reply'; item.appendChild(reply);
      renderMarkdown(reply, turn.reply || '');
      closing = reply;
    }
    /* The revision bar used to be added by the live `done` handler alone, so undo, restore and
       edit-what-the-agent-remembers vanished on every history toggle, resume, thread switch and
       resync. It is painted from the turn record here, and the server says whether the operations
       behind it can still be reached in this process. */
    addResponseRevision(closing, turn.turn_id, turn.reply || '', turn.capabilities || {});
    const usage = usageMeta(turn.usage, turn.usage_label, turn.model); if (usage) item.appendChild(usage);
    log.appendChild(card);
  }
  applyStoredFolds(log);
  if (fold) foldOlderTurns(log);
}
/* A summarised title arrives as `Title: Ramabana CLI ASCII`, quotes and all, and stored ones keep
   the prefix after the storage point is fixed, so every display cleans it. */
export const titleText = t => String(t || '').replace(/\s+/g, ' ').trim()
  .replace(/^title\s*:\s*/i, '').replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
const sessionTime = s => s.started ? new Date(s.started * 1000).toLocaleString() : s.id.replace(/^agent_/, '');
/* `/agent/history` lists conversations without their turns, since Leela and the CLI share one log.
   The turns of the one being opened come from here, and `count` is what the list knows about the
   rest. */
export const sessionTurns = async id => {
  if (!id) return [];
  try { return (await api('/agent/history/session?id=' + encodeURIComponent(id))).turns || []; }
  catch (e) { status(String(e.message || e), 'err'); return []; }
};
/* The three preferences this pane keeps, each of which used to live only in `localStorage` and so
   came back at its default whenever the app was launched on a different port.

   settings.json answers with a default for every key, so `agentHost.prefs` cannot say whether a value was
   chosen, and `prefAdopt` reads that default as a choice and migrates nothing. `origins` names the
   layer each key came from, and only `default` means nobody has saved one. The control's own
   default is saved where it differs from settings', which is how the history filter stays on for
   someone who never asked for it off. */
const AGENT_PREFS = {notify: ['lee-agent-notify', v => v === 'on', false],
                     reasoning: ['lee-agent-reasoning', v => v, ''],
                     historyLeelaOnly: ['leeHistoryLeelaOnly', v => v !== '0', true]};
async function adoptAgentPrefs() {
  for (const [key, [legacy, parse, dflt]] of Object.entries(AGENT_PREFS)) {
    if ((agentHost.settingsMeta?.origins?.agent?.[key] || 'default') !== 'default') continue;
    const old = localStorage.getItem(legacy), value = old === null ? dflt : parse(old);
    if (value !== agentHost.prefs?.agent?.[key]) await prefSet('agent', key, value);
  }
}
let agentPrefsAdopted;
// Once per session, and not before `loadSettings` has said what is already saved.
export const agentPrefsReady = () =>
  agentHost.settingsMeta ? (agentPrefsAdopted ||= adoptAgentPrefs()) : Promise.resolve();
/* Leela and the ramabana CLI append to one log, and only Leela marks the sessions it started, so
   anything unmarked reads as the CLI's, including Leela's history from before the mark. */
/* Checked unless it has been turned off: one log holds both, most of it is the CLI's, and the
   list a person opens is their own work. Asking the server means the CLI's are not grouped and
   shipped only to be filtered out here. */
const leelaOnly = () => prefGet('agent', 'historyLeelaOnly', true);
const shownSessions = groups => leelaOnly() ? groups.filter(s => s.app === 'leela') : groups;
async function historyGroups() {
  await agentPrefsReady();
  const d = await api('/agent/history' + (leelaOnly() ? '' : '?everything=1'));
  ag.historyHidden = d.hidden || 0;
  return d.sessions || [];
}
/* The inline panel's telemetry, in a surface of its own. It used to be appended to the bottom of a
   conversation in the agent's History view, which is a different feature's transcript: the only way
   to reach it was to open a conversation nobody wanted, and the two preferences that decide whether
   any of this is recorded lived there too. A `stale` is neither an accept nor a reject, so it is
   named rather than counted. */
const COMPLETION_VERDICT = {replace: 'accepted', discard: 'rejected', stale: 'selection moved',
                            abandon: 'abandoned', error: 'model failed', ask: 'still open',
                            reply: 'answered, no verdict'};
const COMPLETION_CODE = {kept: '', 'not kept': 'the code was not kept for this one',
                         withheld: 'turn on "keep the code" to read the selection and the suggestion'};
/* Two causes, one shape: nothing carried an id before the browser began minting them, and an ask
   can fall outside the window this list covers while its verdict stays inside it. */
const COMPLETION_ORPHAN = 'not joined to its ask: recorded before asks carried an id, or its ask is outside this window';
const percent = r => r === null || r === undefined ? '—' : Math.round(r * 100) + '%';
const completionWhen = at => at ? new Date(at * 1000).toLocaleString() : '';

function completionRow(r) {
  const row = document.createElement('details'); row.className = 'lee-completion-row';
  row.dataset.completion = r.kind || '';
  row.innerHTML = `<summary><strong></strong><span>${esc(r.model || 'unknown')}` +
    `${r.lang ? ' · ' + esc(r.lang) : ''}${r.ms ? ' · ' + esc(r.ms) + 'ms' : ''}` +
    `${r.at ? ' · ' + esc(completionWhen(r.at)) : ''}</span>` +
    `<em>${esc(COMPLETION_VERDICT[r.kind] || r.kind || '')}</em></summary>` +
    `<div class="lee-completion-detail"></div>`;
  // textContent throughout: an instruction and a suggestion are whatever the person and the model wrote
  $('summary strong', row).textContent = r.instruction || (r.orphan ? '(unlinked event)' : '(no instruction)');
  const detail = $('.lee-completion-detail', row);
  if (r.path) { const p = document.createElement('div'); p.className = 'lee-dim'; p.textContent = r.path; detail.appendChild(p); }
  const pair = (label, text) => {
    const box = document.createElement('div'); box.className = 'lee-completion-code';
    const h = document.createElement('h5'); h.textContent = label; box.appendChild(h);
    const pre = document.createElement('pre'); pre.textContent = text; box.appendChild(pre);
    detail.appendChild(box);
  };
  if (r.text) pair('selection', r.text);
  if (r.reply) pair('suggestion', r.reply);
  for (const note of [COMPLETION_CODE[r.code], r.orphan ? COMPLETION_ORPHAN : ''].filter(Boolean)) {
    const n = document.createElement('div'); n.className = 'lee-dim'; n.textContent = note; detail.appendChild(n);
  }
  return row;
}

async function showCompletions() {
  const m = modal(`<div class="lee-mhead">Inline completions<span class="sub">what you asked, what came back, and what you did with it</span></div>` +
    `<div class="lee-completions" id="completionsbody"><div class="lee-dim">reading the log…</div></div>`,
    null, null, {className: 'lee-completions-modal', storageKey: 'completions'});
  await paintCompletions(m);
  return m;
}

/* A paint in flight when a purge lands would repaint the selections the purge deleted, so each one
   takes a ticket and only the newest writes. */
let completionsPaint = 0;
async function paintCompletions(m) {
  const body = $('#completionsbody', m); if (!body) return;
  const mine = ++completionsPaint;
  let d;
  try { d = await api('/ai/completions?days=30'); }
  catch (e) {
    if (mine === completionsPaint) body.innerHTML = `<div class="lee-dim">completions unavailable: ${esc(e.message || e)}</div>`;
    return;
  }
  if (mine !== completionsPaint) return;
  const s = d.summary || {}, events = d.events || [];
  body.innerHTML = `<div class="lee-weight-group"><h4>What Leela keeps about your completions</h4><div class="lee-weight-row">` +
    `<label>keep<select class="lee-select" data-completion-pref="telemetry">` +
    ['on', 'off'].map(v => `<option value="${v}"${v === d.telemetry ? ' selected' : ''}>${v}</option>`).join('') +
    `</select></label>` +
    `<label class="lee-settings-toggle"><input type="checkbox" data-completion-pref="snippets"` +
    `${d.snippets ? ' checked' : ''}><span>keep the code</span></label>` +
    `<button class="lee-btn" data-completions-purge type="button">purge log</button></div>` +
    `<div class="lee-dim lee-weight-note">${esc(s.asks || 0)} asked · ${esc(s.answered || 0)} answered · ` +
    `${esc(s.replaced || 0)} accepted · ${esc(s.discarded || 0)} rejected · accepted ${percent(s.accept_rate)}` +
    `${d.telemetry === 'off' ? ' · recording is off, so nothing new is kept' : ''}` +
    `${d.snippets ? '' : ' · the code is not being kept, so rows show the question and the verdict only'}` +
    `<br>${esc(d.dir || '')}</div></div>` +
    `<div class="lee-weight-group"><h4>Accepted per model</h4><div class="lee-completion-models">` +
    ((s.models || []).map(x => `<div data-completion-model="${esc(x.model)}"><strong>${esc(x.model)}</strong>` +
      `<span>${esc(x.replaced || 0)} accepted · ${esc(x.discarded || 0)} rejected` +
      `${x.stale ? ' · ' + esc(x.stale) + ' stale' : ''}</span><em>${percent(x.accept_rate)}</em></div>`).join('') ||
      `<div class="lee-dim">nothing decided yet</div>`) + `</div></div>` +
    `<div class="lee-weight-group"><h4>Every ask</h4><div class="lee-completion-log"></div></div>`;
  const log = $('.lee-completion-log', body);
  if (!events.length) log.innerHTML = `<div class="lee-dim">nothing recorded yet</div>`;
  else events.forEach(r => log.appendChild(completionRow(r)));
  $$('[data-completion-pref]', body).forEach(el => el.onchange = async () => {
    const value = el.type === 'checkbox' ? el.checked : el.value;
    try {
      await post('/settings/save', {scope: 'user', section: 'completions',
                                    values: {[el.dataset.completionPref]: value}});
      await paintCompletions(m);   // `snippets` decides what the route will hand over at all
    } catch (e) { status(e.message || String(e), 'err'); }
  });
  $('[data-completions-purge]', body).onclick = async () => {
    if (!await confirmDialog('Purge the completion log',
        'Delete every recorded completion event? The conversations are not touched.', 'purge')) return;
    const out = await post('/ai/completions/purge', {});
    status(`removed ${out.removed} completion event file${out.removed === 1 ? '' : 's'}`, 'ok');
    // repainted from the server, never from anything held here: the point of a purge is that the
    // selections and suggestions are gone, and a cached copy on the page would outlive them
    await paintCompletions(m);
  };
}
window.showCompletions = showCompletions;

async function showHistorySession(group, groups) {
  const log = $('#agentlog'); if (!log) return; agentHost.dropEditors(log); log.innerHTML = ''; approvalCards.clear();
  log.dataset.foldScope = group?.id || '';   // these turns are that session's, whatever thread is live
  const index = document.createElement('nav'); index.className = 'lee-history-index';
  /* A conversation is known by what it was about, so its name is the whole option. The time
     identifies one that has no name yet, which is every conversation before its first turn
     finished. */
  const all = groups || [], shown = shownSessions(all);
  const hidden = (all.length - shown.length) || ag.historyHidden || 0;
  const options = shown.map(s =>
    `<option value="${esc(s.id)}"${s.id === group?.id ? ' selected' : ''}>` +
    `${esc(titleText(s.title) || sessionTime(s))}</option>`).join('');
  const turns = group ? await sessionTurns(group.id) : [];
  const resumable = !!group && !group.id.startsWith('legacy-') && turns.length > 0;
  index.innerHTML = `<div class="lee-history-heading"><strong>History</strong>` +
    `<span>one continuous model context per session</span></div>` +
    `<select class="lee-select lee-history-select" aria-label="agent history session">${options}</select>` +
    `<label class="lee-history-filter" title="Hide conversations this Leela did not start. History from before this filter existed is unmarked and hides with them.">` +
    `<input type="checkbox" class="lee-history-leelaonly"${leelaOnly() ? ' checked' : ''}> Leela only` +
    `${hidden ? ` <span class="lee-dim">(${hidden} hidden)</span>` : ''}</label>` +
    `<span class="lee-history-runs">${group?.code || 0} kernel run${group?.code === 1 ? '' : 's'}</span>` +
    (resumable ? `<button class="lee-btn go lee-history-resume" title="Continue this conversation">Resume</button>` : '');
  index.querySelector('select')?.addEventListener('change', e =>
    showHistorySession(all.find(s => s.id === e.target.value), all));
  index.querySelector('.lee-history-leelaonly')?.addEventListener('change', async e => {
    await prefSet('agent', 'historyLeelaOnly', e.target.checked);
    // The CLI's conversations are not in `all` when the box was checked, so this asks again.
    const groups = await historyGroups(), left = shownSessions(groups);
    showHistorySession(left.find(s => s.id === group?.id) || left[0], groups);
  });
  index.querySelector('.lee-history-resume')?.addEventListener('click', () => leeAgentResume(group));
  log.appendChild(index);
  if (!group) {
    return log.insertAdjacentHTML('beforeend', '<div class="lee-dim">(no sessions yet)</div>');
  }
  log.insertAdjacentHTML('beforeend', `<div class="lee-history-session-head">` +
    `<strong>${esc(titleText(group.title) || sessionTime(group))}</strong>` +
    `<span>${titleText(group.title) ? `${esc(sessionTime(group))} · ` : ''}` +
    `${group.context_continues ? 'context continued across these turns' : 'separate context'}</span></div>`);
  renderTurns(log, turns, 'conversation');
  if (group.code || group.id.startsWith('agent_')) {
    const transcript = await api('/agent/transcript?session=' + encodeURIComponent(group.id));
    if ((transcript.cells || []).length) {
      log.insertAdjacentHTML('beforeend', '<div class="lee-vgroup">code executed in this session</div>');
      renderSessionCells(log, transcript);
    }
  }
  log.scrollTop = 0;
}
/* The live pane is DOM only, so a reload, an htmx swap of the shell, or a switch to a conversation
   this tab has never shown leaves it blank while the turns are still on disk. They come from the
   server and replace what is on screen, because painting into what is already there duplicated a
   transcript on the way back to it. */
async function paintAgentThread(id) {
  const log = $('#agentlog'); if (!log) return null;
  const d = await api('/agent/thread/turns' + (id ? '?thread=' + encodeURIComponent(id) : ''));
  const welcome = $('.lee-agent-welcome', log);
  approvalCards.clear();
  log.dataset.foldScope = '';
  agentHost.dropEditors(log);
  if ((d.turns || []).length) { log.innerHTML = ''; renderTurns(log, d.turns, titleText(d.title) || 'conversation'); }
  else log.innerHTML = welcome ? welcome.outerHTML : '';
  ag.view = 'live'; $('#agenthistory')?.classList.remove('active');
  trimAgentLog(log);   // a conversation of any length arrives here whole
  // Nothing to set aside: the live pane is what was just painted into the log.
  ag.live = null; stickAgentLog(log, true);
  return d;
}
/* Conversations live in the agent's log, not in this process, so a fresh one holds none: opening
   the app after working in a browser showed an empty pane while the work sat on disk. An empty pane
   picks the newest conversation back up, which is what "where was I" means. */
async function rehydrateAgentLive() {
  const log = $('#agentlog');
  if (!log || ag.view === 'history' || agentHost.busy || ag.hydrating) return;
  ag.hydrating = true;
  try {
    const d = await paintAgentThread(ag.thread || '');
    if (!(d?.turns || []).length) await resumeLatestAgent();
  }
  catch (e) { /* an empty pane beats a boot that dies on a cold agent */ }
  finally { ag.hydrating = false; }
}
function paintResumed(d) {
  const log = $('#agentlog');
  if (log) {
    log.dataset.foldScope = ''; agentHost.dropEditors(log); log.innerHTML = '';
    renderTurns(log, d.turns || [], 'resumed conversation');
    stickAgentLog(log, true);
  }
  ag.view = 'live'; ag.live = null;
  $('#agenthistory')?.classList.remove('active');
}
async function resumeLatestAgent() {
  // Nothing saved is the first run, not a failure, so this never speaks up about it.
  try {
    await agentPrefsReady();   // the saved filter, not the default, decides what boot may open
    /* Read under the same filter as the history list: a pane that hides the CLI's conversations
       cannot open one of them on boot. With the filter off, `latest` is the log's newest again. */
    const d = await post('/agent/resume', {session: 'latest', everything: !leelaOnly()});
    if (!(d.turns || []).length) return;
    paintResumed(d);
    status(`picked up ${titleText(d.title) || d.session}`, 'ok');
  } catch (_) {}
}
export function warmAgentHistory() {
  // Nothing is painted from it: this is the read that makes the next one cheap.
  historyGroups().catch(() => {});
}
async function leeAgentHistory() {
  if (ag.view === 'history') return restoreAgentLive();
  rememberAgentLive(); ag.view = 'history'; $('#agenthistory')?.classList.add('active');
  /* `rememberAgentLive` moves the nodes out rather than copying them, so from here until the
     history is painted the only copy of the conversation is in `ag.live`. A history read
     that fails must put it back, or the pane is left blank with the work in a variable. */
  try {
    const all = await historyGroups();
    await showHistorySession(shownSessions(all)[0], all);
    return;
  } catch (e) {
    restoreAgentLive();
    return status(`history unavailable: ${e.message || e}`, 'err');
  }
}
async function leeAgentResume(group) {
  if (!group) return;
  if (agentHost.busy) return status('the model is already working', 'err');
  try {
    const d = await post('/agent/resume', {session: group.id});
    paintResumed(d);
    $('#agentprompt')?.focus();
    status(d.note || `resumed ${d.session}`, 'ok');
  } catch (e) { status(String(e.message || e), 'err'); }
}
function rememberAgentThread() {
  if (!ag.thread) return;
  ag.threadDrafts.set(ag.thread, $('#agentprompt')?.value || '');
}
/* A conversation with nothing said in it has no name, and its id is a bare timestamp. Say what it
   is and when it started instead. */
function threadName(t) {
  const named = titleText(t.title); if (named) return named;
  const at = /(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(t.id || '');
  return at ? `new conversation · ${at[4]}:${at[5]}` : 'new conversation';
}
function threadLabel(t) {
  return `${threadName(t)} · ${t.state}${t.unread ? ` · ${t.unread} new` : ''}${t.muted ? ' · muted' : ''}`;
}
/* One card per conversation, with its own controls, rather than a select plus four buttons that
   all acted on whichever one happened to be showing. */
function paintAgentThreads(d) {
  const rows = d.threads || [];
  ag.threadRows = rows; ag.thread = d.active || ag.thread;
  const count = $('#agentthreadcount'); if (count) count.textContent = String(rows.length);
  const waiting = (d.attention?.waiting || []).length, unread = d.attention?.unread || 0;
  const toggle = $('#agentthreads');
  if (toggle) {
    toggle.classList.toggle('wants', !!waiting);
    toggle.classList.toggle('unread', !waiting && !!unread);
    toggle.title = waiting ? `${waiting} conversation(s) waiting for you`
      : unread ? `${unread} unread turn(s) elsewhere` : 'every live conversation';
  }
  const list = $('#agentthreadlist');
  if (list) {
    list.innerHTML = rows.map(t => {
      const live = t.id === d.active;
      return `<article class="lee-thread-card${live ? ' active' : ''}${t.state === 'waiting' ? ' wants' : ''}"` +
        ` role="option" aria-selected="${live}" tabindex="0" data-thread="${esc(t.id)}">` +
        `<header><strong>${esc(threadName(t))}</strong>` +
        `<span class="lee-thread-state ${esc(t.state)}">${esc(t.state)}</span></header>` +
        `<footer><span>${t.unread ? `${t.unread} new` : (live ? 'on screen' : 'idle')}` +
        `${t.branch && t.branch !== 'main' ? ` · on ${esc(t.branch)}` : ''}` +
        `${t.muted ? ' · muted' : ''}</span><span class="lee-spacer"></span>` +
        `<button type="button" data-thread-rename title="rename">rename</button>` +
        `<button type="button" data-thread-mute title="${t.muted ? 'unmute' : 'silence notifications'}">${t.muted ? 'unmute' : 'mute'}</button>` +
        `<button type="button" data-thread-reshape title="edit this conversation as a notebook">edit</button>` +
        `<button type="button" data-thread-branches title="fork this conversation, or switch branch">branches</button>` +
        `<button type="button" data-thread-close class="warn" title="close">close</button></footer></article>`;
    }).join('') || '<div class="lee-dim">no live conversations</div>';
    list.insertAdjacentHTML('beforeend',
      `<footer class="lee-thread-list-foot"><label title="browser notification when a background ` +
      `conversation wants you"><input type="checkbox" id="agentnotify"${agentNotifyEnabled() ? ' checked' : ''}>` +
      `<span>notify me about background conversations</span></label></footer>`);
    $('#agentnotify', list).onchange = e => leeAgentNotifyToggle(e.target.checked);
    bindAgentThreadCards(list);
  }
  paintAgentAttention(d.attention || {}, rows);
}
function bindAgentThreadCards(list) {
  if (list._leeThreadsBound) return;
  list._leeThreadsBound = true;
  const cardId = e => e.target.closest('[data-thread]')?.dataset.thread || '';
  list.addEventListener('click', e => {
    const id = cardId(e); if (!id) return;
    const button = e.target.closest('button');
    if (!button) return leeAgentThreadOpen(id);
    if (button.hasAttribute('data-thread-rename')) return leeAgentThreadRename(id);
    if (button.hasAttribute('data-thread-mute')) return leeAgentThreadMute(id);
    if (button.hasAttribute('data-thread-reshape')) return leeAgentReshape(id);
    if (button.hasAttribute('data-thread-branches')) return leeAgentBranches(id);
    if (button.hasAttribute('data-thread-close')) return leeAgentThreadClose(id);
  });
  list.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const id = cardId(e); if (!id || e.target.closest('button')) return;
    e.preventDefault(); leeAgentThreadOpen(id);
  });
}
function leeAgentThreadsToggle(show) {
  const list = $('#agentthreadlist'), toggle = $('#agentthreads'); if (!list) return;
  const open = show === undefined ? list.hidden : !!show;
  list.hidden = !open; toggle?.setAttribute('aria-expanded', String(open));
  if (open) refreshAgentThreads().catch(() => {});
}
/* The conversation as a notebook, edited with the editor a person already knows, then read back.
   Nothing is applied until they ask: saving the notebook changes no conversation by itself. */
async function leeAgentReshape(id = ag.thread) {
  if (!id) return status('open a conversation first', 'err');
  let made;
  try { made = await post('/agent/conversation/notebook', {thread: id, session: id}); }
  catch (e) { return status(e.message || String(e), 'err'); }
  ag.reshape = {thread: id, session: made.session, path: made.path, revision: made.revision};
  await agentHost.openFile(made.path);
  status(`${made.parts} parts opened as a notebook · edit, save, then apply from the agent pane`, 'ok');
  paintAgentReshapeBar();
}
function paintAgentReshapeBar() {
  const bar = $('#agentattention'); const held = ag.reshape; if (!bar || !held) return;
  bar.hidden = false;
  bar.innerHTML = `<span>editing ${esc(held.session.replace(/^agent_/, 'conversation '))} as a notebook</span>` +
    `<button type="button" data-reshape-apply>apply edits</button>` +
    `<button type="button" data-reshape-cancel>discard edits</button>`;
  $('[data-reshape-apply]', bar).onclick = leeAgentReshapeApply;
  $('[data-reshape-cancel]', bar).onclick = () => { ag.reshape = null; bar.hidden = true; refreshAgentThreads(); };
}
async function leeAgentReshapeApply() {
  const held = ag.reshape; if (!held) return;
  // read the edits from disk, so an unsaved buffer cannot look like a deleted part
  try { await post('/tabs/save-all'); } catch (_) {}
  let out;
  try { out = await post('/agent/conversation/reshape', held); }
  catch (e) { return status(e.message || String(e), 'err'); }
  ag.reshape = null; $('#agentattention').hidden = true;
  await refreshAgentThreads();
  status(`reshaped · ${out.discarded.length} dropped, ${out.rewritten.length} rewritten · ${out.branch_id}`, 'ok');
}
/* Branches belong to a conversation, so the way in is that conversation's own card. Two lists in
   one dialog: where this conversation has already been cut, and where it can still be. A branch is
   a parent point and a manifest, recompiled on switch, so nothing here replays a turn. */
export async function leeAgentBranches(id = ag.thread) {
  if (!id) return status('open a conversation first', 'err');
  let d;
  try { d = await api('/agent/branches?thread=' + encodeURIComponent(id)); }
  catch (e) { return status(e.message || String(e), 'err'); }
  const origin = b => b.branch_id === 'main' ? 'the conversation as recorded'
    : `${b.shaped ? 'shaped' : 'forked'} from turn ${esc(turnShort(b.parent_turn_id))} ${esc(b.stage || 'after')}` +
      `${b.parent_branch_id ? ` · off ${esc(b.parent_branch_id)}` : ''}`;
  const branches = (d.branches || []).map(b =>
    `<div class="lee-setup-row"><span><strong>${esc(b.branch_id)}</strong>` +
    `${b.branch_id === d.active ? ' · active' : ''}<br><small>${origin(b)}</small></span>` +
    (b.branch_id === d.active ? '<span class="lee-dim">on screen</span>'
      : `<button class="lee-btn" data-switch="${esc(b.branch_id)}">switch</button>`) + '</div>').join('');
  const points = (d.turns || []).filter(t => t.after).map(t =>
    `<div class="lee-setup-row"><span><strong>turn ${esc(turnShort(t.turn_id))}</strong><br>` +
    `<small>captured on ${esc(t.branch_id)}</small></span>` +
    `<button class="lee-btn" data-fork="${esc(t.turn_id)}">fork…</button></div>`).reverse().join('');
  const m = modal(`<div class="lee-mhead">Conversation branches<span class="sub">active · ${esc(d.active)}</span></div>` +
    `<h4>branches</h4><div class="lee-modallist">${branches}</div>` +
    `<h4>branch points</h4><div class="lee-modallist">${points ||
      '<div class="lee-dim">no turn of this conversation was captured in this session</div>'}</div>` +
    `<div class="lee-mfoot"><span class="lee-dim">a branch is a starting point, not a copy</span>` +
    `<span class="lee-spacer"></span><button class="lee-btn" data-shape>shape context…</button></div>`,
    null, null, {storageKey: 'agent-branches'});
  $('[data-shape]', m).onclick = () => { m.remove(); leeAgentShape(id); };
  $$('[data-switch]', m).forEach(b => b.onclick = async () => {
    if (await leeAgentBranchSwitch(b.dataset.switch, id)) { m.remove(); leeAgentBranches(id); }
  });
  $$('[data-fork]', m).forEach(b => b.onclick = () => { m.remove(); leeAgentForkTurn(b.dataset.fork, id); });
}
const turnShort = id => String(id || '').split(':').at(-1);
/* Switching moves what the model remembers, never what is on screen: the transcript is the record
   of what was said, and saying otherwise would hide a turn that really happened. */
async function leeAgentBranchSwitch(branchId, id = ag.thread) {
  try {
    const d = await post('/agent/branch/switch', {thread: id, branch_id: branchId});
    await refreshAgentThreads();
    status(`the next turn continues from ${d.active} · the transcript above is unchanged`, 'ok');
    return d;
  } catch (e) { status(e.message || String(e), 'err'); return null; }
}
/* A fork point is a part, not a message: a call and the results it produced move together, so
   picking one inside a tool exchange takes the whole exchange. */
export async function leeAgentForkTurn(turnId, id = ag.thread) {
  if (!turnId) return status('no turn to branch from', 'err');
  let d;
  try { d = await api(`/agent/branch/parts?turn_id=${encodeURIComponent(turnId)}&stage=after` +
                      `&thread=${encodeURIComponent(id || '')}`); }
  catch (e) { return status(e.message || String(e), 'err'); }
  const kinds = {user: 'you', assistant: 'agent', calls: 'call', result: 'result'};
  const rows = (d.parts || []).map(p =>
    `<div class="lee-setup-row"><span><strong>${esc(kinds[p.kind] || p.kind)}</strong><br>` +
    `<small>${esc((p.preview || '').slice(0, 120) || 'no text')}</small></span>` +
    `<button class="lee-btn" data-part="${esc(p.part_id)}">keep to here</button></div>`).join('');
  const m = modal(`<div class="lee-mhead">Branch from turn ${esc(turnShort(turnId))}` +
    `<span class="sub">a new branch continuing from the point you pick · nothing is deleted</span></div>` +
    `<div class="lee-modallist"><div class="lee-setup-row"><span><strong>the whole turn</strong><br>` +
    `<small>everything said up to and including it</small></span>` +
    `<button class="lee-btn go" data-part="">branch here</button></div>${rows}</div>`,
    null, null, {storageKey: 'agent-fork'});
  $$('[data-part]', m).forEach(b => b.onclick = async () => {
    try {
      const out = await post('/agent/fork', {thread: id, turn_id: turnId, stage: 'after', part_id: b.dataset.part});
      m.remove(); await refreshAgentThreads();
      status(`branched to ${out.branch_id} · ${out.kept} part(s) kept, ${out.omitted} dropped`, 'ok');
    } catch (e) { status(e.message || String(e), 'err'); }
  });
}
/* What the model still carries, decided in one place rather than in a notebook. Nothing is
   written until apply, and apply is refused unless the branch is still at the revision the preview
   was taken at: a conversation that moved while a person was deciding is a different question. */
export async function leeAgentShape(id = ag.thread) {
  if (!id) return status('open a conversation first', 'err');
  let d;
  try { d = await api('/agent/conversation/parts?thread=' + encodeURIComponent(id)); }
  catch (e) { return status(e.message || String(e), 'err'); }
  const parts = d.parts || [];
  if (!parts.length) return status('this conversation has no recorded turns to shape', 'err');
  const kinds = {user: 'you', assistant: 'agent', call: 'call', result: 'result'};
  const rows = parts.map(p =>
    `<div class="lee-setup-row lee-shape-row" data-part="${esc(p.part_id)}">` +
    `<span><strong>${esc(kinds[p.kind] || p.kind)}</strong>${p.tool ? ` · ${esc(p.tool)}` : ''}` +
    (p.editable ? `<textarea class="lee-input" data-text rows="2" spellcheck="true"` +
                  ` aria-label="what the model remembers here">${esc(p.text || '')}</textarea>`
                : `<br><small>${esc((p.text || '').slice(0, 160) || 'no text')}</small>`) + '</span>' +
    `<label title="uncheck to drop this part"><input type="checkbox" data-keep checked> keep</label></div>`).join('');
  const m = modal(`<div class="lee-mhead">Shape this conversation` +
    `<span class="sub">${esc(d.session)} · branch ${esc(d.branch_id)}</span></div>` +
    `<section class="lee-revision-explainer"><strong>You are choosing what the model still carries.</strong>` +
    `<span>Tools will not run again and files will not change. A call and its result go together. ` +
    `Apply writes a new branch, and the recorded conversation stays as it is.</span></section>` +
    `<div class="lee-modallist">${rows}</div>` +
    `<div class="lee-mfoot"><span class="lee-dim" data-summary>reading…</span><span class="lee-spacer"></span>` +
    `<button class="lee-btn" data-cancel>close</button>` +
    `<button class="lee-btn go" data-apply disabled>apply as a new branch</button></div>`,
    null, null, {className: 'lee-setup-modal', storageKey: 'agent-shape'});
  const manifest = () => Object.fromEntries($$('[data-part]', m)
    .filter(row => !$('[data-keep]', row).checked).map(row => [row.dataset.part, 'discard']));
  const rewrites = () => Object.fromEntries(parts.filter(p => p.editable).map(p =>
    [p.part_id, $(`[data-part="${CSS.escape(p.part_id)}"] [data-text]`, m)?.value])
    .filter(([pid, text]) => text !== undefined && text !== (parts.find(p => p.part_id === pid).text || '')));
  const summary = $('[data-summary]', m), apply = $('[data-apply]', m);
  let seen = null, timer = null;
  const preview = async () => {
    try {
      const pv = await post('/agent/history/preview',
                            {thread: id, session: d.session, manifest: manifest(), rewrites: rewrites()});
      seen = pv; apply.disabled = false;
      summary.textContent = `${pv.kept} kept · ${pv.omitted} dropped · ${pv.rewritten.length} rewritten` +
        ` · about ${pv.tokens} tokens` +
        (pv.adjusted.length ? ` · ${pv.adjusted.length} went with the call they belong to` : '');
    } catch (e) { seen = null; apply.disabled = true; summary.textContent = e.message || String(e); }
  };
  // Apply is only ever offered for a manifest the person has been shown the cost of.
  const schedule = () => { seen = null; apply.disabled = true; clearTimeout(timer); timer = setTimeout(preview, 250); };
  m.addEventListener('input', schedule); m.addEventListener('change', schedule);
  preview();
  $('[data-cancel]', m).onclick = () => m.remove();
  apply.onclick = async () => {
    if (!seen) return;
    try {
      const out = await post('/agent/history/apply',
                             {thread: id, session: d.session, branch_id: seen.branch_id, revision: seen.revision,
                              manifest: manifest(), rewrites: rewrites()});
      m.remove(); await refreshAgentThreads();
      status(`shaped into ${out.branch_id} · ${out.omitted} dropped, ${out.rewritten.length} rewritten`, 'ok');
    } catch (e) {
      /* A refusal here is nearly always the branch having moved, so the honest recovery is to
         re-read it and show what it costs now rather than to send the same revision again. */
      status(e.message || String(e), 'err'); preview();
    }
  };
}
async function leeAgentThreadOpen(id) {
  await leeAgentThreadSwitch(id);
  leeAgentThreadsToggle(false);
  $('#agentprompt')?.focus();
}
/* `status()` is footer-only and addressed to nothing. A checkpoint in another conversation needs
   naming and a way in. */
/* The `done` event is the only thing that clears `agentBusy`, and a stream that drops as the turn
   ends never delivers it -- `es.onerror` reconnects and leaves it standing. The pane then reads as
   working over a conversation the server has long since finished, and the composer stays in steer
   mode with no way back. This poll already carries the server's own view of the active
   conversation, so it is what settles the disagreement. The delay is for the other race: a send
   raises `agentBusy` before the run is registered, and a poll landing in that window would clear a
   turn that is about to start. */
const BUSY_SETTLE_MS = 6000;
function reconcileAgentBusy(attention) {
  const state = attention.active_state;
  if (!state || !agentHost.busy) return;
  if (state === 'working' || state === 'waiting') return;
  if (Date.now() - (ag.busyAt || 0) < BUSY_SETTLE_MS) return;
  agentHost.busy = false; ag.runs = [];
  setAgentStatus(state === 'failed' ? 'idle' : 'ready');
  updateAgentRunstrip({runs: []});
}
/* Nothing else polls: `refreshAgentThreads` runs on what a person does, and the stream that would
   say `done` is the thing missing when this goes wrong. So the check has to run on its own clock,
   and only while a turn is outstanding -- it stops itself as soon as one is not. */
export function startAgentBusyWatch() {
  if (ag.busyWatch) return;
  ag.busyWatch = setInterval(async () => {
    if (!agentHost.busy) { clearInterval(ag.busyWatch); ag.busyWatch = null; return; }
    try { reconcileAgentBusy((await api('/agent/threads')).attention || {}); } catch (_) {}
  }, 5000);
}
function paintAgentAttention(attention, rows) {
  reconcileAgentBusy(attention);
  const bar = $('#agentattention'); if (!bar) return;
  const waiting = (attention.waiting || []).filter(id => id !== attention.active);
  const working = Math.max(0, (attention.working || 0) - (rows.some(t => t.id === attention.active && t.state === 'working') ? 1 : 0));
  document.title = agentDocumentTitle(attention);
  if (!waiting.length) { bar.hidden = true; bar.innerHTML = ''; return; }
  const named = waiting.map(id => {
    const row = rows.find(t => t.id === id);
    return `<button type="button" data-attention="${esc(id)}">${esc(row ? threadName(row) : id)}</button>`;
  }).join('');
  bar.hidden = false;
  bar.innerHTML = `<span>${waiting.length === 1 ? 'A conversation is' : `${waiting.length} conversations are`} waiting for you</span>${named}`;
  for (const button of $$('[data-attention]', bar)) button.onclick = () => leeAgentAttend(button.dataset.attention);
  return working;
}
function agentDocumentTitle(attention) {
  const base = ag.documentTitle ||= document.title.replace(/^[^·]*· /, '');
  const bits = [];
  if (attention.working) bits.push(`${attention.working}⚙`);
  if ((attention.waiting || []).length) bits.push('(!)');
  return bits.length ? `${bits.join(' ')} · ${base}` : base;
}
/* Switching to the conversation that asked, and then to the question it asked. The right pane with
   no idea what wanted you is half an answer. */
async function leeAgentAttend(id) {
  await leeAgentThreadSwitch(id);
  const card = $('.lee-approval-card') || $('[data-approval]');
  if (card) { card.scrollIntoView({block: 'center'}); (card.querySelector('button') || card).focus(); }
  else await pollApproval();
}
async function leeAgentThreadMute(id = ag.thread) {
  if (!id) return;
  const row = (ag.threadRows || []).find(t => t.id === id);
  try {
    const d = await post('/agent/thread/mute', {thread: id, muted: !row?.muted});
    if (d.thread?.problem) status(`mute was not saved: ${d.thread.problem}`, 'err');
    await refreshAgentThreads();
  } catch (e) { status(String(e.message || e), 'err'); }
}
export async function refreshAgentThreads() {
  await agentPrefsReady();   // the list paints the notify box, which is one of them
  const d = await api('/agent/threads'); paintAgentThreads(d); notifyAgentAttention(d); return d;
}
/* Off by default, and permission is asked for only when a person turns it on, because a prompt
   nobody invited is why browsers stopped honouring them. Every state is terminal: unsupported and
   denied disable delivery and say so once. */
export function agentNotifyEnabled() { return prefGet('agent', 'notify', false) === true; }
async function leeAgentNotifyToggle(on) {
  const off = async (said, tone) => { await prefSet('agent', 'notify', false); return status(said, tone); };
  if (!on) return off('notifications off', 'ok');
  if (!('Notification' in window)) return off('this browser has no notifications', 'err');
  let state = Notification.permission;
  if (state === 'default') { try { state = await Notification.requestPermission(); } catch (_) { state = 'denied'; } }
  if (state !== 'granted') return off('notifications are blocked for this site', 'err');
  await prefSet('agent', 'notify', true); status('notifications on', 'ok');
}
/* One notification per thing that happened, keyed by what happened: replay, a reconnect and a
   second tab all deliver the same terminal event. */
function notifyAgentAttention(d) {
  const seen = ag.notified ||= new Set();
  if (!agentNotifyEnabled() || !('Notification' in window) || Notification.permission !== 'granted') return;
  for (const row of (d.threads || [])) {
    if (row.id === d.active || row.muted) continue;
    const key = `${row.id}:${row.state}:${row.unread}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!document.hidden) continue;
    const name = threadName(row);
    if (row.state === 'waiting') new Notification('Waiting for you', {body: name, tag: row.id});
    else if (row.unread) new Notification('Turn finished', {body: name, tag: row.id});
  }
}
window.leeAgentNotifyToggle = leeAgentNotifyToggle; window.agentNotifyEnabled = agentNotifyEnabled;
async function leeAgentNew() {
  rememberAgentThread();
  try {
    const d = await post('/agent/thread/new', {}); ag.thread = d.active; agentHost.busy = false; ag.title = '';
    approvalCards.clear(); const log = $('#agentlog'), input = $('#agentprompt');
    if (log) { agentHost.dropEditors(log); log.innerHTML = ''; ag.live = null; ag.view = 'live'; } if (input) input.value = '';
    await refreshAgentThreads(); $('#agenthistory')?.classList.remove('active'); input?.focus(); status('new conversation started', 'ok');
  } catch (e) { status(String(e.message || e), 'err'); }
}
/* A conversation with a turn in flight keeps producing while it is off screen. Switching to it
   paints its finished turns from the server first, then attaches to its feed from the last point
   it settled, so the running turn arrives once and nothing drawn is drawn twice. */
async function leeAgentThreadSwitch(id) {
  if (!id || id === ag.thread) return; rememberAgentThread();
  try {
    const d = await post('/agent/thread/switch', {thread:id});
    if (ag.stream) { ag.stream._leeStopped = true; ag.stream.close(); ag.stream = null; ++ag.streamGen; }
    const running = d.thread.state === 'working' || d.thread.state === 'waiting';
    ag.thread = d.active; agentHost.busy = running; ag.title = titleText(d.thread.title);
    const input = $('#agentprompt'); if (input) input.value = ag.threadDrafts.get(id) || '';
    const live = await paintAgentThread(d.active);
    await refreshAgentThreads(); updateAgentRunstrip();
    if (running) { setAgentStatus('working'); agentListen(d.active, live?.seq || 0); }
    else { setAgentStatus('ready'); await rehydrateAgentLive(); }
    input?.focus();
  } catch (e) { status(String(e.message || e), 'err'); await refreshAgentThreads(); }
}
async function leeAgentThreadRename(id = ag.thread) {
  if (!id) return;
  const row = (ag.threadRows || []).find(t => t.id === id);
  const title = await textDialog('Rename conversation', 'Conversation title', row ? titleText(row.title) : '');
  if (title == null) return;
  try { const d = await post('/agent/thread/title', {thread: id, title});
        if (id === ag.thread) ag.title = titleText(d.thread.title);
        await refreshAgentThreads(); }
  catch (e) { status(String(e.message || e), 'err'); }
}
async function leeAgentThreadClose(id = ag.thread) {
  if (!id) return; const closing = id;
  try {
    const d = await post('/agent/thread/close', {thread:closing}); ag.threadDrafts.delete(closing);
    paintAgentThreads(d); const log = $('#agentlog'); if (log) { agentHost.dropEditors(log); log.innerHTML = ''; } if (d.active) { const active = d.active; ag.thread = ''; await leeAgentThreadSwitch(active); }
  } catch (e) { status(String(e.message || e), 'err'); }
}
// The rehydrated banner survives `restoreAgentLive`, which round-trips the pane through innerHTML:
// an id in an onclick attribute outlives that, a bound listener does not.
window.leeAgentNew = leeAgentNew; window.leeAgentThreadsToggle = leeAgentThreadsToggle;
window.leeAgentThreadOpen = leeAgentThreadOpen; window.leeAgentReshape = leeAgentReshape; window.leeAgentAttend = leeAgentAttend;
window.leeAgentThreadMute = leeAgentThreadMute; window.leeAgentThreadSwitch = leeAgentThreadSwitch;
window.leeAgentThreadRename = leeAgentThreadRename; window.leeAgentThreadClose = leeAgentThreadClose;
window.refreshAgentThreads = refreshAgentThreads;
window.leeAgentResume = leeAgentResume;
window.leeAgentHistory = leeAgentHistory;
window.rehydrateAgentLive = rehydrateAgentLive; window.paintAgentThread = paintAgentThread;

async function leeAgentState() {
  try {
    const [draft, saved, template] = await Promise.all([api('/agent/state/draft'), api('/agent/states'), api('/agent/state/template')]);
    // Every workspace saves into one store, so this list has always held other projects' charters.
    // The row says which layer it was written for and which folders it was written in, because a
    // title and a date are not enough to reuse one deliberately.
    const stateRow = s => `<button class="lee-agent-state-row${s.mine ? ' mine' : ''}" data-id="${esc(s.id)}">` +
      `<strong>${esc(s.title)}</strong>` +
      `<span class="lee-state-origin">${s.layer ? `<em>${esc(s.layer)}</em>` : ''}` +
      `${s.where ? `<span>${esc(s.where)}</span>` : '<span class="lee-dim">no folder recorded</span>'}` +
      `${s.mine ? '<span class="lee-state-here">this project</span>' : ''}</span>` +
      `<span>${esc(new Date((s.added_at || 0) * 1000).toLocaleString())}</span></button>`;
    const rows = (saved.states || []).map(stateRow).join('');
    const box = modal(`<div class="lee-mhead">Agent state<span class="sub">remembered rules that stay visible and follow the code</span></div>` +
      `<section class="lee-agent-state-onboard${saved.active ? ' configured' : ''}"${saved.active ? ' hidden' : ''}><div><strong>Start with a worked template</strong>` +
      `<span>Describe what you want this agent to do. The configured summary model fills a complete charter using only tools that are actually installed.</span></div>` +
      `<input class="lee-input" id="agentstateintent" placeholder="e.g. Maintain this Python project; inspect before editing and run focused tests">` +
      `<button class="lee-btn go" data-bootstrap>Generate my charter</button><button class="lee-btn" data-template>Use blank template</button></section>` +
      `<div class="lee-agent-state-grid"><section><div class="lee-agent-state-controls"><label>Where this applies<select class="lee-select" id="agentstatelayer">` +
      `${['organization','project','task','preferences','branch','ephemeral'].map(x => `<option value="${x}"${x === 'task' ? ' selected' : ''}>${x}</option>`).join('')}</select></label>` +
      `<label class="lee-state-enabled" title="Silence this layer without deleting what it holds">` +
      `<input type="checkbox" id="agentstateenabled"><span>Enabled</span></label>` +
      `<button class="lee-btn" data-update>Refresh from code</button><button class="lee-btn" data-diagnose>Check state</button></div>` +
      `<label class="lee-fieldlabel">Title<input class="lee-input" id="agentstatetitle" value="Working state"></label>` +
      `<div class="lee-state-editor-head"><span>Markdown charter</span><button class="lee-btn" data-add-rule>Add rule</button>` +
      `<button class="lee-btn" data-add-check>Add verification</button><button class="lee-btn" data-add-tool>Add tool route</button>` +
      `<button class="lee-btn" data-preview-state>Preview</button></div><div class="lee-agent-state-editor" id="agentstatetext"></div>` +
      `<div class="lee-agent-state-help" data-state-help>Keep goal, constraints, progress, decisions, next steps, and critical context. ` +
      `This is an explicit briefing, not hidden chat history.</div></section>` +
      `<section class="lee-agent-state-reference"><nav class="lee-state-ref-tabs"><button class="active" data-ref="conversation">Conversation</button>` +
      `<button data-ref="tools">Tools</button><button data-ref="preview">Preview</button><button data-ref="saved">Saved</button></nav>` +
      `<div class="lee-state-ref-pane active" data-ref-pane="conversation"><pre class="lee-agent-conversation">${esc(draft.conversation || '(no completed turns)')}</pre></div>` +
      `<div class="lee-state-ref-pane" data-ref-pane="tools"><div class="lee-state-tool-list">${template.tools.map(t => `<button data-tool-name="${esc(t.name)}"><strong>${esc(t.name)}</strong><span>${esc(t.group)} · ${esc(t.description)}</span></button>`).join('')}</div></div>` +
      `<div class="lee-state-ref-pane lee-md" data-ref-pane="preview" id="agentstatepreview"></div>` +
      `<div class="lee-state-ref-pane" data-ref-pane="saved"><label class="lee-fieldlabel">Show<select class="lee-select" id="agentstatescope">` +
      `<option value="everywhere">every project on this machine</option><option value="project">this project only</option></select></label>` +
      `<div class="lee-agent-state-list">${rows || '<div class="lee-dim">No saved states yet.</div>'}</div></div></section></div>` +
      `<div class="lee-mfoot"><button class="lee-btn go" data-save>Save to memory + activate</button>` +
      `<button class="lee-btn" data-activate>Activate without saving</button>` +
      `<button class="lee-btn warn" data-clear>Clear this layer</button>` +
      `<span class="lee-dim">Drag the lower-right edge to resize · double-click the title to expand.</span></div>`,
      null, null, {className: 'lee-agent-state-modal', storageKey: 'agent-state'});
    const text = $('#agentstatetext', box), layer = $('#agentstatelayer', box);
    const stateView = agentHost.createEditor(text, {doc: '', lang: 'markdown', lineNums: true, lintPath: '<agent-state>',
      placeholder: '# Agent charter\n\nDescribe how this agent should work…'});
    Object.defineProperty(text, 'value', {get: () => agentHost.cm.getDoc(stateView), set: value => agentHost.cm.setDoc(stateView, String(value || ''))});
    const insertStateMarkdown = value => {
      const at = agentHost.cm.cursor(stateView), prefix = at && !text.value.slice(0, at).endsWith('\n') ? '\n' : '';
      agentHost.cm.replaceRange(stateView, at, at, prefix + value); agentHost.cm.focus(stateView);
    };
    const showReference = name => {
      $$('.lee-state-ref-tabs button', box).forEach(b => b.classList.toggle('active', b.dataset.ref === name));
      $$('.lee-state-ref-pane', box).forEach(p => p.classList.toggle('active', p.dataset.refPane === name));
      if (name === 'preview') renderMarkdown($('#agentstatepreview', box), text.value, true);
    };
    $$('.lee-state-ref-tabs button', box).forEach(b => b.onclick = () => showReference(b.dataset.ref));
    $('[data-preview-state]', box).onclick = () => showReference('preview');
    $('[data-add-rule]', box).onclick = () => insertStateMarkdown('\n- [Write a clear, testable rule.]');
    $('[data-add-check]', box).onclick = () => insertStateMarkdown('\n- [Describe the evidence required before completion.]');
    $('[data-add-tool]', box).onclick = () => showReference('tools');
    $$('.lee-state-tool-list button', box).forEach(b => b.onclick = () => {
      const tool = template.tools.find(t => t.name === b.dataset.toolName);
      insertStateMarkdown(`\n- ${tool.name} → ${tool.description}`); showReference('preview');
    });
    const layers = {...(saved.layers || {})};
    const layerRow = () => layers[layer.value] || {text: '', enabled: true};
    const enabledBox = $('#agentstateenabled', box);
    // The badge names the state in force. Nothing in force is nothing to name.
    const anyActive = () => Object.values(layers).some(l => String(l.text || '').trim() && l.enabled !== false);
    const paintBadge = () => {
      const badge = $('#agentnames');
      if (badge && !anyActive()) { badge.textContent = ''; badge.title = ''; }
    };
    const loadLayer = () => {
      text.value = layerRow().text || (layer.value === 'task' ? draft.state : '');
      enabledBox.checked = layerRow().enabled !== false;
    };
    loadLayer(); layer.onchange = loadLayer;
    /* Off rather than gone, so a layer can be silenced for one piece of work and put back without
       being written again. It sends the layer's stored text and not the editor's: a draft nobody
       activated must not reach the briefing because a checkbox moved. */
    enabledBox.onchange = async () => {
      const row = layerRow(), on = enabledBox.checked;
      try {
        await post('/agent/state/activate', {text: row.text || '', layer: layer.value, enabled: on});
        layers[layer.value] = {...row, text: row.text || '', enabled: on};
        paintBadge(); status(`${layer.value} layer ${on ? 'enabled' : 'disabled'}`, 'ok');
      } catch (e) { enabledBox.checked = !on; status(e.message || String(e), 'err'); }
    };
    $('[data-template]', box).onclick = async () => {
      const d = await api('/agent/state/template'); text.value = d.template + '\n\n' + d.catalog;
      $('[data-state-help]', box).textContent = 'Template loaded. Replace bracketed prompts, then activate or save it.';
    };
    $('[data-bootstrap]', box).onclick = async () => {
      const button = $('[data-bootstrap]', box); button.disabled = true; button.textContent = 'Generating…';
      try {
        const d = await post('/agent/state/bootstrap', {intent: $('#agentstateintent', box).value});
        text.value = d.text; $('#agentstatetitle', box).value = ($('#agentstateintent', box).value || 'Workspace agent charter').slice(0, 80);
        $('[data-state-help]', box).textContent = `Drafted with ${d.model}. Read every rule, then save + activate.`;
      } catch (e) { $('[data-state-help]', box).textContent = e.message || String(e); }
      finally { button.disabled = false; button.textContent = 'Generate my charter'; }
    };
    $('[data-update]', box).onclick = async () => {
      const d = await post('/agent/state/update', {current: text.value, conversation: draft.conversation});
      const review = modal(`<div class="lee-mhead">Review proposed state update<span class="sub">nothing changes until you apply it</span></div>` +
        `<div class="lee-diff lee-state-update-diff">${agentHost.diffHtml(d.diff.rows || [])}</div>` +
        `<div class="lee-mfoot"><button class="lee-btn go" data-accept>Apply to editor</button>` +
        `<button class="lee-btn" data-reject>Keep current state</button></div>`);
      $('[data-accept]', review).onclick = () => { text.value = d.text; review.remove(); $('[data-state-help]', box).textContent = 'Proposed update applied to the editor. Review before saving or activating.'; };
      $('[data-reject]', review).onclick = () => review.remove();
    };
    $('[data-diagnose]', box).onclick = async () => {
      const d = await post('/agent/state/diagnostics', {text: text.value});
      $('[data-state-help]', box).textContent = `${d.tokens} tokens` +
        (d.missing_paths.length ? ` · missing paths: ${d.missing_paths.join(', ')}` : ' · paths current') +
        (d.duplicate_headings.length ? ` · duplicate headings: ${d.duplicate_headings.join(', ')}` : '');
    };
    // The badge is what says which charter the agent is carrying, so it takes the state's own
    // heading rather than the word `active`.
    const stateLabel = () => (text.value.split('\n').find(l => l.startsWith('#') && l.replace(/^#+\s*/, '').trim())
      || '').replace(/^#+\s*/, '').trim().slice(0, 40) || 'state active';
    const markActive = () => {
      const badge = $('#agentnames'); if (badge) { badge.textContent = stateLabel(); badge.title = 'active starting state'; }
      $('.lee-agent-welcome', $('#agentlog'))?.remove();
    };
    // A save that fails leaves the state in the editor and the box open, with the reason on it.
    // Neither button said anything when the request was refused, so a person pressed a control that
    // did nothing: the packaged app cannot reach memory at all, and this is how that looked.
    const attempt = async (button, run) => {
      const el = $(`[data-${button}]`, box), label = el.textContent;
      el.disabled = true; el.textContent = 'Working…';
      try { await run(); box.remove(); }
      catch (e) {
        const why = e.message || String(e);
        $('[data-state-help]', box).textContent = why;
        status(why, 'err');
      }
      finally { el.disabled = false; el.textContent = label; }
    };
    $('[data-save]', box).onclick = () => attempt('save', async () => {
      const d = await post('/agent/state/save', {title: $('#agentstatetitle', box).value, text: text.value, layer: layer.value, activate: true});
      markActive(); status(d.saved?.skipped ? 'state already in memory and activated' : 'state saved to memory and activated', 'ok');
    });
    $('[data-activate]', box).onclick = () => attempt('activate', async () => {
      await post('/agent/state/activate', {text: text.value, layer: layer.value});
      markActive(); status('starting state activated without saving', 'ok');
    });
    /* Not through `attempt`, which closes the box on success: emptying a layer is a thing to watch
       happen, and the editor showing what it now holds is the whole of the confirmation. */
    $('[data-clear]', box).onclick = async () => {
      const el = $('[data-clear]', box), label = el.textContent;
      el.disabled = true; el.textContent = 'Working…';
      try {
        await post('/agent/state/activate', {text: '', layer: layer.value, enabled: true});
        layers[layer.value] = {text: '', enabled: true, source: 'user'};
        if (layer.value === 'task') draft.state = '';   // or leaving and returning refills it
        text.value = ''; enabledBox.checked = true; paintBadge();
        $('[data-state-help]', box).textContent = `The ${layer.value} layer is empty; nothing from it reaches the briefing.`;
        status(`${layer.value} layer cleared`, 'ok');
      } catch (e) {
        const why = e.message || String(e);
        $('[data-state-help]', box).textContent = why; status(why, 'err');
      }
      finally { el.disabled = false; el.textContent = label; }
    };
    const bindStateRows = () => $$('.lee-agent-state-row', box).forEach(row => row.onclick = async () => {
      const compared = await post('/agent/state/compare', {id: row.dataset.id, current: text.value});
      const review = modal(`<div class="lee-mhead">Compare state revision<span class="sub">choose how this revision enters ${esc(layer.value)}</span></div>` +
        `<div class="lee-diff lee-state-update-diff">${agentHost.diffHtml(compared.diff.rows || [])}</div>` +
        `<div class="lee-mfoot"><button class="lee-btn go" data-replace>Replace + activate</button>` +
        `<button class="lee-btn" data-merge>Merge below current</button><button class="lee-btn" data-cancel>Cancel</button></div>`);
      $('[data-replace]', review).onclick = async () => {
        const d = await post('/agent/state/load', {id: row.dataset.id, layer: layer.value}); text.value = d.state;
        review.remove(); $$('.lee-agent-state-row', box).forEach(x => x.classList.toggle('active', x === row)); status('saved revision restored and active', 'ok');
      };
      $('[data-merge]', review).onclick = () => { text.value = text.value.trim() + '\n\n' + compared.state.trim(); review.remove(); status('revision merged into editor; review before activation', 'ok'); };
      $('[data-cancel]', review).onclick = () => review.remove();
    });
    bindStateRows();
    $('#agentstatescope', box).onchange = async e => {
      const list = $('.lee-agent-state-list', box);
      const d = await api('/agent/states?scope=' + encodeURIComponent(e.target.value));
      list.innerHTML = (d.states || []).map(stateRow).join('') ||
        `<div class="lee-dim">No states saved ${e.target.value === 'project' ? 'in this project' : 'yet'}.</div>`;
      bindStateRows();
    };
  } catch (e) { status(e.message || String(e), 'err'); }
}
window.leeAgentState = leeAgentState;

function renderSessionCells(log, d) {
  if (d.path) log.insertAdjacentHTML('beforeend', `<div class="lee-session-path">${esc(d.path)}</div>`);
  for (const [i, cell] of (d.cells || []).entries()) {
    if (cell.cell_type === 'markdown') {
      const md = document.createElement('div'); md.className = 'lee-session-markdown';
      renderMarkdown(md, cell.source); log.appendChild(md); continue;
    }
    const details = document.createElement('details'); details.className = 'lee-session-code';
    const first = (cell.source || '').split('\n').find(x => x.trim()) || '(empty code cell)';
    details.innerHTML = `<summary><span>run ${i + 1}</span><code>${esc(first)}</code>` +
      `<span class="lee-agent-step-chevron" aria-hidden="true"></span></summary><div class="lee-session-code-body"></div>`;
    let mounted = false;
    details.ontoggle = () => {
      if (!details.open || mounted) return; mounted = true;
      requestAnimationFrame(() => agentHost.mountEditor($('.lee-session-code-body', details), cell.source, 'python', true));
    };
    log.appendChild(details);
  }
}

export function agentLog(html, host = null) {
  const log = $('#agentlog');
  if (host) { host.insertAdjacentHTML('beforeend', html); stickAgentLog(log); return; }
  // Never use `innerHTML +=`: it reparses every existing child and silently detaches every
  // checkpoint, fork, rollback, CodeMirror and disclosure handler already in the log.
  log.insertAdjacentHTML('beforeend', html);
  stickAgentLog(log);
}

