"""The agent pane, as a block.

`connect(app, port)` registers the routes, `panel(port)` is the markup, and `headers()` is what the
page needs in its head. The three are what a host calls; nothing else here is public.

The client is an ES module graph, so it is served file by file rather than concatenated: `publish`
copies it under `static/` where the browser can import it, and the entry point is one module tag.
"""

import shutil
from pathlib import Path
from fasthtml.common import Link, Script
from valmiki.core import vlink
from .cfg import Routes
from .ui import agent_panel as panel

__all__ = ['connect', 'panel', 'headers', 'Routes']

HERE = Path(__file__).parent
#: the bridge first, then the atoms the pane borrows, then the pane's own rules
SHEETS = ('tokens.oat.css', 'atoms.css', 'agent.css')
MODULES = ('kit.js', 'host.js', 'panel.js', 'budgets.js', 'memory.js', 'live.js', 'approvals.js',
           'steer.js', 'media.js', 'boot.js')

def publish(static=Path('static')):
    "Copy the client where the browser can reach it, keeping `../js/kit.js` resolvable."
    out = static/'agent'; out.mkdir(parents=True, exist_ok=True)
    (static/'js').mkdir(parents=True, exist_ok=True)
    for n in MODULES:
        dst = (static/'js'/n) if n == 'kit.js' else out/n
        if not dst.is_file() or dst.read_text() != (HERE/n).read_text(): shutil.copy2(HERE/n, dst)
    for n in SHEETS:
        dst = out/n
        if not dst.is_file() or dst.read_text() != (HERE/n).read_text(): shutil.copy2(HERE/n, dst)
    return out

def headers():
    "The pane's stylesheets and its one module tag, in the order they have to load."
    return [*[Link(rel='stylesheet', href=vlink(f'/static/agent/{n}')) for n in SHEETS],
            Script(src=vlink('/static/agent/boot.js'), type='module')]

def connect(app, port):
    "Register the pane's routes against `port`, and publish its client."
    from .app import connect as _routes
    publish()
    _routes(app, port)
