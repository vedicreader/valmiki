import os, tempfile, pytest

_tmp = tempfile.mkdtemp(prefix='valmiki-tests-')
os.chdir(_tmp)   # cfg writes data/ relative to cwd, and does it at import time

@pytest.fixture(scope='session')
def client():
    from starlette.testclient import TestClient
    from valmiki.app import app
    return TestClient(app, follow_redirects=False)

@pytest.fixture(scope='session')
def usr():
    from valmiki.auth.data import users, Status
    return users.insert(dict(email='t@example.com', display_name='T', status=Status.active))
