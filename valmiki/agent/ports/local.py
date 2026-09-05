"""Ramabana behind the port: one agent, one folder, no kernels.

Leela's port is a `Workspace`, which owns notebooks, tabs and a kernel pool. This one owns an
`Agent` and a directory, so `execution` is absent and the pane draws no kernel controls. The
settings live in a JSON file rather than in a workspace, and the charter layers live beside it.
"""

import json, time
from pathlib import Path
from fastcore.all import AttrDict
from ramabana.agent import Agent, Approvals
from ramabana.tools import LocalHost, WRITE_TOOLS
from ..port import AgentPort, Assistants, History, Settings, State
from ..threads import Threads

__all__ = ['LocalPort', 'local_port']

DFLT = dict(model=None, inline_model=None, completion_model=None, job_models={}, tool_budget='auto',
            step_budget='auto', compact_auto=True, compact_strategy='surgical',
            agent_read_outside=False, allow_workspace_repo_writes=False, subagent_writes=False,
            vault_pii='off', local_multimodal=False, litert_backend='', agent_memory_selection='')

class _Store:
    "The fifteen settings and the charter, in one JSON file `Settings` and `State` read through."
    def __init__(self, path):
        self.path = Path(path)
        self.d = AttrDict(DFLT | (json.loads(self.path.read_text()) if self.path.is_file() else {}))
        self.d.setdefault('agent_state', ''); self.d.setdefault('agent_state_layers', {})
    def __getattr__(self, k):
        if k.startswith('_') or k in ('path', 'd'): raise AttributeError(k)
        return self.d.get(k)
    def __setattr__(self, k, v):
        if k in ('path', 'd'): return object.__setattr__(self, k, v)
        self.d[k] = v
    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(dict(self.d), indent=1, default=str))

class _Sessions:
    "Turn history, kept where the agent keeps its own rather than in a workspace file."
    def __init__(self, agent, root):
        self.agent, self.root, self.stamped = agent, Path(root), 0
    def stamp(self, *a, **kw): self.stamped = time.time(); return self.stamped
    def fresh(self, *a, **kw): return []
    def with_timelines(self, rows, *a, **kw): return rows
    def ask(self, *a, **kw): return self.agent.ask(*a, **kw)
    def prepare_turn(self, *a, **kw): return None
    def save(self): return None

class LocalPort(AgentPort):
    "The pane over one Ramabana agent."
    def __init__(self, agent, host, cfg_dir):
        cfg_dir = Path(cfg_dir); cfg_dir.mkdir(parents=True, exist_ok=True)
        self.agent, self.host, self.cfg_dir = agent, host, cfg_dir
        self._store = _Store(cfg_dir/'agent-ui.json')
        self.settings, self.state = Settings(self._store), State(self._store)
        self.assistants = Assistants(_Live(agent))
        self.history = History(_Sessions(agent, cfg_dir))
        self.execution = None                    # no kernels here; the pane omits their controls
        self.memory = getattr(host, 'memory', None)      # a vault only where the host was given one
        self.files = _Files(host)
        self.docs = None                         # nothing opens documents here
        self._threads = None
    @property
    def approvals(self): return self.agent.approvals
    @property
    def threads(self):
        if self._threads is None: self._threads = Threads(self)
        return self._threads
    @property
    def built_threads(self): return self._threads

class _Files:
    "The host's roots, and the path check the attachment and state routes make."
    def __init__(self, host): self.host = host
    @property
    def roots(self): return tuple(Path(r) for r in (getattr(self.host, 'roots', None) or ('.',)))
    def _check(self, path, must_exist=False, **kw):
        p = Path(path).expanduser().resolve()
        if must_exist and not p.exists(): raise FileNotFoundError(str(p))
        return p
    def walk(self, limit=200):
        out = []
        for r in self.roots:
            for q in sorted(Path(r).rglob('*')):
                if any(part.startswith('.') for part in q.parts): continue
                out.append(q)
                if len(out) >= limit: return out
        return out

class _Live:
    "What `Assistants` reads: one agent, and no second one for inline completion."
    def __init__(self, agent): self.ai = self.inline_ai = self._ai = agent; self._inline_ai = None
    _notebook_approvals = None

def local_port(roots=('.',), model=None, approve='ask', cfg_dir=None, **kw):
    "An agent over `roots`, gated the way `approve` says, behind the pane's port."
    approvals = None if approve == 'none' else Approvals(tools=WRITE_TOOLS, mode=approve)
    host = LocalHost(roots, approvals=approvals, **kw)
    if approvals is not None: approvals.host = host
    agent = Agent(host, model=model, approvals=approvals)
    return LocalPort(agent, host, cfg_dir or Path.home()/'.valmiki')
