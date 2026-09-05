"The agent pane's markup. Everything the pane draws before its client takes over."

from fasthtml.common import (Button, Datalist, Details, Div, Input, Label, Option, Section, Select,
                             Span, Strong, Summary, Textarea)
from fastcore.basics import first
from .cfg import JOB_HELP, PII_GATES, STEP_RANGE, TOOL_RANGE, chord_display

__all__ = ['agent_panel', 'help_mark', 'state_text', 'state_label', 'state_title']

def help_mark(job):
    "The `?` beside a model control, saying what that job spends its model on."
    return Span('?', cls='lee-hint', tabindex='0', role='note',
                title=JOB_HELP.get(job, ''), aria_label=JOB_HELP.get(job, ''))

def state_text(port):
    "Every layer's text, in the order they are applied. `agent_state` is only the resolved one."
    layers = [str(d.get('text') or '') for d in (port.state.layers or {}).values() if d.get('enabled', True)]
    return '\n'.join([port.state.text or '', *layers])

def state_label(port):
    "What the agent pane calls the state it is carrying."
    text = state_text(port)
    if not text.strip(): return 'no state'
    head = first(l.lstrip('# ').strip() for l in text.splitlines()
                 if l.startswith('#') and l.lstrip('# ').strip())
    return (head or 'state active')[:40]

def state_title(port):
    "The badge's tooltip: which layers carry the state, and where each came from."
    if not state_text(port).strip(): return 'no starting state; click to write one'
    rows = [f"{name}: {d.get('source') or 'workspace'}" for name, d in (port.state.layers or {}).items()
            if d.get('text') and d.get('enabled', True)]
    return ' · '.join(rows) or 'active starting state'

