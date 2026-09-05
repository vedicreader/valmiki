"""Write .env.example and install SKILL.md where agents look for it."""
import sys
from fastcore.all import Path, first

__all__ = ['setup', 'mk_env', 'install_skills']

ENV_KEYS = dict(APP_NAME='Valmiki', MODE='dev', PORT='5001', DOMAIN='http://localhost:5001',
                TOKEN_EXP='691200', API_TOKEN_EXP='31536000', PURGE='false',
                JWT_SCRT=None, RESEND_API_KEY=None,
                WANT_GOOGLE='true', GOOGLE_CLI=None, GOOGLE_SCRT=None,
                WANT_GIT='false', GIT_CLI=None, GIT_SCRT=None)

def repo_root(): return first((Path.cwd(), *Path.cwd().parents), lambda p: (p/'.git').exists()) or Path.cwd()

def mk_env(path=None):
    p = Path(path or repo_root()/'.env.example')
    p.write_text('\n'.join(f'{k}={"" if v is None else v}' for k, v in ENV_KEYS.items()) + '\n')
    print(f'env: wrote {p}')

def install_skills(dir=None):
    src = Path(__file__).parent/'SKILL.md'
    if not src.exists(): return print('skills: no SKILL.md')
    root = Path(dir or repo_root())
    for p in (root/'.agents/skills/valmiki/SKILL.md', root/'.claude/skills/valmiki/SKILL.md'):
        p.mk_write(src.read_text(encoding='utf-8'))
        print(f'skills: installed -> {p}')

def setup():
    mk_env()
    install_skills()

if __name__ == '__main__':
    install_skills() if 'skills' in sys.argv else mk_env() if 'mkenv' in sys.argv else setup()
