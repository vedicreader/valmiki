"""What the pane's routes need of the application serving them.

Leela supplies these from `leela.core.web`, over its own diff and text modules. They are small and
they are the pane's, so the package carries its own rather than reaching back into an IDE.
"""

import difflib, json, re
from dataclasses import dataclass, asdict
from fasthtml.common import JSONResponse
from fastcore.parallel import threaded

__all__ = ['errstr', 'fail', 'sse', 'off_loop', 'diff_payload', 'diff_rows', 'udiff']

def errstr(e): return f'{type(e).__name__}: {e}'

def fail(err, code=400):
    body = {'ok': False, 'error': errstr(err) if isinstance(err, Exception) else str(err)}
    if getattr(err, 'limit', None): body |= {'kernel_limit': err.limit, 'candidate': err.candidate}
    return JSONResponse(body, status_code=code)

def sse(event, data):
    "One server-sent event. A newline in the payload would end the frame, so it goes as JSON."
    return f'event: {event}\ndata: {json.dumps(data)}\n\n'

@threaded(process=False)
def off_loop(fn, *a, **kw):
    "Run blocking model and index work off the event loop."
    return fn(*a, **kw)

def udiff(a, b, n=3):
    return '\n'.join(difflib.unified_diff((a or '').split('\n'), (b or '').split('\n'), lineterm='', n=n))

@dataclass
class DiffRow:
    kind: str; text: str; line: int = 0
    def dict(self): return asdict(self)

_HUNK = re.compile(r'^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@')

def diff_rows(d):
    "A unified diff as rows the client paints, each carrying its line number in the new text."
    out, n = [], 0
    for line in (d or '').split('\n'):
        if not line and not out: continue
        if line.startswith('@@'):
            m = _HUNK.match(line); n = int(m.group(1)) if m else 0
            out.append(DiffRow('hunk', line))
        elif line.startswith(('---', '+++')): out.append(DiffRow('head', line))
        elif line.startswith('+'): out.append(DiffRow('add', line[1:], n)); n += 1
        elif line.startswith('-'): out.append(DiffRow('del', line[1:]))
        else: out.append(DiffRow('ctx', line[1:] if line.startswith(' ') else line, n)); n += 1
    return out

def diff_payload(was, now):
    "One text-vs-text comparison in the shape every diff surface in the client consumes."
    rs = diff_rows(udiff(was, now, n=0))
    add, rem = sum(r.kind == 'add' for r in rs), sum(r.kind == 'del' for r in rs)
    label = ' '.join(p for p in (f'+{add}' if add else '', f'−{rem}' if rem else '') if p)
    return {'label': label, 'rows': [r.dict() for r in diff_rows(udiff(was, now))]}
