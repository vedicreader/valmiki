/* A generated picture arrives as a data URL on the `done` event. The tool result the model
 * sees is a path, and a browser cannot draw a filename, so the bytes come separately. */
import {$, esc, api, post, status, renderMarkdown, flushMarkdown} from '../js/kit.js';
import {addResponseRevision, approvalCards, checkpointResult, retireCheckpoints, showApproval} from './approvals.js';
import {refreshAgentBudget} from './budgets.js';
import {agentHost} from './host.js';
import {agentTurnCard, foldOlderTurns, refoldAfter, renderTurns, restoreAgentLive, sessionTurns, startAgentBusyWatch, stickAgentLog, titleText, trimAgentLog, turnBody, usageMeta, userMessage} from './live.js';
import {ag} from './panel.js';
import {agentProgress, closeAgentSuggest, leeForceSteer, leeQueueSteer, paintAgentAttachments, renderAgentStep, sendAgentCommand, setQueuedSteer, showProblems, updateAgentRunstrip} from './steer.js';

function drawTurnMedia(out, media) {
  for (const m of (media || [])) {
    const fig = document.createElement('figure');
    fig.className = 'lee-agent-media';
    fig.innerHTML = (m.mime || '').startsWith('video/')
      ? `<video controls src="${m.url}"></video>`
      : `<img src="${m.url}" alt="generated image">`;
    out.after(fig);
  }
}

export function reduceAgentTimeline(events) {
  const parts = [], actions = new Map(); let prose = null;
  const seal = () => { prose = null; };
  for (const event of events || []) {
    const type = event.event || event.type, data = event.data || event;
    if (type === 'chunk') {
      if (!prose) { prose = {kind: 'prose', text: ''}; parts.push(prose); }
      prose.text += data.text || ''; continue;
    }
    if (type !== 'activity') { seal(); parts.push({kind: type, data}); continue; }
    const id = data.action_id || data.id;
    /* An update to a call already on screen is not a new position in the timeline, so only a
       call seen for the first time closes the open prose. A row with no id has no identity to
       update, so it can only ever be new, and it is still work a person did. */
    let part = id ? actions.get(id) : null;
    if (!part) {
      seal();
      part = {kind: 'activity', id: id || '', parent: data.parent_action_id || '', data, children: []};
      if (id) actions.set(id, part);
      parts.push(part);
    }
    else part.data = data;
    if (!id) continue;
    if (part.parent && actions.has(part.parent)) {
      const parent = actions.get(part.parent), at = parts.indexOf(part);
      if (at >= 0) parts.splice(at, 1);
      if (!parent.children.includes(part)) parent.children.push(part);
    }
    for (const child of [...parts]) if (child.kind === 'activity' && child.parent === id) {
      parts.splice(parts.indexOf(child), 1); if (!part.children.includes(child)) part.children.push(child);
    }
  }
  return parts;
}

/* A reply is re-rendered from the top on every pass, so the gap between passes is paid over the
   whole reply, not over the words that arrived. 32ms is right for a preview following a person's
   typing and far too eager for this: at a hundred it is text arriving ten times a second, which
   reads as continuous, for a third of the renders. */
const AGENT_RENDER_GAP = 100;
/* A hundred is still too eager once the reply is long, because every pass costs the whole of it:
   a round trip that parses and highlights the document again, an `innerHTML` write, and a
   re-measure of every code surface in it. A 20,000-character answer at a fixed gap is six hundred
   passes over an average of ten thousand characters. The gap grows with the text, which brings
   that to about a hundred and fifty passes and the work down with them.

   `tail` is what keeps the pane live in between: the characters that have arrived since the last
   render, as plain text after the rendered prose. It costs a `textContent` write and no parse, so
   words still appear at the rate they arrive. `seal` renders the stretch properly and drops it,
   and every path that ends a stretch of prose goes through `seal`. */
const AGENT_RENDER_CEILING = 1200;
const agentRenderGap = n => Math.min(AGENT_RENDER_CEILING, AGENT_RENDER_GAP + Math.round(n / 20));

