import os
from fasthtml.common import *
from fasthtml.common import Meta, Favicon, Socials, Link, serve, JSONResponse
from starlette.middleware import Middleware
from starlette.middleware.gzip import GZipMiddleware
from starlette.routing import Mount
from .core import *
from valmiki import auth as a

__all__ = ['launch', 'app']

if cfg.purge: clear_cache()

hdrs = [
    *vendor_hdrs(),
    Meta(name='description', content=cfg.site_description),
    Meta(name='author', content=cfg.site_author),
    Meta(name='keywords', content=cfg.site_keywords),
    Meta(name='robots', content='noindex, nofollow'),
    Meta(name='theme-color', content='#FCA847'),
    Meta(name='apple-mobile-web-app-capable', content='yes'),
    Meta(name='apple-mobile-web-app-status-bar-style', content='default'),
    Meta(name='mobile-web-app-capable', content='yes'),
    Meta(name='mobile-web-app-status-bar-style', content='default'),
    *Favicon('/static/favicon.ico', '/static/favicon-dark.ico'),
    Link(rel='icon', type='image/svg+xml', href='/static/favicon.svg'),
    *Socials(title=cfg.app_nm, description=cfg.site_description, site_name=cfg.domain, image='/static/favicon.svg',
             url=cfg.domain), *themes()]

# fasthtml does `req.hdrs = deepcopy(self.hdrs)` on every request so a handler can add to
# the head for that response alone. Nothing here does, and the copy is not free: this list
# is thirty-odd nodes including the whole theme stylesheet, which came to ~350 recursive
# deepcopy calls on every request — including /health, which has no head at all.
# Serialised up front it is one string, and deepcopy of a str hands back the same object.
hdrs = [NotStr(to_xml(tuple(hdrs)))]

def nf(req, exc): return not_found()
kw, exh = {'class': 'hidden', 'hx-ext': 'preload', 'hx-boost': 'true'}, {404: nf, 500: nf, 403: nf}

# A page is 20-60KB of highly repetitive markup, which is what gzip is best at. minimum_size
# keeps it off the small htmx fragments, where the compression costs more than the bytes it
# saves. The first server-sent-events route added here has to exempt `text/event-stream`
# from this middleware, from Caddy and from anything else in front: a buffered stream is a
# broken one. See docs/agent-ui.md.
mw = [Middleware(GZipMiddleware, minimum_size=1024)]

# default_hdrs=False and no `exts`: both would put CDN <script src> back in the head.
# vendor_hdrs() is the same set, served locally — see valmiki/core/ui.py.
app, rt = fast_app(hdrs=hdrs, bodykw=kw, live=not_prod(), title=cfg.app_nm, default_hdrs=False, pico=False,
                   exception_handlers=exh, middleware=mw)

# serve versioned css/js (vurl ?v= links) immutable, ahead of the default static route
for _d in ('vendor', 'assets'):
    if (Path('static')/_d).exists():
        app.router.routes.insert(0, Mount(f'/static/{_d}', app=StaticImmutable(directory=f'static/{_d}'),
                                          name=f'static_{_d}'))

def index(req, auth): return landing(placeholder(f'{cfg.app_nm} is running. No block owns / yet.'), usr=auth)

app.get('/')(index)
app.get('/health')(lambda req: JSONResponse({'status': 'ok'}))
a.connect(app)   # auth connects last: it reads the complete RouteOverrides skip list

def n_workers():
    '''How many processes to serve on.

    Rendering a page is Python holding the GIL, so one process answers requests strictly
    one at a time however many threads are behind it. Processes are what lifts that, and
    every worker gets its own copy of the memos in ui, which is fine: they are derived
    from files on disk and none of them is authoritative.

    Capped rather than one per core because each worker holds its own sqlite connections.
    Set WEB_CONCURRENCY to override.'''
    return cfg.workers or max(1, min(4, (os.cpu_count() or 1)))

def launch():
    # reload=True is `serve`'s default and is incompatible with workers, so this is one switch.
    if not_prod(): return serve('valmiki.app', 'app', port=cfg.port, reload=True)
    serve('valmiki.app', 'app', port=cfg.port, reload=False, workers=n_workers())

if __name__ == '__main__': launch()
