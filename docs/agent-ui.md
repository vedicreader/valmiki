# The agent pane as a valmiki block

Leela's `docs/ui-blocks.md` measures what holds the agent pane inside Leela and lays out sixteen
steps to lift it out. This is the other half: where it lands, what it is made of once it is here,
and what changes in that plan because it lands here rather than in a new repository.

Read that document first. Its Phase 0 (steps 1 to 7) is right and is most of the work. Everything
below amends Phases 1 to 4.

## The package is valmiki. There is no `sabha`

The plan's Phase 4 builds auth, a responsive layout, a manifest, a service worker and a deploy
story from nothing. valmiki has four of the five already, because they are what a lego template is:

| Phase 4 wants | valmiki has |
|---|---|
| a token on every `/agent/*` route (step 13) | `lego/auth/`: sessions, JWT, email verification, Google and GitHub OAuth, and `RouteOverrides.skip` as the allowlist auth reads at connect time |
| a mobile layout (step 14) | Oat + `theme.css`, mode and palette switching, a font scale, a navbar that already collapses |
| `manifest.json` and an icon set (step 15) | `static/favicon.*`, the head in `lego/app.py`, `apple-mobile-web-app-*` already set |
| something to open on a phone | `deploy.py`: Hetzner provisioning, docker compose, a Cloudflare tunnel, `lego-push` for secrets |
| assets served without a CDN or a build | `asset_js` / `asset_css` / `vendor_js`, content-hashed, with an inline fallback on a read-only filesystem |

So the agent pane is `valmiki/agent/`, an ordinary block: `cfg.py`, `data.py`, `ui.py`, `app.py`,
`agent.css`, the ES modules, and `connect(app, port)`. Leela imports the block. Ramabana imports the
block. valmiki serves it beside blog, dash and hora, which is what makes it a template rather than a
demonstration.

Three consequences, all of them decisions rather than details.

**1. `__init__.py` must stop importing the app.** `lego/__init__.py` is `from .app import *`, and
`lego/app.py` imports auth, blog, dash and hora, and through them apscheduler, diskcache and
fastlite. `import valmiki.agent` from Leela would pay for all of it. Leela's server import is
measured at 377ms and 48MB and the last round of that work was spent getting dhrishti *out* of the
startup path. `__init__.py` goes empty, `main.py` and the `[project.scripts]` entries import
`valmiki.app` by name. This is the first commit, before anything moves.

**2. The wheel carries ten megabytes of dash seeds.** `lego/dash/seed/` is 9.9MB of gzipped SQL,
inside the one package `[tool.hatch.build]` ships. Leela would pull the Chinook database to draw an
agent pane. Either the seeds leave the wheel and `/dash` downloads or scaffolds them, or the agent
block becomes its own distribution out of the same repository. The first is less machinery and
`DBS` already drops a database whose dump is absent.

**3. The package is renamed.** `lego` is the template's name; the repository is valmiki and two other
packages are about to depend on it by name.

## The theme is a bridge, not a port

The requirement is that valmiki has its own theme and takes Leela's when it is inside Leela. Both
hosts already have a full token set, and they disagree about everything except that they are CSS
custom properties:

| | valmiki | Leela |
|---|---|---|
| selector | `html.theme-paper`, `html.dark` / `html.light` | `:root[data-theme="vscode"][data-mode="dark"]` |
| families | 11 palettes; only `paper` moves the surface colours | leela, cursor, vscode, jetbrains, solarized |
| names | Oat's `--background` `--card` `--primary` `--border` `--muted-foreground` | `--lee-bg` `--lee-bg1` `--lee-fg` `--lee-border` `--lee-accent` |
| mode | a class on `<html>`, plus `light-dark()` in the values | a resolved `data-mode` attribute |

The block reads neither. It reads its own vocabulary — `--val-bg`, `--val-surface`, `--val-fg`,
`--val-dim`, `--val-border`, `--val-accent`, `--val-ok`, `--val-warn`, `--val-mono` — and each host
supplies one file that defines those nine and nothing else:

```
valmiki/agent/agent.css          the rules. no hex, no rgb, no hsl, no oklch, no host token
valmiki/agent/tokens.oat.css     --val-* from Oat's tokens        (valmiki, and any lego app)
valmiki/agent/tokens.lee.css     --val-* from --lee-*             (Leela)
```

Leela then gets five theme families and both modes for free, because `--lee-bg` is already correct
under each of them, and valmiki gets eleven palettes and the mode switcher for the same reason. A
third host writes a third bridge, nine lines long.

Held by a test: `agent.css` matches no colour literal and no `--lee-` or Oat token name; each bridge
defines all nine `--val-*` and declares nothing else. That is the same rule Leela's plan states at
step 2 ("the agent CSS may read tokens, never declare them"), made symmetric so it survives a second
host.