export function agentTimeline(root) {
  const actions = new Map(); let prose = null, tail = null, rendered = 0;
  const dropTail = () => { if (tail) { tail.remove(); tail = null; } };
  const seal = () => {
    const el = prose; prose = null; rendered = 0; dropTail();
    if (el) flushMarkdown(el);
  };
  const activity = a => {
    const id = a.action_id || a.id; if (!id) return null;
    let held = actions.get(id), row = held?.row;
    if (!row) {
      seal();
      row = document.createElement('details'); held = {row, parent: a.parent_action_id || '', children: null};
      actions.set(id, held); root.appendChild(row);
    }
    held.parent = a.parent_action_id || held.parent;
    const children = held.children; if (children) children.remove();
    renderAgentStep(row, a); if (children) { row.appendChild(children); held.children = children; }
    if (held.parent && actions.has(held.parent)) {
      const parent = actions.get(held.parent);
      parent.children ||= (() => { const box = document.createElement('div'); box.className = 'lee-agent-children'; parent.row.appendChild(box); return box; })();
      parent.children.appendChild(row);
    }
    for (const child of actions.values()) if (child.parent === id && child.row.parentElement === root) {
      held.children ||= (() => { const box = document.createElement('div'); box.className = 'lee-agent-children'; row.appendChild(box); return box; })();
      held.children.appendChild(child.row);
    }
    return row;
  };
  /* The tail exists only while there is text the render has not reached, so a stretch the render
     has caught up with is one element, as it was before any of this. Nothing before the first
     render either: a short reply is parsed within the first gap and never shows its own markup. */
  const showTail = () => {
    const rest = prose && rendered ? prose._text.slice(rendered) : '';
    if (!rest) return dropTail();
    if (!tail) { tail = document.createElement('div'); tail.className = 'lee-agent-reply-tail'; }
    tail.textContent = rest;
    if (!tail.isConnected) prose.after(tail);
  };
  // `prose !== el` is a stretch that was sealed or replaced while its render was on the wire
  const painted = (el, sent) => { if (prose !== el) return; rendered = (sent || '').length; showTail(); };
  return {root, actions, seal, activity, chunk(text) {
    if (!prose) {
      prose = document.createElement('div'); prose.className = 'lee-reply lee-agent-reply lee-timeline-prose';
      prose._text = ''; rendered = 0; root.appendChild(prose);
    }
    prose._text += text || '';
    renderMarkdown(prose, prose._text, false, painted, agentRenderGap(prose._text.length));
    showTail();
    return prose;
  }, append(node) { seal(); if (node) root.appendChild(node); return node; }};
}

export function setAgentStatus(state, title) {
  const el = $('#agentstatus'); if (!el) return;
  el.classList.remove('working', 'ready', 'idle'); el.classList.add(state);
  el.title = title || (state === 'working' ? 'agent is working' : state === 'ready' ? 'agent ready' : 'agent idle');
  const dot = $('.lee-agent-status-dot', el); if (dot) dot.setAttribute('aria-label', el.title);
  const text = state === 'working' ? 'working' : state === 'ready' ? 'ready' : 'idle';
  [...el.childNodes].find(n => n.nodeType === Node.TEXT_NODE)?.replaceWith(document.createTextNode(text));
}

