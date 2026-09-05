"The agent as routes: its threads, turns, approvals, budgets, memory and history."

from __future__ import annotations

import asyncio, json, os, re
from pathlib import Path

from fasthtml.common import JSONResponse, StreamingResponse
from fastcore.all import L, first, ifnone

from .web import errstr
from ramabana.core import model_note
from ramabana.runtime import estimate_tokens
from .web import diff_payload, fail, off_loop, sse
from .cfg import pii_gate
from .cfg import STEP_RANGE, TOOL_RANGE
from .port import NO_DOCS, NO_EXECUTION, NO_FILES, NO_MEMORY
from .threads import TurnError
from .turns import (edit_diffs, history_sessions, latest_started_here, project_state_context,
                    surfaces, tool_preview, tool_schemas, with_capabilities)

__all__ = ['CAPS', 'connect']

CAPS = ('fs', 'memory', 'ai', 'inline_ai', 'docs')

def connect(app, port):
    rt = app.route
    #: a host with no kernels supplies no `execution`; the null one keeps the routes answering
    ex = port.execution or NO_EXECUTION
    mem = getattr(port, 'memory', None) or NO_MEMORY
    fs = getattr(port, 'files', None) or NO_FILES
    docs = getattr(port, 'docs', None) or NO_DOCS
    def _doc(): return docs.current()
    async def api(path, params=None, timeout=15):
        client = await ex.runtime()
        return await client.api(path, params, timeout) if client else None
    async def api_peek(path, params=None, timeout=15):
        "The runtime's inspector, but only where one is already running."
        client = ex.kernel_peek()
        return await client.api(path, params, timeout) if client else None

    def live_assistants():
        "Only the assistants already built -- reaching for `port.assistants.agent` here would construct one."
        rows = port.threads.rows() if port.built_threads is not None else []
        return L(*[t.ai for t in rows], port.assistants.built_agent, port.assistants.built_inline).filter(lambda a: a is not None).unique()
    def refresh_assistants():
        for a in live_assistants(): a.refresh()
    def _set_agent_state(text, layer='task', enabled=True, source='user'):
        "State is the workspace's: every live conversation is re-briefed, not only the one on screen."
        out = port.assistants.agent.set_state(text, layer=layer, enabled=enabled, source=source)
        refresh_assistants()
        return out
    def _run_missing(t, run_id):
        return JSONResponse({'ok': False, 'code': 'run_not_found', 'thread': t.id, 'run': run_id,
                             'message': 'that run is not in this conversation'}, status_code=404)
    def _thread(target=''):
        "The conversation a request names, resolved once. Omitted means the one on screen now."
        target = str(target or '').strip()
        return port.threads.require(target) if target else port.threads.active
    def _thread_error(e):
        "Only a refusal is a conflict. Anything else is a bad request, or a bug wearing its own name."
        from .threads import TurnError
        if isinstance(e, TurnError): return JSONResponse(e.dict(), status_code=409)
        return fail(e, 400 if isinstance(e, (KeyError, ValueError)) else 500)
    def _grouped_history(ai, execution):
        "Sessions with their turns, computed once per state of the log."
        here = surfaces(getattr(ai, 'cfg', None))
        key = (port.history.stamp(ai), repr(sorted(r.get('id', '') for r in execution)), len(here))
        if _history_cache.get('key') != key:
            turns = port.history.with_timelines([r for r in ai.history if r.get('model') != 'scripted'])
            # the sidecar is where a conversation's name lives, and grouping cannot see it
            named = {row['id']: row for row in ai.sessions()}
            _history_cache.update(key=key, groups=[
                {**g, **{k: v for k, v in (named.get(g['id']) or {}).items() if k in ('title', 'muted')}}
                for g in history_sessions(turns, execution, here)])
        return _history_cache['groups']
    def _settled_thread(target=''):
        "The conversation a branch operation may act on."
        t = _thread(target)
        if t.state == 'working': raise TurnError('thread_busy', 'stop this conversation before reshaping it', t.id)
        if t.state == 'waiting': raise TurnError('thread_busy', 'answer the waiting checkpoint first', t.id)
        return t
    def _history_changed(t, held):
        return JSONResponse({'ok': False, 'code': 'history_changed', 'thread': t.id,
                             'message': f'this conversation moved to revision {held["revision"]}',
                             'revision': held['revision']}, status_code=409)
    def _branch_reply(t, branch, **extra):
        return {'ok': True, 'thread': t.id, 'active': t.ai.current_branch_id, **branch, **extra}
    def _branch_error(e, t=None):
        if isinstance(e, TurnError): return JSONResponse(e.dict(), status_code=409)
        code = 'branch_point_invalid' if isinstance(e, (KeyError, ValueError)) else 'branch_failed'
        if type(e).__name__ == 'BranchChanged': code = 'history_changed'
        return JSONResponse({'ok': False, 'code': code, 'message': errstr(e),
                             'thread': getattr(t, 'id', '')}, status_code=409 if t is not None else 400)
    _history_cache = {}
    @rt('/agent/attachment')
    async def agent_attachment(req):
        """Save a pasted image inside the active workspace and return its attachment path."""
        d = await req.json()
        path = str(d.get('path') or '').strip()
        if path:
            image_exts = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'}
            p = fs._check(path, must_exist=True)
            if not p.is_file() or p.suffix.lower() not in image_exts:
                return fail('attachment is not a workspace image')
            return {'ok': True, 'path': str(p), 'name': p.name}
        url = str(d.get('data_url') or '')
        if not url.startswith('data:image/'):
            return fail('no image attachment')
        if len(url) > 12_000_000:
            return fail('image attachment is larger than 9 MB', 413)
        import base64
        try: data = base64.b64decode(url.split(',', 1)[1], validate=True)
        except Exception as e: return fail(e)
        if len(data) > 9_000_000: return fail('image attachment is larger than 9 MB', 413)
        ext = '.png' if url.startswith('data:image/png') else '.jpg'
        folder = ex.cwd_for() / '.leela-attachments'
        folder.mkdir(parents=True, exist_ok=True)
        p = folder / f'paste-{os.urandom(6).hex()}{ext}'
        p.write_bytes(data)
        return {'ok': True, 'path': str(p), 'name': p.name}
    @rt('/agent/info')
    async def agent_info(): return await api('/agent/api/info') or {'mode': 'off'}
    @rt('/agent/sessions')
    async def agent_sessions():
        return await api('/agent/api/sessions') or {'current': None, 'sessions': []}
    @rt('/agent/transcript')
    async def agent_transcript(session: str = ''):
        live = await api('/agent/api/transcript', {'session': session}) or {'cells': []}
        return {'id': live.get('id'), 'path': live.get('path'), 'cells': live.get('cells', []),
                'agent': list(port.assistants.agent.history) if not session else [],
                'inline': list(port.assistants.inline.history) if not session else []}
    @rt('/agent/resume')
    async def agent_resume(req):
        "Resume a saved conversation as an isolated live thread."
        d = await req.json()
        session = str(d.get('session') or 'latest')
        if session == 'latest' and not d.get('everything'):
            await off_loop(port.history.fresh, port.assistants.agent)
            session = latest_started_here(port.assistants.agent) or 'latest'
        try: thread = await off_loop(port.threads.resume, session)
        except Exception as e:
            from .threads import TurnError
            return _thread_error(e) if isinstance(e, TurnError) else fail(e)
        turns = [t for t in thread.ai.history if t.get('session') == thread.id]
        return {'ok': True, 'session': thread.id, 'note': thread.ai.note, 'turns': port.history.with_timelines(turns)}
    @rt('/agent/threads')
    def agent_threads():
        active = port.threads.active
        return {'active': active.id, 'threads': port.threads.dicts(),
                'attention': port.threads.attention()}
    @rt('/agent/thread/new')
    async def agent_thread_new():
        try: thread = await off_loop(port.threads.new)
        except Exception as e: return _thread_error(e)
        return {'ok': True, 'active': thread.id, 'thread': thread.dict()}
    @rt('/agent/thread/switch')
    async def agent_thread_switch(req):
        d = await req.json()
        try: thread = port.threads.switch(str(d.get('thread') or ''))
        except Exception as e: return _thread_error(e)
        return {'ok': True, 'active': thread.id, 'thread': thread.dict()}
    @rt('/agent/thread/close')
    async def agent_thread_close(req):
        d = await req.json()
        try: closed = await off_loop(port.threads.close, str(d.get('thread') or ''))
        except Exception as e: return _thread_error(e)
        return {'ok': True, 'closed': closed, 'active': port.threads.active_id, 'threads': port.threads.dicts()}
    @rt('/agent/thread/mute')
    async def agent_thread_mute(req):
        "Silence one conversation's notifications without hiding that it is waiting."
        d = await req.json()
        try: thread = port.threads.mute(str(d.get('thread') or ''), bool(d.get('muted', True)))
        except Exception as e: return _thread_error(e)
        return {'ok': True, 'thread': thread.dict(), 'attention': port.threads.attention()}
    @rt('/agent/thread/turns')
    async def agent_thread_turns(thread: str = ''):
        "One conversation's durable turns, and the point in its feed a live turn replays from."
        try: t = _thread(thread)
        except Exception as e: return _thread_error(e)
        await off_loop(port.history.fresh, t.ai)
        turns = [r for r in t.ai.history if r.get('session') == t.id]
        # `dict` is where a summarised name lives; `title` alone is only what a person typed
        row = t.dict()
        return {'ok': True, 'thread': t.id, 'state': row['state'], 'seq': t.feed.settled_seq,
                'title': row['title'], 'turns': with_capabilities(t.ai, port.history.with_timelines(turns))}
    @rt('/agent/thread/title')
    async def agent_thread_title(req):
        d = await req.json()
        try: thread = await off_loop(port.threads.title, str(d.get('thread') or ''), d.get('title') or '')
        except Exception as e: return _thread_error(e)
        return {'ok': True, 'thread': thread.dict()}
    @rt('/agent/new')
    async def agent_new():
        try: thread = await off_loop(port.threads.new)
        except Exception as e: return _thread_error(e)
        return {'ok': True, 'session': thread.id}
    @rt('/agent/history')
    async def agent_history(thread: str = '', everything: bool = False):
        "Leela's durable conversations, newest first, without their turns. `everything` adds the CLI's."
        try: t = _thread(thread)
        except Exception as e: return _thread_error(e)
        ai = t.ai
        execution = await api_peek('/agent/api/sessions') or {'sessions': []}
        await off_loop(port.history.fresh, ai)
        groups = _grouped_history(ai, execution.get('sessions', []))
        theirs = len([g for g in groups if g.get('app') != 'leela'])
        if not everything: groups = [g for g in groups if g.get('app') == 'leela']
        sessions = [{**g, 'turns': [], 'count': len(g['turns'])} for g in groups]
        return {'sessions': sessions, 'model': ai.model.name, 'current': ai.session_id,
                'thread': t.id, 'only_leela': not everything, 'hidden': 0 if everything else theirs}
    @rt('/agent/history/session')
    async def agent_history_session(id: str = '', thread: str = ''):
        "One stored conversation's turns, fetched when it is opened rather than with the list."
        try: t = _thread(thread)
        except Exception as e: return _thread_error(e)
        await off_loop(port.history.fresh, t.ai)
        execution = await api('/agent/api/sessions') or {'sessions': []}
        group = first(g for g in _grouped_history(t.ai, execution.get('sessions', []))
                      if g['id'] == str(id))
        if group is None: return fail(f'no such conversation {id}', 404)
        return {'ok': True, 'id': group['id'], 'count': len(group['turns']),
                **{**group, 'turns': with_capabilities(t.ai, group['turns'])}}
    @rt('/agent/models')
    def agent_models(legacy: bool = True, refresh: bool = False):
        "Every model the picker offers, and which one each routed job is on."
        from ramabana.core import DFLT_LOCAL, available_models, auth_status, resolve
        from .models import JOB_HELP, catalog, forget_probes, load_models, mark_models, probed, runtimes
        notes = {}
        def _try(what, f, dflt=None):
            "`f()`, or `dflt` and a note saying why: no one failure may blank the picker."
            try: return f()
            except Exception as e: notes[what] = errstr(e); return dflt
        # `selected` and the dedupe both resolve every row, so the same name is asked for many
        # times in one request. Once each.
        _specs = {}
        def _spec(name):
            if name not in _specs: _specs[name] = _try(name, lambda: resolve(name))
            return _specs[name]
        def _name(what, get, dflt): return _try(what, get, dflt) or dflt
        saved = _try('saved models', load_models, []) or []
        # The catalog and the id each row resolves to are the machine's, not this workspace's.
        # Probed together, served from the last answer, refreshed behind this.
        if refresh: forget_probes(disk=True)   # the button means ask again, not read the last answer
        rows, by_id = _try('model catalog', lambda: probed(f'catalog:{legacy}',
                                                           lambda: catalog(legacy)), ([], {})) or ([], {})
        rows = [dict(r) for r in rows]      # decorated below with this workspace's own choices
        rows += [{'value':x['name'],'label':x['name'],'provider':x['runtime'],
                  'source':f"saved · {x['model_id']}",'custom':True} for x in saved]
        agent_dflt = port.settings.model or os.environ.get('LEELA_MODEL') or DFLT_LOCAL
        agent = _name('agent model', lambda: port.assistants.agent.model.name, agent_dflt) if port.assistants.built_agent is not None else agent_dflt
        inline_dflt = port.settings.inline_model or os.environ.get('LEELA_MODEL_INLINE') or 'gpt-mini'
        inline = (_name('inline model', lambda: port.assistants.inline.model.name, inline_dflt)
                  if port.assistants.built_inline is not None else inline_dflt)
        completion_dflt = port.settings.completion_model or os.environ.get('LEELA_MODEL_COMPLETION') or 'gpt-4.1'
        completion = (_name('completion model', lambda: port.assistants.agent.routing.name_for('completion'), completion_dflt)
                      if port.assistants.built_agent is not None else completion_dflt)
        for current in (agent, inline, completion):
            spec = _spec(current)
            if spec is None:
                why = f'unavailable ({notes.get(current, "")})'
                row = first(r for r in rows if r['value'] == current)
                if row is None: rows.append(row := {'value': current, 'label': current})
                row.update(provider='unavailable', source=why, unavailable=True)
                continue
            if spec.model_id not in by_id:
                provider = spec.model_id.partition('/')[0] if not spec.local else spec.runtime
                rows.append({'value': current, 'label': current, 'provider': provider,
                             'source': 'saved choice · provider credentials may be required'})
        def selected(current):
            "Which row a chosen model is, by the id it resolves to. A lookup, not a scan."
            spec = _spec(current)
            return current if spec is None else by_id.get(spec.model_id, current)
        # The routed jobs with no field of their own, reported chosen or not.
        from ramabana.core import JOBS, Routing
        routing = port.assistants.agent.routing if port.assistants.built_agent is not None else Routing(turn=agent)
        if port.assistants.built_agent is None: routing.policy.update(port.settings.job_models)
        # `**jobs` is spread last, and `inline` has a field of its own.
        jobs = {j: _name(f'{j} model', lambda j=j: routing.name_for(j), '')
                for j in JOBS if j not in ('turn', 'completion', 'inline')}
        # The catalog's rows are marked already; only the saved aliases and the rows added for
        # an unavailable choice still need it.
        return {'models': mark_models(rows), 'saved':saved, 'notes': notes,
                # Asking every account whether it is signed in is the other slow half.
                'auth': _try('auth', lambda: probed('auth', auth_status), {}) or {},
                # What is installed here, which is a second cold and another machine-wide answer.
                'runtimes': _try('runtimes', lambda: probed('runtimes', runtimes), []) or [],
                'jobs': jobs, 'job_help': JOB_HELP,
                'selected': {'agent': selected(agent), 'inline': selected(inline),
                             'completion': selected(completion), **jobs}}
    @rt('/agent/models/add')
    async def agent_models_add(req):
        "Save a Hugging Face repo/URL or hosted provider model alias."
        from .models import save_model
        try:return {'ok':True,'model':save_model(await req.json())}
        except Exception as e:return fail(e)
    @rt('/agent/models/remove')
    async def agent_models_remove(req):
        from .models import delete_model
        try:return {'ok':True,'name':delete_model((await req.json()).get('name',''))}
        except Exception as e:return fail(e)
    @rt('/agent/setup')
    def agent_setup():
        "The first-run choice: what already works here, and what a download would add."
        from .models import setup_plan
        try: return {'ok': True, **setup_plan()}
        except Exception as e: return fail(e)
    @rt('/agent/setup/dismiss')
    async def agent_setup_dismiss(req):
        "Answered, so stop offering it. Reopening it is the runtimes control in settings."
        from .models import dismiss_setup
        try: return {'ok': True, 'dismissed': dismiss_setup(bool((await req.json()).get('dismissed', True)))}
        except Exception as e: return fail(e)
    @rt('/agent/updates')
    def agent_updates():
        "What is installed here with a newer release, and whether this Leela has one."
        from .models import updates
        try: return {'ok': True, **updates()}
        except Exception as e: return fail(e)
    @rt('/agent/runtimes')
    def agent_runtimes():
        "The backends and what each is doing, for the pane to poll while one installs."
        from .models import runtimes
        try: return {'ok': True, 'runtimes': runtimes()}
        except Exception as e: return fail(e)
    @rt('/agent/runtimes/install')
    async def agent_runtimes_install(req):
        "Start fetching one on-device backend. Returns at once; the row carries the state."
        from .models import install_runtime
        try: return {'ok': True, 'install': install_runtime(str((await req.json()).get('runtime') or ''))}
        except Exception as e: return fail(e)
    @rt('/agent/settings')
    async def agent_settings(req):
        "Set engine-level agent options. LiteRT engines reload lazily after a change."
        d = await req.json()
        if 'litert_backend' in d:
            try:
                from .ai import Assistant
                which = str(d.get('litert_backend') or '').strip().lower()
                if which not in Assistant.LITERT_BACKENDS:
                    raise ValueError(f'litert backend must be one of {", ".join(Assistant.LITERT_BACKENDS)}')
                live = live_assistants()
                for a in live: a.set_litert_backend(which)
                if not live: os.environ['LEELA_LITERT_BACKEND'] = which
                port.settings.litert_backend = which
                port.history.save()
                return {'ok': True, 'litert_backend': which,
                        'note': f'LiteRT runs on the {which.upper()}; engines reload on the next request'}
            except Exception as e: return fail(e)
        try:
            enabled = d.get('local_multimodal')
            if not isinstance(enabled, bool): raise ValueError('local_multimodal must be true or false')
            live = live_assistants()
            if any(a.busy for a in live): raise RuntimeError('cannot change local multimodal while an assistant is working')
            for a in live: a.set_local_multimodal(enabled)
            port.settings.local_multimodal = enabled
            port.history.save()
            return {'ok': True, 'local_multimodal': enabled,
                    'note': f'local image/audio encoders {"enabled" if enabled else "disabled"}'}
        except Exception as e: return fail(e)
    @rt('/agent/workspace-repo-writes')
    async def agent_workspace_repo_writes(req):
        d = await req.json(); enabled = d.get('enabled')
        if not isinstance(enabled, bool): return fail('enabled must be true or false')
        port.settings.allow_workspace_repo_writes = enabled; port.history.save()
        return {'ok': True, 'enabled': enabled,
                'note': f'workspace repository writes {"enabled" if enabled else "disabled"}; approval rules still apply'}
    @rt('/agent/subagent-writes')
    async def agent_subagent_writes(req):
        "Whether delegated sub-agents get the write tools. Approvals and recording apply either way."
        d = await req.json(); enabled = d.get('enabled')
        if not isinstance(enabled, bool): return fail('enabled must be true or false')
        try:
            live = live_assistants()
            if any(a.busy for a in live): raise RuntimeError('cannot change sub-agent writes while an assistant is working')
            for a in live: a.set_subagent_writes(enabled)
        except Exception as e: return fail(e)
        port.settings.subagent_writes = enabled; port.history.save()
        return {'ok': True, 'enabled': enabled,
                'note': ('sub-agents may write, run commands and run Python. Every call is recorded and approved'
                         if enabled else 'sub-agents read only again')}
    @rt('/agent/read-outside')
    async def agent_read_outside(req):
        "Reads outside the open folders. Writes are unaffected, and credentials stay refused."
        d = await req.json(); enabled = d.get('enabled')
        if not isinstance(enabled, bool): return fail('enabled must be true or false')
        port.settings.agent_read_outside = enabled; port.history.save()
        return {'ok': True, 'enabled': enabled,
                'note': f'reads outside the open folders {"allowed" if enabled else "refused"}; writes are unchanged'}
    @rt('/agent/vault-pii')
    async def agent_vault_pii(req):
        "What a vault retrieval hands the model: everything, masked identifiers, or nothing at all."
        d = await req.json()
        try: policy = pii_gate(d.get('pii'))
        except ValueError as e: return fail(e)
        port.settings.vault_pii = policy; port.history.save()
        said = {'off': 'the model reads the vault as it is',
                'redact': 'identifiers are masked before the model sees them',
                'refuse': 'sections holding personal information are withheld from the model'}
        return {'ok': True, 'pii': policy, 'note': said[policy]}
    @rt('/agent/compaction')
    async def agent_compaction(req):
        "Configure visible automatic compaction without restarting the model conversation."
        d = await req.json(); strategy = d.get('strategy', port.settings.compact_strategy)
        if strategy not in {'surgical', 'summary'}: return fail('strategy must be surgical or summary')
        auto = d.get('auto', port.settings.compact_auto)
        if not isinstance(auto, bool): return fail('auto must be true or false')
        port.settings.compact_auto, port.settings.compact_strategy = auto, strategy
        for agent in live_assistants():
            agent.compactor.auto, agent.compactor.strategy = auto, strategy
        port.history.save()
        return {'ok': True, 'auto': auto, 'strategy': strategy,
                'note': f'auto compaction {"on" if auto else "off"} · {strategy}'}
    @rt('/agent/budget')
    async def agent_budget(req):
        "How much work one turn may do, changed without restarting the conversation."
        from .cfg import budget_value
        d = await req.json()
        for key, given in (('tool_budget', d.get('tools')), ('step_budget', d.get('steps'))):
            if given is None: continue
            lo, hi = TOOL_RANGE if key == 'tool_budget' else STEP_RANGE
            value = budget_value(given, lo, hi)
            if value == 'auto' and str(given).strip().lower() != 'auto':
                return fail(f'{key}: use auto, or a number from {lo} to {hi}')
            setattr(port.settings, key, value)
        for agent in live_assistants(): agent.tool_budget, agent.step_budget = port.settings.tool_budget, port.settings.step_budget
        port.history.save()
        return {'ok': True, 'tools': port.settings.tool_budget, 'steps': port.settings.step_budget,
                'note': f'tool budget {port.settings.tool_budget} · steps {port.settings.step_budget}'}
    @rt('/agent/budget/state')
    def agent_budget_state():
        "What is actually in force, so a refused edit can put the box back rather than blank it."
        return {'ok': True, 'tools': port.settings.tool_budget, 'steps': port.settings.step_budget,
                'tool_range': list(TOOL_RANGE), 'step_range': list(STEP_RANGE)}
    @rt('/agent/model')
    async def agent_model(req):
        d = await req.json()
        try:
            from ramabana.core import JOBS
            from .models import load_models
            load_models()
            # `agent` and `inline` are two assistants, each on its own `turn`; the rest are jobs.
            target = d.get('target', 'agent')
            if target not in ('agent', 'inline') and target not in JOBS:
                return fail(f'unknown model target {target!r}')
            assistant = port.assistants.inline if target == 'inline' else port.assistants.agent
            job = 'turn' if target in ('agent', 'inline') else target
            spec = assistant.set_model((d.get('model') or '').strip(), job=job)
            if target == 'inline': port.settings.inline_model = spec.name
            elif target == 'completion': port.settings.completion_model = spec.name
            elif target == 'agent': port.settings.model = spec.name
            else: port.settings.job_models[job] = spec.name
            port.history.save()
            return {'ok': True, 'target': target, 'model': spec.name, 'note': model_note(spec)}
        except Exception as e: return fail(e)
    @rt('/agent/memory')
    async def agent_memory():
        "Editable notes and their explicit per-model session routing."
        notes = await off_loop(mem.agent_notes)
        rows = [{**note, 'text': await off_loop(mem.exact_text, str(note['id']))} for note in notes]
        return {'notes': rows, 'selected': port.settings.agent_memory_selection,
                'targets': {'agent': 'Agent conversation', 'inline': 'Prompt cells and inline AI',
                            'completion': 'Code completion'}}
    @rt('/agent/memory/save')
    async def agent_memory_save(req):
        d = await req.json(); title = (d.get('title') or '').strip(); text = (d.get('text') or '').strip()
        if not text: return fail('memory note is empty')
        previous = str(d.get('id') or '')
        saved = await off_loop(mem.remember_agent_note, title, text, previous)
        if not saved: return fail(mem.note)
        new_id = str(saved.get('doc_id') or '')
        if previous and new_id:
            for target, ids in port.settings.agent_memory_selection.items():
                port.settings.agent_memory_selection[target] = [new_id if value == previous else value for value in ids]
        requested = d.get('targets', [])
        if not isinstance(requested, list): return fail('targets must be a list')
        for target in requested:
            if target not in port.settings.agent_memory_selection: return fail('targets must contain only agent, inline, or completion')
            if new_id and new_id not in port.settings.agent_memory_selection[target]: port.settings.agent_memory_selection[target].append(new_id)
        port.history.save()
        refresh_assistants()
        return {'ok': True, 'id': new_id, 'note': mem.note}
    @rt('/agent/memory/select')
    async def agent_memory_select(req):
        d = await req.json(); target = str(d.get('target') or '')
        if target not in port.settings.agent_memory_selection: return fail('target must be agent, inline, or completion')
        ids = d.get('ids')
        if not isinstance(ids, list): return fail('ids must be a list')
        known = {str(note['id']) for note in await off_loop(mem.agent_notes)}
        selected = list(dict.fromkeys(str(value) for value in ids if str(value) in known))
        port.settings.agent_memory_selection[target] = selected; port.history.save()
        assistant = port.assistants.built_agent if target in {'agent', 'completion'} else port.assistants.built_inline
        if assistant is not None: assistant.refresh()
        tokens = sum([estimate_tokens(await off_loop(mem.exact_text, v)) for v in selected])
        return {'ok': True, 'target': target, 'ids': selected, 'tokens': tokens}
    @rt('/agent/memory/delete')
    async def agent_memory_delete(req):
        doc_id = str((await req.json()).get('id') or '')
        known = {str(note['id']) for note in await off_loop(mem.agent_notes)}
        if doc_id not in known: return fail('unknown agent memory note')
        for target, ids in port.settings.agent_memory_selection.items():
            port.settings.agent_memory_selection[target] = [value for value in ids if value != doc_id]
        ok = await off_loop(mem.forget, doc_id); port.history.save()
        refresh_assistants()
        return {'ok': ok, 'note': mem.note}
    def _state_origin(state):
        "One saved state with where it came from: its layer, its folders, and whether they are ours."
        agent = dict(((state.get('meta') or {}).get('agent') or {}))
        roots = [str(r) for r in (agent.get('roots') or [])]
        def resolved(paths):
            out = set()
            for r in paths:
                try: out.add(str(Path(r).expanduser().resolve()))
                except (OSError, ValueError): out.add(str(r))
            return out
        mine = resolved(roots) == resolved(str(r) for r in fs.roots) if roots else False
        return {**state, 'layer': str(agent.get('layer') or ''), 'roots': roots,
                'where': ', '.join(Path(r).name for r in roots), 'mine': mine,
                'revision': agent.get('revision') or 0}
    @rt('/agent/states')
    def agent_states(scope: str = 'everywhere'):
        "Saved states, each saying where it came from, and the state now in the briefing."
        active = any(str(layer.get('text') or '').strip() and layer.get('enabled', True)
                     for layer in port.state.layers.values())
        states = [_state_origin(s) for s in mem.agent_states()]
        if scope == 'project': states = [s for s in states if s['mine']]
        return {'active': active, 'active_text': port.state.text, 'scope': scope,
                'layers': port.state.layers, 'states': states,
                'layers_seen': sorted({s['layer'] for s in states if s['layer']})}
    @rt('/agent/state/template')
    def agent_state_template():
        "A complete, usable rules template with this workspace's actual tool catalog."
        from .ai import STATE_TEMPLATE
        tools = tool_schemas(port.assistants.agent)
        catalog = '\n'.join(f"- `{t['name']}` ({t['group']}): {t['description']}" for t in tools)
        return {'template': STATE_TEMPLATE, 'tools': tools,
                'catalog': '## Available tools\n' + (catalog or '- No tools are currently available.')}
    @rt('/agent/state/bootstrap')
    async def agent_state_bootstrap(req):
        "Ask the summary model to fill a transparent charter from the template and real tools."
        from .ai import STATE_TEMPLATE
        d = await req.json(); intent = (d.get('intent') or '').strip()
        tools = tool_schemas(port.assistants.agent)
        catalog = '\n'.join(f"- {t['name']} [{t['group']}]: {t['description']}" for t in tools)
        project = '\n'.join(f'- {root}' for root in port.assistants.agent.host.roots) or '- no folder open'
        prompt = (f'<workspace>\n{project}\n</workspace>\n\n<available-tools>\n{catalog}\n</available-tools>\n\n'
                  f'<user-intent>\n{intent or "Help me configure a safe, effective coding agent for this workspace."}\n</user-intent>\n\n'
                  f'<template>\n{STATE_TEMPLATE}\n</template>\n\nFill every bracketed field with concrete, concise guidance. '
                  'Keep the headings exactly. Mention tools only when they actually appear in available-tools. '
                  'Do not invent project facts; mark unknown facts as needing confirmation.')
        text = await off_loop(port.assistants.agent.oneshot, prompt,
                               'Design a user-owned coding-agent charter. Return complete Markdown only.', 'summary', 1800)
        if not text: text = STATE_TEMPLATE + '\n\n## Available tools\n' + catalog
        return {'ok': True, 'text': text, 'tools': tools,
                'model': port.assistants.agent.routing.name_for('summary'), 'generated': text != STATE_TEMPLATE}
    @rt('/agent/state/draft')
    def agent_state_draft():
        "A structured, editable state distilled deterministically from the visible conversation."
        turns = list(port.assistants.agent.history[-12:]) if port.assistants.built_agent is not None else []
        conversation = '\n\n'.join(f"### User\n{t.get('prompt','')}\n\n### Agent\n{t.get('reply','')}"
                                   for t in turns)
        from .ai import STATE_TEMPLATE
        state = port.state.text or STATE_TEMPLATE
        return {'state': state, 'layers': port.state.layers,
                'conversation': conversation, 'turns': len(turns)}
    @rt('/agent/state/save')
    async def agent_state_save(req):
        "Save the user's edited state to durable semantic memory and optionally activate it."
        d = await req.json(); text = (d.get('text') or '').strip()
        if not text: return fail('agent state is empty')
        title = (d.get('title') or '').strip() or 'Agent state'
        layer = (d.get('layer') or 'task').strip()
        # The layer is saved with the state: which of organization, project or task a charter was
        # written for is most of what makes somebody else's reusable.
        saved = await off_loop(mem.remember_agent_state, title, text,
                                 {'session': port.assistants.agent.session_id if port.assistants.built_agent is not None else '',
                                  'turns': len(port.assistants.agent.history) if port.assistants.built_agent is not None else 0,
                                  'layer': layer,
                                  'roots': [str(root) for root in fs.roots]})
        if not saved: return fail(mem.note)
        if d.get('activate', True): _set_agent_state(text, layer=layer, source='memory')
        return {'ok': True, 'saved': saved, 'active': port.state.text}
    @rt('/agent/state/suggest')
    def agent_state_suggest(q: str = ''):
        "Relevant saved states remain advisory; the browser decides whether to attach one."
        states = {str(s['id']): s for s in mem.agent_states()}
        hits = mem.search(q, limit=12) if q.strip() else []
        ids = [i for i in dict.fromkeys(str(h.get('doc_id') or '') for h in hits) if i in states]
        return {'query': q, 'states': [states[i] for i in ids[:5]]}
    @rt('/agent/state/diagnostics')
    async def agent_state_diagnostics(req):
        "Token budget, stale paths, and duplicate/conflicting headings for edited state."
        d = await req.json(); text = str(d.get('text') or '')
        tokens = estimate_tokens(text, port.assistants.agent.backend.count_tokens if port.assistants.built_agent is not None else None)
        paths = set(re.findall(r'(?<![\w.-])(?:[\w.-]+/)+[\w.-]+', text))
        def absent(path):
            try: return not fs._check(path).exists()
            except Exception: return True
        missing = [p for p in paths if absent(p)]
        headings = [h.strip().lower() for h in re.findall(r'^#{1,3}\s+(.+)$', text, re.M)]
        duplicate = sorted({h for h in headings if headings.count(h) > 1})
        return {'tokens': tokens, 'context': port.assistants.agent.model.ctx if port.assistants.built_agent is not None else None,
                'missing_paths': sorted(missing), 'duplicate_headings': duplicate}
    @rt('/agent/state/update')
    async def agent_state_update(req):
        "Use the summary model to propose a reviewed state replacement; never activate automatically."
        d = await req.json(); current = str(d.get('current') or ''); conversation = str(d.get('conversation') or '')
        project = project_state_context(port)
        prompt = (f'<current-state>\n{current}\n</current-state>\n\n<conversation>\n{conversation[-20000:]}\n</conversation>\n\n'
                  f'<current-project>\n{project}\n</current-project>\n\n'
                  'Return the complete updated state using Goal, Constraints, Progress (Done/In progress/Blocked), '
                  'Key decisions, Next steps, and Critical context. Reconcile stale assumptions with current-project evidence. '
                  'Preserve still-valid user preferences, remove completed next steps, and never invent project facts.')
        text = await off_loop(port.assistants.agent.oneshot, prompt,
                               'Update explicit agent state. Return Markdown only, without a fence.', 'summary', 1600)
        if not text: return fail(port.assistants.agent.note or 'state update model returned nothing')
        return {'ok': True, 'text': text, 'diff': diff_payload(current, text)}
    @rt('/agent/state/activate')
    async def agent_state_activate(req):
        "Activate an edited state without adding it to durable memory."
        d = await req.json(); text = (d.get('text') or '').strip(); layer = d.get('layer') or 'task'
        try: _set_agent_state(text, layer=layer, enabled=d.get('enabled', True), source='user')
        except ValueError as e: return fail(e)
        return {'ok': True, 'state': text, 'layer': layer}
    @rt('/agent/state/compare')
    async def agent_state_compare(req):
        "Compare one remembered revision with edited text before replacing or merging it."
        d = await req.json(); text = await off_loop(mem.agent_state_text, str(d.get('id') or ''))
        if not text: return fail(mem.note or 'saved state is empty')
        current = str(d.get('current') or '')
        return {'ok': True, 'state': text, 'diff': diff_payload(current, text)}
    @rt('/agent/state/load')
    async def agent_state_load(req):
        "Load a remembered state into the live agent briefing, preserving its conversation history."
        d = await req.json(); doc_id = str(d.get('id') or ''); layer = d.get('layer') or 'task'
        text = await off_loop(mem.agent_state_text, doc_id)
        if not text: return fail(mem.note or 'saved state is empty')
        try: _set_agent_state(text, layer=layer, source='memory')
        except ValueError as e: return fail(e)
        return {'ok': True, 'state': text, 'layer': layer}
    @rt('/agent/commands')
    def agent_commands():
        "Slash-command metadata for the prompt's inline command picker."
        help_by_name = {name: help for name, (_, help) in port.assistants.agent.registry.commands.items()}
        builtins = {
            'model': 'show or change the model', 'cost': 'show token and cost totals',
            'compact': 'compact the current context', 'skills': 'list available skills',
            'skill': 'read one skill', 'tools': 'list tools available to the agent',
            'extensions': 'show loaded tool extensions', 'reload': 'reload tools, skills and extensions',
        }
        describe = lambda item: (getattr(item, '__doc__', '') or '').strip().split('\n')[0]
        return {
            'commands': [{'name': n, 'help': help_by_name.get(n) or builtins.get(n, '')}
                         for n in port.assistants.agent.commands()],
            'tools': [{'name': t.__name__, 'help': describe(t)} for t in port.assistants.agent.tools],
            'skills': [{'name': s.name, 'help': s.description} for s in port.assistants.agent.skills],
        }
    @rt('/agent/status')
    def agent_status(thread: str = ''):
        "Whether the assistant is loaded, what model it is on, and what it is doing right now."
        try: t = _thread(thread)
        except Exception as e: return _thread_error(e)
        held = t.runner.held()
        return {**t.ai.status(), 'thread': t.id, 'held': held, **({'busy': True} if held else {})}
    @rt('/agent/stop')
    async def agent_stop(req):
        "Cancel the foreground root run of one conversation, and clear a start that never arrived."
        try:
            d = await req.json()
        except Exception: d = {}
        try: t = _thread(d.get('thread'))
        except Exception as e: return _thread_error(e)
        try: return {'ok': True, 'thread': t.id, **t.runner.stop((d.get('run_id') or '').strip(), ai=t.ai)}
        except Exception as e: return {'ok': False, 'error': errstr(e), 'thread': t.id}
    @rt('/agent/runs')
    def agent_runs(thread: str = ''):
        try: t = _thread(thread)
        except Exception as e: return _thread_error(e)
        return {'thread': t.id, 'runs': t.ai.runs(active=True)}
    @rt('/agent/runs/{run_id}/cancel')
    def agent_run_cancel(run_id: str, thread: str = ''):
        try: t = _thread(thread)
        except Exception as e: return _thread_error(e)
        if t.ai.run(run_id) is None: return _run_missing(t, run_id)
        try: return {'ok': True, 'thread': t.id, **t.ai.cancel(run_id)}
        except Exception as e: return {'ok': False, 'error': errstr(e), 'thread': t.id}
    @rt('/agent/runs/{run_id}/terminate')
    def agent_run_terminate(run_id: str, thread: str = ''):
        try: t = _thread(thread)
        except Exception as e: return _thread_error(e)
        if t.ai.run(run_id) is None: return _run_missing(t, run_id)
        try: return {'ok': True, 'thread': t.id, **t.ai.terminate(run_id)}
        except Exception as e: return {'ok': False, 'error': errstr(e), 'thread': t.id}
    @rt('/agent/runs/{run_id}/steer')
    async def agent_run_steer(req, run_id: str):
        "Say one thing to a delegated sub-agent, delivered on its next tool result."
        try: d = await req.json()
        except Exception: return fail('steer body must be JSON')
        try: t = _thread(str(d.get('thread') or ''))
        except Exception as e: return _thread_error(e)
        run = t.ai.run(run_id)
        if run is None: return _run_missing(t, run_id)
        text = str(d.get('text') or '').strip()
        if not text: return fail('nothing to say to it')
        # the agent core carries the steer; an older one has no way to hand it over
        if not hasattr(run, 'steer'):
            return JSONResponse({'ok': False, 'code': 'steer_unsupported', 'thread': t.id, 'run': run_id,
                                 'message': 'this ramabana release cannot carry a steer to a sub-agent'},
                                status_code=501)
        if not run.steer(text):
            return JSONResponse({'ok': False, 'code': 'run_over', 'thread': t.id, 'run': run_id,
                                 'message': f'that sub-agent is {run.state} and will read nothing more'},
                                status_code=409)
        return {'ok': True, 'thread': t.id, **run.dict()}
    @rt('/agent/subagents')
    def agent_subagents(action_id: str = '', thread: str = '', limit: int = 40):
        "One delegation: the call that asked, what its sub-agents did, and the runs still going."
        try: t = _thread(thread)
        except Exception as e: return _thread_error(e)
        rows = t.ai.activity.rows()
        wanted = [r for r in rows if r.get('kind') == 'delegate'
                  and (not action_id or r.get('id') == action_id)]
        # newest first and bounded: recording every sub-agent call makes a session's whole stream
        # far larger than it was, and this is polled while a delegation is running
        wanted = list(reversed(wanted))[:max(1, limit)]
        def flat(runs):
            return [x for r in runs for x in (r, *flat(r.get('children') or []))]
        # `runs(active=True)` keeps a live root's finished children, which are not running now
        live = [r for r in flat(t.ai.runs(active=True))
                if r.get('kind') == 'child' and r.get('state') in ('pending', 'running', 'cancelling')]
        return {'ok': True, 'thread': t.id,
                'delegations': [{**d, 'calls': [r for r in rows if r.get('parent_action_id') == d.get('id')]}
                                for d in wanted],
                'runs': live, 'records_sub_calls': any(r.get('parent_action_id') for r in rows)}
    async def _warm_runtime():
        "Start a kernel for the turn about to run, and let a failure be the tool's to report."
        try: await ex.runtime()
        except Exception: pass

    @rt('/agent/turn')
    async def agent_turn(req):
        try: d = await req.json()
        except Exception: return fail('turn body must be JSON')
        if not isinstance(d, dict): return fail('turn body must be a JSON object')
        if not isinstance(d.get('prompt', ''), str): return fail('prompt must be text')
        q = (d.get('prompt') or '').strip()
        if not q: return fail('nothing to ask')
        attachments = d.get('attachments') or []
        if not isinstance(attachments, list): return fail('attachments must be a JSON array')
        if not all(isinstance(ref, str) for ref in attachments): return fail('attachments must contain text paths')
        if not isinstance(d.get('reasoning', ''), str): return fail('reasoning must be text')
        reasoning = (d.get('reasoning') or '').lower()
        if reasoning not in ('', 'auto', 'low', 'medium', 'high'):
            return fail('reasoning must be auto, low, medium or high')
        reasoning = None if reasoning in ('', 'auto') else reasoning
        nb = _doc()
        context = nb.context(len(nb)) if nb is not None else ''
        context_path = nb.path if nb is not None else ''
        # the browser names the conversation it is looking at; the active one is only a default,
        # and a switch in another tab must not move this turn
        try: runner = _thread(d.get('thread')).runner
        except Exception as e: return _thread_error(e)
        try: grounding = await off_loop(port.history.prepare_turn, attachments, context)
        except Exception as e: return fail(e)
        # Started here, on the loop that owns the kernels, so the first tool call meets a live one.
        if ex.peek() is None: asyncio.ensure_future(_warm_runtime())
        try: return await off_loop(runner.start, q, attachments, reasoning,
                                    context, context_path, grounding)
        except Exception as e:
            from .threads import TurnError
            if isinstance(e, TurnError): return JSONResponse(e.dict(), status_code=409)
            return fail(e, 409)
    @rt('/agent/stream')
    async def agent_stream(req):
        try: since = max(0, int(req.query_params.get('since') or 0))
        except ValueError: return fail('since must be an integer')
        try: th = _thread(req.query_params.get('thread'))
        except Exception as e: return _thread_error(e)
        feed = th.feed
        follow = req.query_params.get('follow') in ('1', 'true', 'yes')
        async def events():
            seq, ended = since, False
            while not feed.closed and (follow or not feed.finished(seq)):
                # the feed wakes this loop directly: a subscriber must not hold a shared worker
                rows = await feed.anext(seq, 1 if ended else 15)
                if await req.is_disconnected(): break
                if not rows:
                    # A finite replay ends at settlement. Neither a producer that never settles nor
                    # a conversation with no turn in flight leaves one waiting for something else.
                    if not follow and (ended or th.state != 'working'): break
                    yield ': keepalive\n\n'
                    continue
                for row in rows:
                    seq = max(seq, row['seq'])
                    ended = ended or row['event'] == 'done'
                    yield sse(row['event'], {'seq': row['seq'], **row['data']})
                if rows[-1]['event'] == 'resync': break
        return StreamingResponse(events(), media_type='text/event-stream',
                                 headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})
    @rt('/agent/approval')
    def agent_approval(thread: str = ''):
        "The call waiting for a person, or None. It stays inline so the rest of the IDE remains usable."
        try: t = _thread(thread)
        except Exception as e: return _thread_error(e)
        # A prompt cell runs on the inline assistant, which the pane cannot otherwise see. Its
        # approval is still a person's to answer, and this is where a person is looking.
        holder, a = t.approvals, t.approvals.pending
        if a is None and (nb_pending := port.assistants.notebook_approvals.pending) is not None:
            holder, a = port.assistants.notebook_approvals, nb_pending
        source = t.ai if holder is t.approvals else port.assistants.inline
        pending = ({**a.dict(), 'schemas': tool_schemas(source)} if a is not None else None)
        return {'thread': t.id, 'pending': pending, 'waiting': port.threads.waiting(),
                'surface': 'notebook' if holder is not t.approvals else 'agent',
                'control': getattr(holder, 'control', 'guided')}
    @rt('/agent/control')
    async def agent_control(req):
        "Choose how often tool proposals become editable checkpoints."
        d = await req.json()
        try: th = _thread(d.get('thread'))
        except Exception as e: return _thread_error(e)
        try: control = th.approvals.set_control((d.get('control') or '').strip())
        except ValueError as e: return fail(e)
        return {'ok': True, 'thread': th.id, 'control': control}
    @rt('/agent/run-policy')
    async def agent_run_policy(req):
        "Run through bounded future calls, or pause immediately after the current one."
        d = await req.json()
        try: th = _thread(d.get('thread'))
        except Exception as e: return _thread_error(e)
        if d.get('policy') == 'pause':
            th.approvals.set_pause_next()
            return {'ok': True, 'thread': th.id, **th.approvals.state()}
        try: policy = th.approvals.set_run_policy(d.get('policy') or 'once', d.get('count') or 1)
        except (ValueError, TypeError) as e: return fail(e)
        return {'ok': True, 'thread': th.id, 'policy': policy, **th.approvals.state()}
    @rt('/agent/steer')
    async def agent_steer(req):
        "Queue guidance after the current tool; the next proposed call is skipped and replaced by it."
        d = await req.json()
        text = (d.get('text') or '').strip()
        try: th = _thread(d.get('thread'))
        except Exception as e: return _thread_error(e)
        # The run this steer belongs to. Without it `Feed.for_run` cannot keep the event, and a
        # steer is missing from the turn the moment the pane is rebuilt from the server.
        here = getattr(th.ai.run(), 'id', '') or ''
        if d.get('cancel'):
            th.approvals.queue_steer('')
            state = th.approvals.state()
            th.feed.emit('steer', {'text': '', 'cancelled': True, **state, 'run': here})
            return {'ok': True, 'thread': th.id, **state}
        if not text: return fail('steering instruction is empty')
        if d.get('force'):
            from .threads import TERMINAL_CANCEL
            busy = bool(th.ai.runs(active=True))
            try: run = th.ai.cancel()
            except Exception as e: return fail(errstr(e))
            # nothing was running: the draft is an ordinary turn, not a cancellation that failed
            if busy and run.get('state') not in TERMINAL_CANCEL:
                return JSONResponse({'ok': False, 'code': 'cancellation_incomplete',
                                     'message': f"run is {run.get('state', 'cancelling')}",
                                     'thread': th.id, 'run': run}, status_code=409)
            state = th.approvals.state()
            th.feed.emit('steer', {'text': text, 'forced': True, 'cancelled': run, **state, 'run': here})
            return {'ok': True, 'thread': th.id, 'forced': True, 'run': run, 'text': text, **state}
        th.approvals.queue_steer(text)
        state = th.approvals.state(); th.feed.emit('steer', {'text': text, **state, 'run': here})
        return {'ok': True, 'thread': th.id, **state}
    @rt('/agent/tool-preview')
    async def agent_tool_preview(req):
        "Preview the resolved call without executing it."
        d = await req.json()
        tool, args = (d.get('tool') or '').strip(), d.get('args')
        try: ai = _thread(d.get('thread')).ai
        except Exception as e: return _thread_error(e)
        if tool not in {t.__name__ for t in ai.tools}: return fail(f'unknown tool {tool}')
        if not isinstance(args, dict): return fail('tool arguments must be an object')
        try: return {'ok': True, 'preview': tool_preview(ai, tool, args)}
        except Exception as e: return fail(e)
    @rt('/agent/branches')
    def agent_branches(thread: str = ''):
        "Where a conversation can be branched, and every branch it already has."
        try: t = _thread(thread)
        except Exception as e: return _thread_error(e)
        a = t.ai
        return {'thread': t.id, 'active': a.current_branch_id, 'branches': a.branches(),
                'turns': [{'turn_id': tid, 'branch_id': cp.get('branch_id', 'main'),
                           'before': 'before' in cp, 'after': 'after' in cp}
                          for tid, cp in a.checkpoints.items()]}
    @rt('/agent/branch/parts')
    def agent_branch_parts(turn_id: str = '', stage: str = 'after', thread: str = ''):
        "One conversation as the ordered parts a person can branch from or shape."
        try: t = _thread(thread)
        except Exception as e: return _thread_error(e)
        try: return {'ok': True, 'thread': t.id, 'turn_id': turn_id, 'stage': stage,
                     'parts': t.ai.context_parts(turn_id, stage)}
        except Exception as e: return _branch_error(e, t)
    @rt('/agent/fork')
    async def agent_fork(req):
        "Restore a checkpoint, or a part inside one, as a new active conversation branch."
        d = await req.json()
        try: t = _settled_thread(d.get('thread'))
        except Exception as e: return _branch_error(e)
        try: branch = t.ai.fork(d.get('turn_id') or '', d.get('stage') or 'after',
                                d.get('branch_id') or '', str(d.get('part_id') or ''),
                                d.get('manifest') or None)
        except Exception as e: return _branch_error(e, t)
        return _branch_reply(t, branch)
    @rt('/agent/branch/switch')
    async def agent_branch_switch(req):
        "Make another branch active by rebuilding its context, not by copying a conversation."
        d = await req.json()
        try: t = _settled_thread(d.get('thread'))
        except Exception as e: return _branch_error(e)
        try: branch = t.ai.switch_branch(str(d.get('branch_id') or ''))
        except Exception as e: return _branch_error(e, t)
        return _branch_reply(t, branch)
    @rt('/agent/undo-turn')
    async def agent_undo_turn(req):
        "Undo a turn from the conversation: a branch that stops before it."
        d = await req.json()
        try: t = _settled_thread(d.get('thread'))
        except Exception as e: return _branch_error(e)
        turns = [str(x) for x in (d.get('turn_ids') or []) if str(x)] or [str(d.get('turn_id') or '')]
        order = list(t.ai.checkpoints)
        unknown = [tid for tid in turns if tid not in order]
        if unknown:
            return JSONResponse({'ok': False, 'code': 'branch_point_invalid', 'thread': t.id,
                                 'message': f'no captured turn boundary for {unknown[0]}'}, status_code=409)
        earliest = min(turns, key=order.index) if turns else ''
        try: branch = t.ai.undo_turn(earliest, d.get('branch_id') or '')
        except Exception as e: return _branch_error(e, t)
        return _branch_reply(t, branch, undone=turns, files_restored=None)
    @rt('/agent/conversation/parts')
    def agent_conversation_parts(thread: str = '', session: str = ''):
        "One stored conversation as the ordered parts a person can keep, drop or rewrite."
        try: th = _thread(thread)
        except Exception as e: return _thread_error(e)
        try: parts = th.ai.conversation_parts(session or None)
        except Exception as e: return _branch_error(e, th)
        return {'ok': True, 'thread': th.id, 'session': session or th.id, 'parts': parts,
                'branch_id': th.ai.current_branch_id,
                'revision': th.ai.branch_meta(th.ai.current_branch_id)['revision']}
    @rt('/agent/conversation/notebook')
    async def agent_conversation_notebook(req):
        "Write one conversation out as a notebook a person can edit like any other."
        d = await req.json() if req.method == 'POST' else {}
        try: th = _thread(d.get('thread'))
        except Exception as e: return _thread_error(e)
        session = str(d.get('session') or th.id)
        try: parts = th.ai.conversation_parts(session)
        except Exception as e: return _branch_error(e, th)
        if not parts: return fail('this conversation has no recorded turns to edit', 404)
        from ..nb.nb import Cell, Notebook
        held = th.ai.branch_meta(th.ai.current_branch_id)
        head = (f'# Reshape this conversation\n\n'
                f'Conversation `{session}` as {len(parts)} parts. Edit the **you** and **agent** '
                f'cells to change what the model remembers. Delete any cell to drop that part; a '
                f'call and its result go together. Save, then apply from the agent pane.\n\n'
                f'_Nothing here changes the recorded conversation._')
        cells = [Cell(source=head, cell_type='markdown')]
        for part in parts:
            label = {'user': 'you', 'assistant': 'agent', 'call': 'call', 'result': 'result'}[part['kind']]
            body = f'<!-- {label} · {part["part_id"]} -->\n{part["text"]}'
            cell = Cell(source=body, cell_type='markdown')
            cell.approval = {'kind': 'reshape', 'part_id': part['part_id'], 'part_kind': part['kind'],
                             'editable': part['editable'], 'group': part['group']}
            cells.append(cell)
        nb = Notebook(cells)
        name = f'reshape-{session.replace(":", "-")}.ipynb'
        path = str(Path(ex.cwd_for())/name)
        try: nb.save(path)
        except Exception as e: return fail(e)
        return {'ok': True, 'thread': th.id, 'session': session, 'path': path,
                'parts': len(parts), 'branch_id': held['branch_id'], 'revision': held['revision']}
    @rt('/agent/conversation/reshape')
    async def agent_conversation_reshape(req):
        "Read an edited notebook back as one reshaped branch."
        d = await req.json()
        try: th = _settled_thread(d.get('thread'))
        except Exception as e: return _branch_error(e)
        session, path = str(d.get('session') or th.id), str(d.get('path') or '')
        if not path: return fail('name the notebook to read the edits from')
        from ..nb.nb import Notebook
        try: nb = docs.docs.get(path) or Notebook.load(path)
        except Exception as e: return fail(e)
        try: parts = th.ai.conversation_parts(session)
        except Exception as e: return _branch_error(e, th)
        seen = {}
        for cell in nb:
            # the notebook format renames `kind` on save, so the part id is what identifies a cell
            meta = getattr(cell, 'approval', None) or {}
            part_id = str(meta.get('part_id') or '')
            if not part_id: continue
            body = str(cell.source or '')
            seen[part_id] = body.split('\n', 1)[1] if body.startswith('<!--') and '\n' in body else body
        # a notebook with no part cells is one we failed to read, not a conversation to erase
        if not seen:
            return JSONResponse({'ok': False, 'code': 'branch_point_invalid', 'thread': th.id,
                                 'message': 'no conversation parts found in that notebook; nothing was changed'},
                                status_code=409)
        manifest = {p['part_id']: 'discard' for p in parts if p['part_id'] not in seen}
        rewrites = {p['part_id']: seen[p['part_id']] for p in parts
                    if p['editable'] and p['part_id'] in seen and seen[p['part_id']] != p['text']}
        held = th.ai.branch_meta(str(d.get('branch_id') or th.ai.current_branch_id))
        if d.get('revision') is not None and int(d['revision']) != int(held['revision']):
            return _history_changed(th, held)
        try: branch = th.ai.reshape(session, manifest, rewrites)
        except Exception as e: return _branch_error(e, th)
        return _branch_reply(th, branch, discarded=sorted(manifest), rewritten=sorted(rewrites))
    @rt('/agent/history/preview')
    async def agent_history_preview(req):
        "What reshaping this conversation would send, before anything is written."
        d = await req.json()
        try: th = _thread(d.get('thread'))
        except Exception as e: return _thread_error(e)
        base = str(d.get('branch_id') or th.ai.current_branch_id)
        held = th.ai.branch_meta(base)
        if d.get('revision') is not None and int(d['revision']) != int(held['revision']):
            return _history_changed(th, held)
        try: compiled = th.ai.compile_conversation(d.get('session') or None,
                                                  d.get('manifest') or None, d.get('rewrites') or None)
        except Exception as e: return _branch_error(e, th)
        text = '\n'.join(str(m.get('content') or '') for m in compiled['messages'])
        return {'ok': True, 'thread': th.id, 'branch_id': base, 'revision': held['revision'],
                'next_revision': held['revision'] + 1, 'parts': compiled['parts'],
                'groups': compiled['groups'], 'adjusted': compiled['adjusted'],
                'rewritten': compiled['rewritten'], 'kept': compiled['kept'],
                'omitted': compiled['omitted'], 'messages': len(compiled['messages']),
                'tokens': max(1, len(text) // 4) if text else 0}
    @rt('/agent/history/apply')
    async def agent_history_apply(req):
        "Commit a reshaped conversation as a new branch, revalidated at the revision it was shown."
        d = await req.json()
        try: th = _settled_thread(d.get('thread'))
        except Exception as e: return _branch_error(e)
        base = str(d.get('branch_id') or th.ai.current_branch_id)
        if d.get('revision') is None: return fail('a reshaped branch needs the revision it was previewed at')
        held = th.ai.branch_meta(base)
        if int(d['revision']) != int(held['revision']): return _history_changed(th, held)
        try: branch = th.ai.reshape(d.get('session') or None, d.get('manifest') or None,
                                   d.get('rewrites') or None, d.get('branch_id_new') or '')
        except Exception as e: return _branch_error(e, th)
        return _branch_reply(th, branch, base_branch_id=base)
    @rt('/agent/revise')
    async def agent_revise(req):
        "Create a branch whose last assistant prose is the user's edited response."
        d = await req.json(); text = (d.get('text') or '').strip()
        if not text: return fail('revised response is empty')
        try: t = _settled_thread(d.get('thread'))
        except Exception as e: return _branch_error(e)
        try: branch = t.ai.revise(d.get('turn_id') or '', text, d.get('branch_id') or '')
        except Exception as e: return _branch_error(e, t)
        return _branch_reply(t, branch)
    @rt('/agent/retry-tool')
    async def agent_retry_tool(req):
        "Rerun a completed read-only call; return its result without changing model history."
        from .ai import WRITE_TOOLS
        d = await req.json()
        tool, args = (d.get('tool') or '').strip(), d.get('args')
        if tool in WRITE_TOOLS: return fail('only read-only calls can be retried from a checkpoint')
        try: choices = {c.__name__: c for c in _thread(d.get('thread')).ai.tools}
        except Exception as e: return _thread_error(e)
        if tool not in choices: return fail(f'unknown tool {tool}')
        if not isinstance(args, dict): return fail('tool arguments must be an object')
        try: result = await off_loop(choices[tool], **args)
        except Exception as e: return fail(e)
        return {'ok': True, 'tool': tool, 'args': args, 'result': str(result)}
    @rt('/agent/turn-transaction')
    def agent_turn_transaction(turn_id: str = '', thread: str = ''):
        try: t = _thread(thread)
        except Exception as e: return _thread_error(e)
        tx = t.ai.turn_transactions.get(turn_id)
        if tx is None: return fail(f'no transaction for {turn_id}', 404)
        return {'transaction': {**tx, 'files': [{'path': p, **diff_payload(s['before'], s['after'])}
                                                for p, s in tx['files'].items()]}}
    @rt('/agent/rollback-turn')
    async def agent_rollback_turn(req):
        d = await req.json()
        try: t = _thread(d.get('thread'))
        except Exception as e: return _thread_error(e)
        try: tx = t.ai.rollback_turn(d.get('turn_id') or '')
        except Exception as e: return fail(e)
        return {'ok': True, 'thread': t.id, 'turn_id': tx['turn_id'], 'paths': list(tx['files']),
                'irreversible': tx['irreversible']}
    @rt('/agent/rollback-tool')
    async def agent_rollback_tool(req):
        "Rollback one snapshotted file call when its output is still the current file."
        d = await req.json()
        try: t = _thread(d.get('thread'))
        except Exception as e: return _thread_error(e)
        try: path = t.approvals.rollback((d.get('id') or '').strip())
        except Exception as e: return fail(e)
        return {'ok': True, 'thread': t.id, 'path': path}
    @rt('/agent/approval/request')
    async def agent_approval_request(req):
        "Ask for a decision in this browser on behalf of an external Rishi session."
        try: d = await req.json()
        except Exception as e: return fail(f'approval request must be valid JSON: {e}')
        tc = d.get('tool_call') or {}
        fn = tc.get('function') or {} if isinstance(tc, dict) else {}
        name, args = fn.get('name'), fn.get('arguments', {})
        if args in (None, ''): args = {}
        if not name: return fail('tool_call.function.name is required')
        if isinstance(args, str):
            try: args = json.loads(args)
            except json.JSONDecodeError as e: return fail(f'tool_call.function.arguments is not valid JSON at position {e.pos}')
        if not isinstance(args, dict): return fail('tool_call.function.arguments must be an object')
        try: t = _thread(d.get('thread'))
        except Exception as e: return _thread_error(e)
        try: timeout = min(3600, max(1, float(d.get('timeout', t.approvals.timeout))))
        except (TypeError, ValueError): return fail('timeout must be a number of seconds')
        a = await off_loop(t.approvals.request, name, args, True, timeout)
        return {'ok': True, 'thread': t.id, 'answer': a.dict()}
    @rt('/agent/approve')
    async def agent_approve(req):
        "Answer a pending approval. `note` is the reason, and the reason goes back to the model."
        d = await req.json()
        args = d.get('args')
        if args is not None and not isinstance(args, dict): return fail('tool arguments must be an object')
        tool = (d.get('tool') or '').strip() or None
        try: t = _thread(d.get('thread'))
        except Exception as e: return _thread_error(e)
        # answered wherever it was raised: a prompt cell's approval is held by the notebook's
        holder = (port.assistants.notebook_approvals
                  if t.approvals.pending is None and port.assistants.notebook_approvals.pending is not None
                  else t.approvals)
        choices = {c.__name__: c for c in (t.ai if holder is t.approvals else port.assistants.inline).tools}
        if tool and tool not in choices: return fail(f'unknown tool {tool}')
        if bool(d.get('ok')) and tool and args is not None:
            import inspect
            try: inspect.signature(choices[tool]).bind(**args)
            except TypeError as e: return fail(f'invalid {tool} arguments: {e}')
        a = holder.answer(d.get('id') or '', bool(d.get('ok')), (d.get('note') or '').strip(),
                          session=bool(d.get('session')), tool=tool, args=args)
        if a is None: return fail('nothing is waiting for an answer')
        return {'ok': True, 'thread': t.id, 'answer': a.dict()}
    @rt('/agent/command')
    async def agent_command(req):
        "Run a slash command (`/model`, `/cost`, `/compact`, `/skills`, `/tools`, `/reload`)."
        d = await req.json()
        line = (d.get('line') or '').strip()
        try: ai = _thread(d.get('thread')).ai
        except Exception as e: return _thread_error(e)
        if not line: return {'ok': True, 'text': 'commands: ' + ', '.join('/' + c for c in ai.commands())}
        out = await off_loop(ai.command, line)
        if out is None: return fail(f'unknown command {line.split()[0]}')
        if line.lstrip('/').split(' ')[0] in ('tool-budget', 'steps'):
            port.settings.tool_budget, port.settings.step_budget = ai.tool_budget, ai.step_budget
            for agent in live_assistants(): agent.tool_budget, agent.step_budget = port.settings.tool_budget, port.settings.step_budget
            port.history.save()
        return {'ok': True, 'text': out}
    @rt('/agent/ask')
    async def agent_ask(req):
        "One turn with the assistant."
        d = await req.json()
        q = (d.get('prompt') or '').strip()
        if not q: return fail('nothing to ask')
        a = port.assistants.agent
        text = await off_loop(port.history.ask, q)
        return {'ok': a.ready, 'text': text, 'note': a.note,
                'activity': a.activity.rows(mark=a.activity._mark),
                'usage': a.turn_use.dict(), 'usage_label': repr(a.turn_use),
                'session_usage': a.use.dict(), 'session_usage_label': repr(a.use), 'model': a.model.name,
                'edits': edit_diffs(a)}