`--lee-right-w` is the one non-colour token the pane reads, and it is layout rather than theme. It
becomes `--val-w`, defaulting to `100%` so the standalone app is full width and Leela's bridge pins
it to the right column.

## What `connect` takes

lego blocks read a module-level `cfg` and take `connect(app)`. This block cannot: its whole point is
two hosts with different backing. Leela's blocks already take `connect(app, ctx)`, where `Ctx` is a
declared capability surface over the workspace. So:

```python
def connect(app, port, prefix='/agent'):  "the 82 routes"
def panel(port):                          "the FastHTML fragment"
def headers(bridge='oat'):                "<link> for agent.css and the bridge, <script type=module>"
```

`AgentPort` is the six members Leela's plan derives at step 7 — `threads`, `assistants`, `settings`,
`state`, `history`, `execution`. It is not a new invention beside `Ctx`; it is `Ctx` narrowed, and
`WorkspacePort` is the adapter. Ramabana's side is `LocalPort`, living here and not in Ramabana,
because Ramabana has no `python-fasthtml` dependency and should not gain one for a UI.

**Capability gating comes from `Host.provides`, not from `execution is None`.** shalya's host contract
is the vocabulary both hosts already speak: Leela hands the agent a `WorkspaceHost`, Ramabana a
`LocalHost`, and each answers `provides` for the nine groups. The pane renders the kernel controls
when the host provides that group and omits them when it does not. Leela's plan handles the same
problem by having four routes return `{'ok': True, 'runtime': None}` — correct, but it is a fifth
place that knows which buttons exist, after the markup, the CSS, the JS and the port. One reading of
`provides` replaces all of it, and "the kernel buttons are absent rather than broken" stops being a
thing to test route by route.

## What changes in Phase 0

Steps 1 to 7 stand. Two amendments and a reordering.

**Do the theme bridge as step 2b**, immediately after the CSS split and before anything else is
written against `--lee-*`. Splitting 290 lines out of `lee-ide.css` and then rewriting their colours
a month later is doing the same reading twice.

**Drop `lee-agent.js` from the concatenator at step 6**, rather than emitting it as a module and then
teaching `build_ide_js.py` to read the installed package (the plan's step 11). Once the eight files
are ES modules they need no build: `headers()` returns one `<script type="module" src=…>` and the
browser fetches the graph. Leela already mounts several asset directories behind `/leestatic` through
`Assets(*static_dirs())`; the package's `static/` is one more entry. That removes a build step from
the seam, removes the `--check` staleness path for those files, and removes the plan's last risk
("two repos now version together") for everything except the routes.

Order: 1, 2, 2b, 3, 4, 5, 7, 6. Steps 3 and 4 are still the two that actually unstick things. 7 comes
before 6 because 7 is what a second host is blocked on and 6 is the largest.

## Risks the extraction plan does not carry

- **Server-sent events through a tunnel.** `/agent/stream` is SSE. valmiki runs behind
  `GZipMiddleware(minimum_size=1024)`, then Caddy, then a Cloudflare tunnel, and each of the three
  will buffer or compress a stream given the chance. `text/event-stream` needs an explicit exclusion
  at every layer and a test that asserts the first event arrives before the response is complete.
  This is the failure that will look like "the phone just hangs" and have nothing to do with the pane.
- **These routes are a remote shell.** The pane approves tool calls, and the tools write files and
  run commands. Nothing under the prefix may ever reach `RouteOverrides.skip`, and the deploy story
  has to say that out loud rather than leave it to a reader who is copying the blog block. A single
  bearer token is right for a phone talking to your own machine; it is not right for a Hetzner box on
  a public hostname, which is what `deploy.py` makes easy.
- **One user or many.** valmiki's auth is accounts. Ramabana standalone is one person and one token.
  Both have to work, which means the port carries an identity and `settings` is per-user, or the
  standalone app declares itself single-user at boot. Deciding this after the settings file exists
  costs a migration.
- **82 routes in one 1159-line file.** The largest lego block's `app.py` is 110 lines. The port's six
  members are the natural cut, and making it during the move is nearly free.
- **`models.py` probes mlx, llama and ollama on a background thread at boot.** Pointless on a
  phone-facing server. Opt-in, as the plan already says.

## Order

1. valmiki: empty `__init__.py`, rename, seeds out of the wheel. Three commits, no dependants yet.
2. Leela: Phase 0 as reordered above. Leela works after every step.
3. valmiki: `valmiki/agent/` from the moved files, against `AgentPort`.
4. Leela: `blocks/agent` becomes a re-export seam, the pattern `blocks/runtime/kernels.py` already
   uses over kunda. `ai.py` does not move.
5. valmiki: `LocalPort`, and `ramabana[web]` as the extra that pulls valmiki in.
6. The phone: auth mode, the narrow layout, the manifest, and reconnecting a dropped stream from
   `Feed.since(seq)`.

Steps 4 and 5 are independent of each other. Step 6 needs 3 and nothing else.