// The assistant's tools edit files on disk, so a turn can change what is on screen. Activity,
// answer chunks and final diffs stream independently, and each tool row is updated in place so
// pending work never stays on screen after that step has finished.
export async function sendAgent(force = false) {
  if (agentHost.busy) return force ? leeForceSteer() : leeQueueSteer();
  if (ag.view && ag.view !== 'live') restoreAgentLive();
  const el = $('#agentprompt'); if (!el || !el.value.trim()) return;
  const q = el.value.trim(); closeAgentSuggest();
  if (q.startsWith('/')) {
    try { ag.vocabulary ||= await api('/agent/commands'); } catch (_) {}
    const head = q.slice(1).split(/\s/, 1)[0];
    if ((ag.vocabulary?.commands || []).some(c => c.name === head)) return sendAgentCommand(q);
  }
  const attachments = [...ag.attachments.keys(), ...ag.selections.map(s => s.ref),
                       ...agentHost.vaultRefs.values()];
  const reasoning = $('#agentreasoning')?.value || 'auto';
  let accepted;
  try { accepted = await post('/agent/turn', {prompt: q, attachments, reasoning, thread: ag.thread || ''}); }
  catch (e) { el.value = q; return status(e.message || String(e), 'err'); }
  el.value = ''; el.style.height = '64px';
  ag.attachments.clear(); ag.selections = []; agentHost.vaultRefs.clear(); paintAgentAttachments();
  agentHost.busy = true; ag.busyAt = Date.now(); startAgentBusyWatch(); setAgentStatus('working'); updateAgentRunstrip(); refreshAgentBudget();
  const log = $('#agentlog'); $('.lee-agent-welcome', log)?.remove();
  const card = agentTurnCard({prompt: q, model: $('#agentmodel')?.value || ''});
  turnBody(card).appendChild(userMessage(q));
  log.appendChild(card);
  foldOlderTurns(log);            // what came before is answered; this is the one being read
  trimAgentLog(log);
  stickAgentLog(log, true);       // sending a turn is asking to watch it, wherever you had scrolled
  status('model is working…');
  agentListen(accepted.thread || ag.thread, accepted.seq, card);
}

/* One conversation's feed, painted into the live pane. `sendAgent` calls this for the turn it
   just started; a thread switch calls it for a turn already running, replaying from the feed's
   last settled point so only the turn in flight is drawn again. */
