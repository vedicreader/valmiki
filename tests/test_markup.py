"Every class the pages render has a rule somewhere in the CSS we ship."

import re
from pathlib import Path

ROOT = Path(__file__).parent.parent
CSS = '\n'.join((ROOT/p).read_text() for p in ('valmiki/core/theme.css', 'static/vendor/oat.min.css'))
DEFINED = set(re.findall(r'\.(-?[_a-zA-Z][\w-]*)', CSS))

def classes(html): return {c for m in re.findall(r'class="([^"]*)"', html) for c in m.split()}

def test_the_pages_use_no_class_that_no_stylesheet_defines(client, usr):
    from valmiki.auth.data import mk_api_tkn
    h = {'Authorization': f'Bearer {mk_api_tkn(usr.id)}'}
    seen = set()
    for path in ('/', '/a/tkn', '/a/m'): seen |= classes(client.get(path, headers=h).text)
    # `hidden` is the body class fasthtml removes on load; `lucide-icon` is fastlucide's own
    # marker, sized by attributes rather than by a rule
    assert not (seen - DEFINED - {'hidden', 'lucide-icon'})

def ids(html): return re.findall(r'id="([^"]+)"', html)

def test_no_page_repeats_an_element_id(client):
    for path in ('/', '/a/m'):
        got = ids(client.get(path).text)
        assert len(got) == len(set(got)), path

def test_the_login_modal_adds_no_id_the_page_already_has(client):
    "It is appended to the body, so a repeat leaves two elements answering to one selector."
    assert not (set(ids(client.get('/').text)) & set(ids(client.get('/a/m').text)))
