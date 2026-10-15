"""Defesas do servidor local: estáticos por allowlist, Host/Origin, Content-Length, cabeçalhos.

NEST_SRC aponta para outra cópia do código (ex.: a versão antiga, para provar que estes
testes falham nela); sem a variável, usa o repositório.
"""
import http.client, json, os, socket, sys, tempfile, threading, unittest
from pathlib import Path
sys.path.insert(0, os.environ.get("NEST_SRC") or str(Path(__file__).resolve().parents[1]))
os.environ["NEST_DATA"] = tempfile.mkdtemp(prefix="nest-sec-")
import server
from http.server import ThreadingHTTPServer


class SecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()

    def req(self, method, path, headers=None, body=None, host=None):
        """Pedido cru: caminho e cabeçalhos vão exatamente como escritos. Devolve (status, headers)."""
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            c.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
            c.putheader("Host", host or "127.0.0.1:%d" % self.port)
            for k, v in (headers or {}).items():
                c.putheader(k, v)
            c.endheaders(body)
            r = c.getresponse()
            r.read()
            return r.status, r.headers
        except (ConnectionError, http.client.HTTPException, socket.timeout) as exc:
            return "erro: %r" % exc, {}
        finally:
            c.close()

    def post(self, path, obj=None, raw=None, **kw):
        body = raw if raw is not None else json.dumps(obj).encode()
        h = {"Content-Type": "application/json", "Content-Length": str(len(body))}
        h.update(kw.pop("headers", {}))
        return self.req("POST", path, h, body, **kw)[0]

    def test_page_is_served(self):
        for p in ("/", "/index.html", "/app.js", "/sim.js"):
            self.assertEqual(self.req("GET", p)[0], 200, p)
        self.assertEqual(self.req("GET", "/app.js/../server.py")[0], 404)

    def test_only_page_is_static(self):
        for p in ("/%64ata/store.json", "/DATA/x", "/server.p%79", "/server.py.", "/.git/HEAD",
                  "/server.py", "/engine.py", "/%73erver.py"):
            for m in ("GET", "HEAD"):
                self.assertEqual(self.req(m, p)[0], 404, "%s %s" % (m, p))

    def test_foreign_host_rejected(self):
        for h in ("evil.example:%d" % self.port, "127.0.0.1:1", "localhost"):
            self.assertEqual(self.req("GET", "/", host=h)[0], 421, h)
            self.assertEqual(self.req("GET", "/api/store", host=h)[0], 421, h)
        self.assertEqual(self.req("GET", "/", host="localhost:%d" % self.port)[0], 200)

    def test_foreign_origin_post_rejected(self):
        body = {"kind": "nota", "detail": "x"}
        for o in ("http://evil.example", "null", "http://127.0.0.1:1"):
            self.assertEqual(self.post("/api/history", body, headers={"Origin": o}), 403, o)
        for o in ("http://127.0.0.1:%d" % self.port, "http://localhost:%d" % self.port):
            self.assertEqual(self.post("/api/history", body, headers={"Origin": o}), 200, o)
        self.assertEqual(self.post("/api/history", body), 200)  # sem Origin (curl, testes): aceito

    def test_cnc_module_optional(self):
        self.assertEqual(self.req("GET", "/api/modules")[0], 200)
        saved = server.cam
        try:
            server.cam = None   # instalador sem o módulo de usinagem
            self.assertEqual(self.post("/api/gcode", {"sheets": [], "cam": {}}), 404)
        finally:
            server.cam = saved

    def test_bad_content_length(self):
        def send(cl):
            h = {"Content-Type": "application/json"}
            if cl is not None:
                h["Content-Length"] = cl
            return self.req("POST", "/api/history", h)[0]
        for cl in (None, "abc", "-5", "1.5"):
            self.assertEqual(send(cl), 400, cl)
        self.assertEqual(send(str(100 * 1024 * 1024 + 1)), 413)

    def test_security_headers(self):
        for p in ("/", "/api/store"):
            st, h = self.req("GET", p)
            self.assertEqual(st, 200, p)
            self.assertEqual(h.get("X-Content-Type-Options"), "nosniff", p)
            self.assertEqual(h.get("X-Frame-Options"), "DENY", p)
            self.assertTrue(h.get("Referrer-Policy"), p)
            csp = h.get("Content-Security-Policy") or ""
            self.assertIn("default-src", csp, p)
            self.assertIn("script-src 'self'", csp, p)
            self.assertNotIn("script-src 'self' 'unsafe-inline'", csp, p)
            self.assertIn("frame-ancestors 'none'", csp, p)
            self.assertIn("no-store", h.get("Cache-Control") or "", p)

    def test_log_file_has_request_line_not_poll(self):
        self.req("GET", "/api/nest/poll/none")
        self.req("GET", "/api/store")
        text = (Path(os.environ["NEST_DATA"]) / "logs" / "server.log").read_text(encoding="utf-8")
        self.assertIn("GET /api/store", text)
        self.assertNotIn("/api/nest/poll/", text)

    def test_nest_start_bad_seconds_400(self):
        for s in ("Infinity", "NaN", "-Infinity", "0", "-1", "7201", "\"x\""):
            raw = ('{"seconds": %s, "groups": {}}' % s).encode()
            self.assertEqual(self.post("/api/nest/start", raw=raw), 400, s)


if __name__ == "__main__":
    unittest.main()
