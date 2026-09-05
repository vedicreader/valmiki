---
name: valmiki
description: >
  Build the modular agent UI on FastHTML + Oat. Each feature is a **block**: a folder with
  `cfg.py`, `data.py`, `ui.py`, `app.py`, and a `connect(app)` function. Blocks are wired in
  `valmiki/app.py`. Auth always connects last.
---

# valmiki

A FastHTML + Oat app whose features are blocks. `docs/agent-ui.md` says what is being built here
and why; this file says how to build in it.

## Commands

Always through `uv run`. Never `python …` directly, never `pip install`.

| command | purpose |
|---|---|
| `uv run python main.py` | dev server (`PORT`, default 5001) |
| `uv run pytest -q` | the suite |
| `uv run valmiki-setup` | write `.env.example`, install `SKILL.md` into `.claude/skills/valmiki/` and `.agents/skills/valmiki/` |

`SKILL.md` at the root is the source; the two installed copies are produced by the command.

## Block pattern

```python
def connect(app):
    seed_data()                          # idempotent, runs every start
    RouteOverrides.skip += Routes.skip   # declare public routes before auth connects
    app.get(Routes.base)(my_index)
    app.post(Routes.new)(my_create)
```

Connect order matters. Auth reads `RouteOverrides.skip` at connect time to build the middleware
allowlist, so a block with public routes appends to it before auth connects.

```python
# valmiki/app.py
mb.connect(app)
a.connect(app)   # auth: always last
```

Adding one:

1. `valmiki/myblock/` with `__init__.py`, `cfg.py`, `data.py`, `ui.py`, `app.py`
2. Routes in `cfg.py` as a frozen dataclass, with a `skip` list for the public ones
3. `connect(app)` in `app.py`
4. Wire it in `valmiki/app.py` above `a.connect(app)`

## Core imports

```python
from valmiki.core import (
    cfg, quick_lgr, cache, kv, get_lock, release_lock,
    get_pth, get_db_pth, in_static, get_db_dir, slug, thread_db, database,
    RouteOverrides, AppErr, home, send_email, not_prod,
    base, landing, navbar, not_found, email_template, loadX,
    asset_js, asset_css, vendor_js, themes,
    Badge, BadgeT, BadgePresetsT, PresetsT, NavBarT, ButtonT, TextT,
)
```

## Config

`cfg` is an `AttrDictDefault` in `valmiki/core/cfg.py`; every value comes from an env var.

| env var | default | purpose |
|---|---|---|
| `APP_NAME` / `APP_SH` | `Valmiki` / `valmiki` | display name, navbar short name |
| `MODE` | `dev` | `dev` or `production`. `not_prod()` reads it |
| `DOMAIN` | `http://localhost:5001` | full URL: emails, OAuth callbacks |
| `PORT` | `5001` | server port |
| `WEB_CONCURRENCY` | cores, capped at 4 | worker processes in production |
| `JWT_SCRT` | generated | signing secret for every token |
| `TOKEN_EXP` | `691200` | email and password-reset token lifetime, seconds |
| `API_TOKEN_EXP` | `31536000` | bearer token lifetime, seconds |
| `PURGE` | `false` | clear the diskcache at startup |
| `RESEND_API_KEY` | `''` | email verification and password reset |
| `WANT_GOOGLE` `GOOGLE_CLI` `GOOGLE_SCRT` | `true` | Google OAuth |
| `WANT_GIT` `GIT_CLI` `GIT_SCRT` | `false` | GitHub OAuth |

OAuth stays off when its credentials are empty, whatever `WANT_*` says.

## Core utilities

```python
info, error, warn = quick_lgr()          # log file named after the calling module
@cache(ttl=3600)                          # diskcache, stampede-protected, keyed on __qualname__
kv.set('k', v, expire=3600)               # the same diskcache, directly
if get_lock('job', ttl=60): ...           # cross-process lock on that cache
get_pth('x.log', sf='logs')               # data/logs/x.log
get_db_pth('myblock')                     # data/db/myblock.db
in_static('svg/logo.svg')                 # static/svg/logo.svg
slug('title' + str(time.time()))          # 11-char md5
```

**Databases.** `thread_db` opens one connection per thread and resolves a table against the
calling thread's connection on every use. Starlette runs sync handlers on a threadpool, and apsw
refuses a cursor on a connection busy in another thread, so a module-level `db.t.users` is a
dropped response under concurrency, not a slow one.

