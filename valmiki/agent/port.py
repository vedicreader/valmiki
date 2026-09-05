"""What the pane's routes need of whatever is running the agent.

Leela's routes read thirty-four members off `Workspace`. Six of them are its kernels and its
notebooks; the rest are the agent's own, and a second host has all of them under other names.
`AgentPort` is those thirty-four collected into six.

`execution` is the one that may be absent. A host with no kernel has nothing to run a cell in,
and `NO_EXECUTION` is what keeps the routes that reach for one answering rather than raising.
`ports/local.py` is Ramabana's implementation; Leela keeps its own over `Workspace`.
"""

from __future__ import annotations

__all__ = ['AgentPort', 'NO_EXECUTION', 'NO_MEMORY', 'NO_FILES', 'NO_DOCS', 'SETTINGS',
           'Settings', 'Assistants', 'State', 'History']

#: the fifteen scalars the pane reads and writes. A host stores them wherever it likes.
SETTINGS = ('model', 'inline_model', 'completion_model', 'job_models', 'tool_budget', 'step_budget',
            'compact_auto', 'compact_strategy', 'agent_read_outside', 'allow_workspace_repo_writes',
            'subagent_writes', 'vault_pii', 'local_multimodal', 'litert_backend',
            'agent_memory_selection')

class AgentPort:
    "The six things the pane's routes touch. Anything running the agent can supply them."
    threads: object        #: the `Threads` object: rows, add, drop, switch
    assistants: object     #: the agent, the inline agent, the notebook approvals
    settings: object       #: the fifteen scalars, and `save()`
    state: object          #: the charter and its layers
    history: object        #: stamping, freshening and saving a turn's history
    #: the four a host may not have. Leela has all of them; Ramabana on its own has none. The
    #: routes reach them through the nulls below, so an absent one answers rather than raises.
    execution: object      #: kernels and working directories
    memory: object         #: the vault the pane reads notes and charters out of
    files: object          #: path checks, for an attachment or a state reference
    docs: object           #: the document on screen, which only an editor has

class Settings:
    "Attribute access over one host's storage, refusing any name that is not the pane's."
    __slots__ = ('_ws',)
    def __init__(self, ws): object.__setattr__(self, '_ws', ws)
    def __getattr__(self, k):
        if k not in SETTINGS: raise AttributeError(f'{k} is not an agent setting')
        return getattr(self._ws, k)
    def __setattr__(self, k, v):
        if k not in SETTINGS: raise AttributeError(f'{k} is not an agent setting')
        setattr(self._ws, k, v)
    def save(self): self._ws.save()

class Assistants:
    "The live agents. `built_*` never constructs one: asking is what the probe routes do."
    __slots__ = ('_ws',)
    def __init__(self, ws): self._ws = ws
    @property
    def agent(self): return self._ws.ai
    @property
    def inline(self): return self._ws.inline_ai
    @property
    def built_agent(self): return self._ws._ai
    @property
    def built_inline(self): return self._ws._inline_ai
    @property
    def notebook_approvals(self): return self._ws._notebook_approvals

class State:
    "The charter the agent is briefed with, and the layers it is assembled from."
    __slots__ = ('_ws',)
    def __init__(self, ws): self._ws = ws
    @property
    def text(self): return self._ws.agent_state
    @property
    def layers(self): return self._ws.agent_state_layers

class History:
    __slots__ = ('_ws',)
    def __init__(self, ws): self._ws = ws
    def stamp(self, *a, **kw): return self._ws.history_stamp(*a, **kw)
    def fresh(self, *a, **kw): return self._ws.fresh_history(*a, **kw)
    def with_timelines(self, *a, **kw): return self._ws.with_timelines(*a, **kw)
    def ask(self, *a, **kw): return self._ws.ask(*a, **kw)
    def prepare_turn(self, *a, **kw): return self._ws.prepare_turn(*a, **kw)
    def save(self): return self._ws.save()

class _NoMemory:
    "No vault: every listing is empty and nothing is remembered."
    def agent_notes(self, *a, **kw): return []
    def agent_states(self, *a, **kw): return []
    def exact_text(self, *a, **kw): return ''
    def agent_state_text(self, *a, **kw): return ''
    def remember_agent_note(self, *a, **kw): return None
    def remember_agent_state(self, *a, **kw): return None
    def forget_agent_note(self, *a, **kw): return None
    note = 'this host keeps no vault'
    def __getattr__(self, k): return lambda *a, **kw: None

class _NoFiles:
    "No workspace roots to check a path against, so a path is taken as given."
    def _check(self, path, must_exist=False, **kw):
        from pathlib import Path as _P
        p = _P(path).expanduser()
        if must_exist and not p.exists(): raise FileNotFoundError(str(p))
        return p
    @property
    def roots(self): return ()

class _NoDocs:
    "Nothing is open, because nothing here opens documents."
    def current(self, *a, **kw): return None

class _NoExecution:
    """A host with no kernels. Nothing runs, nothing is running, and the working directory is
    wherever the process already is. The routes then answer instead of raising, which is the whole
    point: Leela never reaches this and Ramabana reaches nothing else."""
    async def runtime(self, *a, **kw): return None
    def peek(self, *a, **kw): return None
    def kernel_peek(self, *a, **kw): return None
    def cwd_for(self, *a, **kw):
        from pathlib import Path
        return Path.cwd()

NO_EXECUTION, NO_MEMORY, NO_FILES, NO_DOCS = _NoExecution(), _NoMemory(), _NoFiles(), _NoDocs()
