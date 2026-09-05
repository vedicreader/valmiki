"A bearer token authenticates an API client, and only the token that was minted for it."

def hdr(tok): return {'Authorization': f'Bearer {tok}'}

def test_a_protected_route_redirects_without_credentials(client):
    assert client.get('/a/tkn').status_code == 303

def test_a_public_route_is_reachable_without_credentials(client):
    assert client.get('/health').status_code == 200

def test_a_minted_token_authenticates(client, usr):
    from valmiki.auth.data import mk_api_tkn
    r = client.get('/a/tkn', headers=hdr(mk_api_tkn(usr.id)))
    assert r.status_code == 200 and 'API token' in r.text

def test_a_bad_token_does_not(client, usr):
    assert client.get('/a/tkn', headers=hdr('not-a-token')).status_code == 303

def test_a_token_of_another_type_does_not(client, usr):
    "An email-verification token is signed by the same key; type is what keeps it out."
    from valmiki.auth.data import get_token, TokenT
    assert client.get('/a/tkn', headers=hdr(get_token(usr.id, TokenT.em_verify))).status_code == 303

def test_minting_replaces_the_previous_token(client, usr):
    from valmiki.auth.data import mk_api_tkn
    old = mk_api_tkn(usr.id)
    new = mk_api_tkn(usr.id)
    assert old != new
    assert client.get('/a/tkn', headers=hdr(old)).status_code == 303
    assert client.get('/a/tkn', headers=hdr(new)).status_code == 200

def test_revoking_stops_it(client, usr):
    from valmiki.auth.data import mk_api_tkn, rm_api_tkn, api_tkn
    tok = mk_api_tkn(usr.id)
    rm_api_tkn(usr.id)
    assert api_tkn(usr.id) is None
    assert client.get('/a/tkn', headers=hdr(tok)).status_code == 303

def test_a_token_expires(client, usr, monkeypatch):
    import valmiki.auth.data as d
    tok = d.mk_api_tkn(usr.id)
    monkeypatch.setattr(d.cfg, 'api_tkn_exp', 0)
    assert client.get('/a/tkn', headers=hdr(tok)).status_code == 303

def test_the_bearer_request_sets_no_session_cookie(client, usr):
    from valmiki.auth.data import mk_api_tkn
    r = client.get('/a/tkn', headers=hdr(mk_api_tkn(usr.id)))
    assert 'set-cookie' not in {k.lower() for k in r.headers}

def test_bearer_still_authenticates_when_google_oauth_is_wired(usr, monkeypatch):
    "The deployed shape: fasthtml's own OAuth beforeware runs after ours and must not undo it."
    from fasthtml.common import FastHTML
    from fasthtml.oauth import GoogleAppClient
    from starlette.testclient import TestClient
    import valmiki.auth.data as d, valmiki.auth.app as aa
    monkeypatch.setattr(d.cfg, 'g_cli', GoogleAppClient('id', 'secret'))
    monkeypatch.setattr(d.cfg, 'want_google', True)
    app = FastHTML(secret_key='test')
    aa.connect(app)
    c = TestClient(app, follow_redirects=False)
    assert c.get('/a/tkn', headers=hdr(d.mk_api_tkn(usr.id))).status_code == 200
    assert c.get('/a/tkn').status_code in (302, 303)
