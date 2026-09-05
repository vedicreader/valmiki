# valmiki

A modular agent UI, built one block at a time.

The agent pane that Leela grew is being lifted out into this repository, so that one UI serves
three hosts: [Leela](https://github.com/vedicreader/leela) mounts it in the IDE,
[Ramabana](https://github.com/vedicreader/ramabana) mounts it as a generic agent, and valmiki
serves it on its own as a web app you open on a phone. `docs/agent-ui.md` is the plan;
Leela's `docs/ui-blocks.md` is the extraction half of it.

What is here today is the base that block lands on: a FastHTML + [Oat](https://oat.ink) app,
a theme, and an auth block that takes a session or a bearer token.

## Run it

```bash
uv sync --group dev
uv run python main.py     # http://localhost:5001
uv run pytest -q
```

`uv run valmiki-setup` writes `.env.example` and installs `SKILL.md` where agents look for it.

Nothing here is meant to face the open internet. It runs on your own machine and you reach it
from a phone over [Tailscale](https://tailscale.com), on the tailnet address of the laptop
serving it. Set `DOMAIN` to that address so OAuth callbacks and links resolve.

## Blocks

A feature is a folder with `cfg.py`, `data.py`, `ui.py`, `app.py`, and a `connect(app)` that
registers its routes. `valmiki/app.py` wires them in order, and auth connects last because it
reads the complete `RouteOverrides.skip` list at connect time.

```python
import valmiki.myblock as mb
mb.connect(app)
a.connect(app)   # still last
```

`valmiki/core/` is what every block may import: config, cache, logging, paths, the theme, the
navbar and the shared atoms. `SKILL.md` documents all of it.

## Auth

Two ways in, and both end at the same `req.scope['auth']` dict.

- **A session.** Email and password with a Resend verification link, Google OAuth, GitHub
  OAuth. Providers switch on only when their credentials are present.
- **A bearer token.** `Authorization: Bearer <token>` on any request. Mint one at `/a/tkn`
  while signed in; minting replaces the previous token and **Revoke** ends it. It is a signed
  token of its own type, so an email-verification link cannot be used as one, and it sets no
  cookie, so an API client stays stateless.

```
RESEND_API_KEY=re_...                    # email verification and password reset
WANT_GOOGLE=true GOOGLE_CLI=... GOOGLE_SCRT=...    # callback {DOMAIN}/a/google/callback
WANT_GIT=true    GIT_CLI=...    GIT_SCRT=...       # callback {DOMAIN}/a/github/callback
API_TOKEN_EXP=31536000                   # bearer token lifetime, seconds
```

## Layout

```
valmiki/
  app.py        the head, the middleware, the wiring, `launch()`
  core/         config, cache, logging, paths, theme, navbar, shared atoms
  auth/         sessions, OAuth, bearer tokens
static/         vendored js and css, fonts, icons. no CDN
tests/          pytest
docs/           the plan for the agent block
```

## Style

fastai idioms, dense code, no ruff and no PEP 8. Short functions, one-line docstrings or none,
comments only for what the code cannot say. It reads on a phone.

## License

MIT