export function agentListen(thread, since, card = null) {
  const log = $('#agentlog'); if (!log) return;
  $('.lee-agent-welcome', log)?.remove();
  /* A turn already in flight when this pane attached has no card yet: its prompt is in the feed,
     and the `user` event below fills the title in. */
  if (!card) { card = agentTurnCard({model: $('#agentmodel')?.value || ''}); log.appendChild(card); trimAgentLog(log); }
  let host = turnBody(card);
  let progress = agentProgress(host);
  let timelineRoot = document.createElement('div'); timelineRoot.className = 'lee-agent-timeline';
  host.appendChild(timelineRoot); stickAgentLog(log);
  let timeline = agentTimeline(timelineRoot), seen = timeline.actions;
  // A steer is drawn by the steer block, which is not in this scope. It belongs in the turn,
  // between the prose before it and the call after, so it needs the same painter.
  ag.timeline = timeline;
  let raw = '', runDone = false, lastSeq = since, body = null;
  const checkpoints = new Set();
  if (ag.stream) { ag.stream._leeStopped = true; ag.stream.close(); }
  const generation = ++ag.streamGen; let es, reconnecting = false;
  const reconnect = ms => { if (reconnecting || generation !== ag.streamGen) return; reconnecting = true; setTimeout(() => { reconnecting = false; if (generation === ag.streamGen) connect(); }, ms); };
  const connect = () => {
    es = new EventSource('/agent/stream?since=' + lastSeq + '&follow=1' +
      (thread ? '&thread=' + encodeURIComponent(thread) : '')); ag.stream = es;
    /* EventSource fires `error` for a dropped socket as well as for a frame the server named
       `error`, and the dropped one carries no data. Parsing it would throw. */
    /* One wake of the feed hands over every row that has arrived since the last, so a burst of
       chunks used to be a full paint each: `timeline.chunk` re-rendering the whole reply, a phase
       write and a scroll write per row, of which only the last was ever seen. The prose is
       gathered and painted once a frame instead. Every other event flushes it first, because
       `seal`, `done` and the rest are ordered against the text that came before them. */
    let pending = '', frame = 0;
    const flush = () => {
      frame = 0;
      const text = pending; pending = '';
      if (!text) return;
      body = timeline.chunk(text);
      progress.phase('Writing response');
      // `chunk` renders asynchronously, so this measures the pane as it was before the text landed.
      // The real one is the `lee-markdown-rendered` listener in `live.js`; this one is for the
      // height the progress strip and the timeline rows just took.
      stickAgentLog(log);
    };
    const dedupe = (fn, streaming = false) => ev => {
      if (typeof ev.data !== 'string') return;
      let d; try { d = JSON.parse(ev.data); } catch (_) { return; }
      if (d.seq <= lastSeq) return;
      if (!streaming) flush();
      lastSeq = d.seq; fn(d, ev);
    };

  es.addEventListener('activity', dedupe(a => {
    const fresh = !seen.has(a.action_id || a.id), row = timeline.activity(a);
    if (fresh && row) row.animate([{opacity: 0, transform: 'translateY(4px)'}, {opacity: 1, transform: 'translateY(0)'}],
      {duration: 220, easing: 'cubic-bezier(.16,1,.3,1)'});
    refreshAgentBudget();
    const lifecycle = approvalCards.get(a.action_id || a.id);
    if (lifecycle && a.done) {
      lifecycle.classList.remove('running', 'proposed'); lifecycle.classList.add(a.ok ? 'complete' : 'failed');
      const actions = $('.lee-approval-actions', lifecycle);
      if (actions && !lifecycle.querySelector('.lee-checkpoint-result'))
        actions.before(checkpointResult(a.detail, a.ok, a.secs));
      const checkpointState = $('.lee-checkpoint-title small', lifecycle);
      if (checkpointState) checkpointState.textContent = a.ok ? 'Completed' : 'Tool failed';
      const actionState = $('.lee-approval-actions > span', lifecycle);
      if (actionState) actionState.innerHTML = a.ok
        ? (lifecycle.dataset.retryable === 'true'
            ? '<strong>Completed</strong><small>You can rerun this read-only tool without changing the conversation.</small>'
            : '<strong>Completed</strong><small>To run it again, ask the agent so you can review a new checkpoint.</small>')
        : '<strong>Failed</strong><small>The output above explains what the tool returned.</small>';
      updateAgentRunstrip();
    }
    if (a.done && a.ok && a.kind === 'edit' && a.args?.path) agentHost.reloadFile(a.args.path);
    progress.phase(a.done ? 'Reviewing tool results' : (a.summary || `Running ${a.tool}`));
    stickAgentLog(log);
  }));

  /* A turn already in flight when this pane attached: its prompt is in the feed, not on screen.
     `sendAgent` replays from its own user event, so it never arrives twice. */
  es.addEventListener('user', dedupe(d => {
    // `timelineRoot`'s parent, not the log: `insertBefore` throws when the reference is not a child,
    // and the throw was swallowed after `lastSeq` had already advanced, losing the prompt for good
    timelineRoot.parentElement.insertBefore(userMessage(d.text || ''), timelineRoot);
    const title = $('.lee-agent-turn-title', card);
    if (title && title.textContent === '(no prompt)') title.textContent = String(d.text || '').replace(/\s+/g, ' ').trim();
    stickAgentLog(log);
  }));

  es.addEventListener('chunk', dedupe(d => {
    raw += d.text || ''; pending += d.text || '';
    frame ||= requestAnimationFrame(flush);
  }, true));

  es.addEventListener('approval', dedupe(d => {
    checkpoints.add(d.id);
    timeline.seal(); progress.phase('Waiting for your approval'); showApproval(d, timelineRoot);
  }));
  es.addEventListener('execution', dedupe(d => updateAgentRunstrip(d)));
  es.addEventListener('state', dedupe(d => updateAgentRunstrip(d)));
  es.addEventListener('steer', dedupe(d => {
    timeline.seal(); if ('queued_steer' in d) setQueuedSteer(d.queued_steer || '', d.text || '');
  }));
  es.addEventListener('title', dedupe(d => { if (d.title) ag.title = titleText(d.title); }));
  /* Only a stopped run is announced here. `done` still follows and owns the end of the turn, so
     this says what happened to the run and touches nothing `done` will set. */
  es.addEventListener('run', dedupe(run => {
    timeline.seal(); ag.runs = (ag.runs || []).filter(r => r.id !== run.id);
    updateAgentRunstrip({runs: ag.runs});
    status(run.state === 'detached' ? 'provider detached; no further output will be used' : run.state, 'ok');
  }));
  es.addEventListener('compaction', dedupe(d => {
    timeline.seal(); const note = document.createElement('details'); note.className = 'lee-compaction-event';
    note.innerHTML = `<summary>Context compacted automatically · ${esc(d.strategy)} · ${esc(d.note)}</summary><pre>${esc(d.text || '')}</pre>`;
    timelineRoot.appendChild(note); progress.phase('Context compacted; continuing from checkpoint');
  }));

  es.addEventListener('error', dedupe((d, ev) => {
    ev.stopImmediatePropagation(); raw += d.message || ''; body = timeline.chunk(d.message || '');
  }));
  /* The feed no longer holds what this tab missed, so the turns come from history:
     `/agent/transcript` carries executed cells, never the conversation. Nothing on screen is
     cleared until the replacement is in hand. */
  es.addEventListener('resync', dedupe(async d => {
    es.close();
    try {
      const history = await api('/agent/history' + (thread ? '?thread=' + encodeURIComponent(thread) : '')),
            sessions = history.sessions || [];
      const group = sessions.find(s => s.id === thread) || sessions.find(s => s.id === history.current);
      const turns = await sessionTurns(group?.id);
      if (!turns.length) throw new Error('no recorded turns for this conversation');
      agentHost.dropEditors(log); log.innerHTML = ''; approvalCards.clear(); log.dataset.foldScope = '';
      progress.finish(false);   // its 250ms clock is cleared by `finish` alone, and it is replaced below
      renderTurns(log, turns, 'Recovered conversation');
      /* `renderTurns` paints durable turns only, so a turn still in flight was painted nowhere and
         the rest of it streamed into a detached root. It gets a fresh card, and everything this
         listener paints into is re-pointed at it. */
      if (!runDone) {
        card = agentTurnCard({model: d.model || $('#agentmodel')?.value || ''});
        log.appendChild(card); host = turnBody(card);
        progress = agentProgress(host);
        timelineRoot = document.createElement('div'); timelineRoot.className = 'lee-agent-timeline';
        host.appendChild(timelineRoot);
        timeline = agentTimeline(timelineRoot); seen = timeline.actions; ag.timeline = timeline;
        body = null; raw = '';
        refoldAfter(log);   // the last durable turn is no longer the newest, so it may fold again
      }
      // The transcript was replaced under the reader, so there is no scroll position left to keep.
      stickAgentLog(log, true); lastSeq = d.latest; reconnect(0);
    } catch (e) {
      status('conversation replay failed; retrying without clearing the transcript', 'err');
      reconnect(1000);
    }
  }));

  es.addEventListener('done', dedupe(async d => {
    timeline.seal(); retireCheckpoints(checkpoints); runDone = true; agentHost.busy = false; ag.runs = []; setAgentStatus('ready'); progress.finish(true); updateAgentRunstrip({runs: []}); refreshAgentBudget();
    // a turn that ended on a call has no prose block, and its pictures are still its own
    const closing = body || timelineRoot;
    addResponseRevision(closing, d.turn_id, raw, d.capabilities || {}); drawTurnMedia(closing, d.media);
    const usage = usageMeta(d.usage, d.usage_label, d.model); if (usage) timelineRoot.appendChild(usage);
    for (const e of (d.edits || []))
      // into the turn's body, not `agentLog`: what this turn wrote is part of this turn
      host.insertAdjacentHTML('beforeend',
        `<div class="lee-runline"><span class="sub">✎ ${esc(e.path.split('/').pop())} ${esc(e.label)}</span></div>` +
        `<div class="lee-diff inline">${agentHost.diffHtml(e.rows)}</div>`);
    if (d.turn_id) card.dataset.turn = d.turn_id;
    stickAgentLog(log);
    const tail = d.usage_label ? `${d.note || 'done'} · ${d.usage_label}` : (d.note || 'done');
    showProblems(d.problems, host);   // a turn's problems belong to that turn
    if ((d.problems || []).length) status(d.problems[d.problems.length - 1], 'err');
    else status(d.ok ? tail : (d.note || 'assistant unavailable'), d.ok ? 'ok' : 'err');
    await agentHost.reloadAfterEdits(d.edits || []);
  }));

  es.onerror = () => {
    if (es._leeStopped || generation !== ag.streamGen) return;
    es.close(); status(runDone ? 'connection lost; restoring conversation updates…' : 'connection lost; replaying the running turn…', 'busy'); reconnect(500);
  };
  };
  connect();
}