```python
db = thread_db(cfg.db, setup=_setup)
users = db.table('users')
```

`setup(db, first)` runs for every new connection; `first` is True exactly once per process, for
DDL. `.dataclass()` is per connection, so it belongs in `setup` unconditionally.

## UI

```python
base(content, usr, title='…')    # navbar + #main-content
landing(content)                 # welcome page: montage, typewriter
not_found()                      # 404
```

**A block owns its assets.** Put a block's CSS and JS in the block folder and pull them in from a
per-page head function rather than adding to `valmiki/core/theme.css`:

```python
asset_js(path)     # <script> for a block's .js — static/assets when writable, inline when not
asset_css(path)    # <link> for a block's .css — same fallback
vendor_js(name)    # static/vendor/<name>, content-hashed
```

Nothing is fetched from a CDN. `vendor_hdrs()` serves locally what `fast_app(default_hdrs=True)`
would have pulled from four origins; refresh those files with `tools/vendor_fetch.py`.

The chrome is serialised once and cached as a `NotStr` (`rendered(key, build)`), because a navbar
is a few hundred FT objects rebuilt on every response otherwise. Anything that can vary belongs in
the key.

**Navbar links.** `RouteOverrides.nav += [(label, href, tag, gated)]`. A `gated` entry opens the
login modal in place for a signed-out visitor instead of bouncing them to a bare login page.

## Themes

`THEMES` in `core/ui.py` lists the palettes the switcher offers; `themes(color=…)` sets the
default (`paper`). Every palette but `paper` overrides only `--primary`/`--primary-foreground`;
`theme-paper` moves the surface colours too, so a palette of that kind belongs in the same block
of `theme.css`. `theme.js` wraps each change in `withUiAnim`, which cross-fades for 220ms and is
skipped on first paint and under `prefers-reduced-motion`.

A block's stylesheet reads tokens and never declares them. That rule is what lets the agent block
follow Oat's tokens here and Leela's `--lee-*` there; see `docs/agent-ui.md`.

## Auth block (`valmiki/auth/`)

```python
import valmiki.auth as a
a.connect(app)   # always last
```

| route | purpose |
|---|---|
| `GET /a/m` | auth modal (login or register step) |
| `GET /a/ok` | 200 when authenticated, 401 otherwise |
| `POST /a/lgn` · `POST /a/reg` | login, register |
| `GET /a/ver-em` · `GET /a/fgt-pw` · `POST /a/pr-rst-pw` | verify, forgot, reset |
| `GET /a/lgt` | logout |
| `GET /a/google/callback` · `GET /a/github/callback` | OAuth |
| `GET /a/tkn` · `POST /a/tkn` · `POST /a/tkn-rm` | the bearer token: page, mint, revoke |

Handlers take `req` first, then `auth` — the user dict or `None`, put on the request by the
`setup_auth` beforeware.

**Bearer tokens.** `Authorization: Bearer <token>` authenticates any request. `bearer_usr` runs in
that same beforeware, before fasthtml's OAuth beforeware, which is why a token works whether or
not OAuth is configured — the OAuth one only fills `req.scope['auth']` when nothing has. Three
properties the tests hold:

- The token carries its own type, so an email-verification token signed by the same key is not
  an API credential.
- It sets no session cookie. An API client stays stateless.
- Minting replaces the previous token (one row per user per type), and it carries a `jti` so a
  re-issued token is a different string.

`RouteOverrides`: `lgn` where an unauthenticated request goes, `lgt` logout, `home` post-login,
`skip` the public routes. Token routes are never in `skip`.

**Users table:** `id, email, password_hash, status (pending/active/suspended/deleted),
display_name, avatar_url, auth_provider, provider_user_id, last_active_at, preferences,
created_at, updated_at`.

## Conventions

- **No decorator route registration.** `app.get(route)(handler)` inside `connect()`.
- Auth connects last.
- fastai idioms: `L`, `AttrDict`, `Path`, `ifnone`, `store_attr`, `patch`. No class unless one is
  genuinely needed.
- No ruff, no PEP 8. Dense. Short functions. A one-line docstring or none, and a comment only for
  what the code cannot say.
- `seed_*` functions are idempotent: check by slug or key before inserting.
- Every behaviour change gets a focused test in `tests/`, named as a sentence.
