"The block's routes, its bounds, and the few constants the pane's markup reads."

from dataclasses import dataclass

__all__ = ['Routes', 'STEP_RANGE', 'TOOL_RANGE', 'PII_GATES', 'pii_gate', 'JOB_HELP',
           'chord_display', 'budget_value']

@dataclass(frozen=True)
class Routes:
    base = '/agent'
    skip = []                       # never public: these routes run tools on this machine

TOOL_RANGE, STEP_RANGE = (20, 400), (8, 80)
PII_GATES = ('off', 'redact', 'refuse')

def pii_gate(v):
    "A stored or posted policy, refused rather than silently read as `off`."
    g = str(v or 'off').strip().lower()
    if g not in PII_GATES: raise ValueError(f'pii must be one of {", ".join(PII_GATES)}')
    return g

def budget_value(v, lo, hi):
    "`auto`, or a number inside `lo..hi`. Anything else is `auto`, never a silent clamp to a bound."
    if isinstance(v, bool) or v is None: return 'auto'
    if isinstance(v, str) and v.strip().lower() == 'auto': return 'auto'
    try: n = int(str(v).strip())
    except (TypeError, ValueError): return 'auto'
    return n if lo <= n <= hi else 'auto'

def chord_display(action_or_key, sep=' / '):
    "What the host binds this action to. A host with no keymap says nothing."
    return ''

JOB_HELP = {
 'turn': 'Every turn of this conversation and every tool call it makes. The model the agent is.',
 'inline': 'The assistant inside a prompt cell, and the one asked about a selection. Unset, it falls back to oneshot.',
 'completion': 'Inline code completion as you type. Unset, it falls back to oneshot.',
 'oneshot': 'The fallback for the cheap jobs with no model of their own: classify, completion and inline. Nothing calls it directly, so setting it only moves the jobs you have left unset.',
 'classify': 'One-label questions the agent asks itself mid-turn. Unset, it falls back to oneshot.',
 'summary': 'Context compaction, conversation titles, agent charter drafts. Unset, it follows the turn model, so a long conversation is summarised by the model holding it.',
 'subagent': 'Delegated searches, which run as their own read-only agent.'}
