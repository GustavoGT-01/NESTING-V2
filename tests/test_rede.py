"""Acesso pela rede: de fora da máquina tudo exige o PIN; a própria máquina entra direto."""
import http.client, json, os, sys, tempfile, threading, unittest
from pathlib import Path
sys.path.insert(0, os.environ.get("NEST_SRC") or str(Path(__file__).resolve().parents[1]))
os.environ["NEST_DATA"] = tempfile.mkdtemp(prefix="nest-rede-")
import server
from http.server import ThreadingHTTPServer

LAN = (server.lan_addresses() or [None])[0]


class PinTests(unittest.TestCase):
    def setUp(self):
        server.SESSIONS.clear()
        server.FAILS.clear()

    def test_ip_host(self):
        self.assertTrue(server.ip_host("192.168.0.10:8080", 8080))
        for h in ("192.168.0.10:1", "evil.example:8080", "localhost:8080", "[::1]:8080", "192.168.0.10"):
            self.assertFalse(server.ip_host(h, 8080), h)

    def test_wrong_pins_block_the_ip(self):
        pin = server.net_config()["pin"]
        for _ in range(5):
            self.assertIsNone(server.check_pin("10.0.0.9", "000000x", now=1000))
        self.assertIsNone(server.check_pin("10.0.0.9", pin, now=1100))   # bloqueado
        self.assertTrue(server.check_pin("10.0.0.8", pin, now=1100))     # outro IP segue
        self.assertTrue(server.check_pin("10.0.0.9", pin, now=1301))     # passou o bloqueio

    def test_new_pin_drops_sessions(self):
        tok = server.check_pin("10.0.0.7", server.net_config()["pin"])
        self.assertTrue(server.session_ok("a=1; %s=%s" % (server.COOKIE, tok)))
        server.net_save(new_pin=True)
        self.assertFalse(server.session_ok("%s=%s" % (server.COOKIE, tok)))
        self.assertFalse(server.session_ok("%s=inventado" % server.COOKIE))


@unittest.skipIf(LAN is None, "sem endereço de rede nesta máquina")
class RemoteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = ThreadingHTTPServer((LAN, 0), server.Handler)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        server.NET_ON = False
        cls.srv.shutdown()
        cls.srv.server_close()

    def setUp(self):
        server.NET_ON = True
        server.SESSIONS.clear()
        server.FAILS.clear()

    def req(self, method, path, headers=None, body=None):
        c = http.client.HTTPConnection(LAN, self.port, timeout=10)
        try:
            h = {"Host": "%s:%d" % (LAN, self.port)}
            h.update(headers or {})
            c.request(method, path, body=body, headers=h)
            r = c.getresponse()
            return r.status, r.headers, r.read()
        finally:
            c.close()

    def login(self, pin):
        return self.req("POST", "/api/login", {"Content-Type": "application/x-www-form-urlencoded",
                                               "Origin": "http://%s:%d" % (LAN, self.port)}, ("pin=" + pin).encode())

    def test_needs_pin(self):
        st, _, body = self.req("GET", "/")
        self.assertEqual(st, 200)
        self.assertIn(b'name="pin"', body)                  # página de entrada, não o programa
        for p in ("/app.js", "/api/store", "/api/rede"):
            self.assertEqual(self.req("GET", p)[0], 401, p)
        self.assertEqual(self.req("POST", "/api/history", {"Content-Type": "application/json"}, b"{}")[0], 401)

    def test_login_opens_session(self):
        st, _, body = self.login("999999x")
        self.assertIn(b"PIN errado", body)
        st, h, _ = self.login(server.net_config()["pin"])
        self.assertEqual(st, 303)
        cookie = h["Set-Cookie"].split(";")[0]
        self.assertIn("HttpOnly", h["Set-Cookie"])
        self.assertIn("SameSite=Strict", h["Set-Cookie"])
        self.assertEqual(self.req("GET", "/api/store", {"Cookie": cookie})[0], 200)
        self.assertEqual(self.req("GET", "/api/rede", {"Cookie": cookie})[0], 403)   # PIN e chave: só no principal
        self.assertEqual(self.req("POST", "/api/rede", {"Cookie": cookie}, b'{"newpin":true}')[0], 403)

    def test_foreign_origin_and_host_still_rejected(self):
        self.assertEqual(self.req("GET", "/", {"Host": "evil.example:%d" % self.port})[0], 421)
        st = self.req("POST", "/api/login", {"Origin": "http://evil.example", "Content-Type": "application/x-www-form-urlencoded"},
                      ("pin=" + server.net_config()["pin"]).encode())[0]
        self.assertEqual(st, 403)

    def test_off_means_closed(self):
        server.NET_ON = False
        self.assertEqual(self.req("GET", "/", {"Host": "127.0.0.1:%d" % self.port})[0], 403)
        self.assertEqual(self.login(server.net_config()["pin"])[0], 421)



class TunnelTests(unittest.TestCase):
    """cloudflared chega de 127.0.0.1 com Cf-Connecting-Ip: é internet, então vale o PIN."""
    @classmethod
    def setUpClass(cls):
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        server.NET_ON = False
        cls.srv.shutdown()
        cls.srv.server_close()

    def setUp(self):
        server.NET_ON = True
        server.SESSIONS.clear()
        server.FAILS.clear()

    def req(self, method, path, headers=None, body=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            h = {"Host": "abc-def.trycloudflare.com", "Cf-Connecting-Ip": "200.1.2.3"}
            h.update(headers or {})
            c.request(method, path, body=body, headers=h)
            r = c.getresponse()
            return r.status, r.headers, r.read()
        finally:
            c.close()

    def test_tunnel_needs_pin_and_https_origin(self):
        st, _, body = self.req("GET", "/")
        self.assertIn(b'name="pin"', body)
        self.assertEqual(self.req("GET", "/api/store")[0], 401)
        self.assertEqual(self.req("GET", "/api/store", {"Host": "127.0.0.1:%d" % self.port})[0], 401)   # host local não fura
        form = {"Content-Type": "application/x-www-form-urlencoded", "Origin": "https://abc-def.trycloudflare.com"}
        st, h, _ = self.req("POST", "/api/login", form, ("pin=" + server.net_config()["pin"]).encode())
        self.assertEqual(st, 303)
        self.assertIn("Secure", h["Set-Cookie"])
        cookie = h["Set-Cookie"].split(";")[0]
        self.assertEqual(self.req("GET", "/api/store", {"Cookie": cookie})[0], 200)
        self.assertEqual(self.req("GET", "/api/rede", {"Cookie": cookie})[0], 403)
        bad = dict(form, Origin="https://evil.example")
        self.assertEqual(self.req("POST", "/api/login", bad, b"pin=1")[0], 403)

    def test_tunnel_closed_when_network_off(self):
        server.NET_ON = False
        self.assertEqual(self.req("GET", "/")[0], 421)
        self.assertEqual(self.req("GET", "/", {"Host": "127.0.0.1:%d" % self.port})[0], 403)

    def test_other_domains_rejected(self):
        self.assertEqual(self.req("GET", "/", {"Host": "evil.example"})[0], 421)
        self.assertEqual(self.req("GET", "/", {"Host": "x.trycloudflare.com.evil.example"})[0], 421)


if __name__ == "__main__":
    unittest.main()