def agent_panel(port):
    "Bottom centre; model choices load asynchronously after the editor can paint."
    from ramabana.core import DFLT_LOCAL, env as _env
    agent_model = port.settings.model or _env('MODEL') or DFLT_LOCAL
    inline_model = port.settings.inline_model or _env('MODEL_INLINE') or 'gpt-mini'
    completion_model = port.settings.completion_model or _env('MODEL_COMPLETION') or 'gpt-4.1'
    has_state = any(str(layer.get('text') or '').strip() for layer in port.state.layers.values())
    control = getattr(port.approvals, 'control', 'guided')
    welcome = None if has_state else Div(
        Strong('Set up this workspace agent'),
        Span('Create a reviewed charter from this codebase. It is remembered, and can be refreshed as the project changes.'),
        Button('Set up agent state', cls='lee-btn go', type='button', onclick='leeAgentState()'),
        cls='lee-agent-welcome')
    return Section(
        Div(Div(Span('agent', cls='lee-ptitle'),
                Span(Span(cls='lee-agent-status-dot'), 'ready', id='agentstatus', cls='lee-agent-status ready', title='agent ready'),
                Span(state_label(port), id='agentnames', cls='lee-agent-state-badge',
                     title=state_title(port), onclick='leeAgentState()'),
                cls='lee-agent-heading'),
            Span(cls='lee-spacer'),
            Div(Button(Span('conversations', cls='lee-thread-toggle-label'),
                       Span('1', id='agentthreadcount', cls='lee-thread-count'),
                       id='agentthreads', cls='lee-btn lee-thread-toggle', aria_expanded='false',
                       aria_controls='agentthreadlist', title='every live conversation',
                       onclick='leeAgentThreadsToggle()'),
                Button('+', id='agentnew', cls='lee-btn', title='new conversation', aria_label='new conversation',
                       onclick='leeAgentNew()'),
                Button('history', id='agenthistory', cls='lee-btn', title='toggle conversation history',
                       onclick='leeAgentHistory()'),
                Button('memory', id='agentmemory', cls='lee-btn', title='choose notes for agent, prompt cells, and completion',
                       onclick='leeMemoryNotes()'),
                Button('state', id='agentstate', cls='lee-btn', title='review or refresh the active agent state',
                       onclick='leeAgentState()'),
                Button('expand', id='agentexpand', cls='lee-btn', data_pane_expand='right',
                       title='expand the right pane', aria_pressed='false',
                       onclick='leeAgentExpand()'), cls='lee-agent-head-actions'),
            cls='lee-phead lee-agent-head'),
        Div(welcome, id='agentlog', cls='lee-agentlog'),
        Div(Span(cls='lee-agent-run-state'),
            Button('Pause after current', cls='lee-btn', type='button', data_agent_pause='1'),
            Button('Stop', cls='lee-btn warn', type='button', data_agent_stop='1'),
            cls='lee-agent-runstrip', id='agentrunstrip', hidden=True, aria_live='polite'),
        Div(Strong('Cursor agent mode.'),
            ' Cursor runs a tool only in agent mode, and its own shell and file edits come with that. '
            'They act in this workspace without passing through Leela\u2019s approvals, held only by '
            'Cursor\u2019s sandbox. Another runtime if you want every write gated.',
            id='agentharnessbanner', cls='lee-agent-harness-banner', hidden=True, role='status'),
        Div(id='agentthreadlist', cls='lee-thread-list', role='listbox',
            aria_label='live conversations', hidden=True),
        Div(id='agentattention', cls='lee-agent-attention', role='status', aria_live='polite', hidden=True),
        Div(Div(id='agentattachments', cls='lee-agent-attachments', aria_live='polite'),
            Div(Button('attach image', id='agentattach', cls='lee-btn', type='button', title='attach a workspace image path or paste a screenshot', onclick='leeAgentAttach()'), cls='lee-agent-attachbar'),
            Textarea(id='agentprompt', cls='lee-input lee-prompt', rows='2',
                     placeholder=' '.join(('ask, / for commands, @ for files…', chord_display('agent_send'))).strip(),
                     autocomplete='off', aria_autocomplete='list', aria_controls='agentsuggest'),
            Div(id='agentsuggest', cls='lee-agent-suggest', role='listbox', hidden=True),
            Div(Div(Select(Option('loading…', value=agent_model), id='agentmodel',
                           cls='lee-select lee-composer-model', onchange='leeAgentModel("agent", this.value)',
                           aria_label='conversation model', title=JOB_HELP['turn']),
                    Select(Option('autopilot', value='autopilot', selected=control == 'autopilot'),
                           Option('guided', value='guided', selected=control == 'guided'),
                           Option('directed', value='directed', selected=control == 'directed'),
                           id='agentcontrol', cls='lee-select lee-composer-control',
                           onchange='leeAgentControl(this.value)', aria_label='agent mode',
                           title='autopilot: writes pause · guided: writes and network pause · directed: every tool pauses'),
                    Select(Option('automatic reasoning', value='auto'), Option('low reasoning', value='low'),
                           Option('medium reasoning', value='medium'), Option('high reasoning', value='high'),
                           id='agentreasoning', cls='lee-select lee-composer-reasoning',
                           title='reasoning effort for cloud models'),
                    Select(*[Option(v, value=v, selected=str(port.settings.tool_budget) == v)
                             for v in ('auto', '80', '160', '240', '400')],
                           id='agenttoolbudget', cls='lee-select lee-composer-budget',
                           onchange='leeAgentQuickBudget()', aria_label='tool calls per turn',
                           title='tool calls allowed per turn'),
                    Span(id='agentbudgetstatus', cls='lee-agent-budget-status',
                         title='tool calls used in this turn'), cls='lee-composer-primary'),
                Details(Summary('settings'),
                    Div(Label(Span('prompt cells · inline AI', help_mark('inline'), cls='lee-routing-name'),
                              Select(Option('loading…', value=inline_model), id='inlinemodel',
                              cls='lee-select', onchange='leeAgentModel("inline", this.value)')),
                        Label(Span('completion', help_mark('completion'), cls='lee-routing-name'),
                              Select(Option('loading…', value=completion_model), id='completionmodel',
                              cls='lee-select', onchange='leeAgentModel("completion", this.value)')),
                        Div(id='jobmodels'),   # the harness's other jobs, drawn from /agent/models
                        Label(Input(type='checkbox', id='autocompact', checked=port.settings.compact_auto,
                                    onchange='leeAgentCompaction()'), ' compact automatically',
                              cls='lee-check-setting', title='rewrite old context before it reaches the model limit'),
                        Label('compaction', Select(Option('surgical · readable tool trail', value='surgical', selected=port.settings.compact_strategy == 'surgical'),
                                                   Option('summary · model checkpoint', value='summary', selected=port.settings.compact_strategy == 'summary'),
                                                   id='compactstrategy', cls='lee-select', onchange='leeAgentCompaction()')),
                        Label('tool calls per turn',
                              Input(id='toolbudget', cls='lee-input', value=str(port.settings.tool_budget),
                                    list='toolbudgets', autocomplete='off', spellcheck='false',
                                    title=f'auto, or {TOOL_RANGE[0]}–{TOOL_RANGE[1]}',
                                    onchange='leeAgentBudget()')),
                        Datalist(*[Option(value=v) for v in ('auto', '80', '160', '240', '400')], id='toolbudgets'),
                        Label('steps per turn',
                              Input(id='stepbudget', cls='lee-input', value=str(port.settings.step_budget),
                                    list='stepbudgets', autocomplete='off', spellcheck='false',
                                    title=f'auto, or {STEP_RANGE[0]}–{STEP_RANGE[1]}',
                                    onchange='leeAgentBudget()')),
                        Datalist(*[Option(value=v) for v in ('auto', '20', '40', '60', '80')], id='stepbudgets'),
                        Label(Input(type='checkbox', id='localmultimodal', checked=port.settings.local_multimodal,
                                    onchange='leeLocalMultimodal(this.checked)'),
                              ' local image/audio encoders', cls='lee-check-setting',
                              title='Reload local LiteRT engines with vision and audio support'),
                        Label(Input(type='checkbox', id='kernels-auto-manage', checked=getattr(port, 'kernels_auto_manage', False),
                                    onchange='setKernelAutoManage(this.checked)'),
                              ' leela manages the runtime limit', cls='lee-check-setting',
                              title='At the kernel limit, close the longest-idle runtime instead of asking'),
                        Label(Input(type='checkbox', id='workspace-repo-writes', checked=port.settings.allow_workspace_repo_writes,
                                    onchange='leeWorkspaceRepoWrites(this.checked)'), ' allow writes to other workspace repos',
                              cls='lee-check-setting', title='Keep approval prompts, but allow approved writes to any repository added to this workspace'),
                        Label(Input(type='checkbox', id='subagent-writes', checked=port.settings.subagent_writes,
                                    onchange='leeSubagentWrites(this.checked)'), ' sub-agents may write',
                              cls='lee-check-setting',
                              title='Delegated sub-agents get the write tools as well as the read ones. Edits, commands and Python, each recorded and put through the same approval prompts. Off, they can only report what they found'),
                        Label(Input(type='checkbox', id='agent-read-outside', checked=port.settings.agent_read_outside,
                                    onchange='leeAgentReadOutside(this.checked)'), ' read outside the open folders',
                              cls='lee-check-setting',
                              title='Let the agent read a named path anywhere (a sibling checkout, a library in the venv). Writes stay confined; credential files stay refused'),
                        Label(' vault privacy ',
                              Select(*[Option(v, value=v, selected=v == port.settings.vault_pii) for v in PII_GATES],
                                     id='vault-pii', data_was=port.settings.vault_pii,
                                     onchange='leeVaultPii(this.value)'),
                              cls='lee-check-setting',
                              title='What a vault retrieval hands the model. off: as it is. redact: identifiers '
                                    'masked. refuse: the section withheld. A document you marked not personal '
                                    'is never gated; one you marked personal always is'),
                        Label(Input(type='checkbox', id='legacymodels', checked=True,
                                    onchange='leeLoadModels(this.checked)'), ' show older models',
                              cls='lee-check-setting'),
                        Button('+ model',type='button',cls='lee-btn',onclick='leeAddModel()',
                               title='save a Hugging Face repo or hosted API model'),
                        cls='lee-routing-popover'), cls='lee-routing lee-agent-settings lee-dismissable'),
                Button('Send', id='agentsend', cls='lee-btn go lee-composer-send',
                       onclick='sendAgent(event.shiftKey)', aria_label='Send',
                       title='send this as a turn'),
                cls='lee-composer-footer'),
            cls='lee-promptbar lee-agent-composer'),
        cls='lee-panel lee-agent')
