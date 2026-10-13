import json, os, sys, tempfile, threading, unittest, urllib.request, urllib.error
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ["NEST_DATA"] = tempfile.mkdtemp(prefix="nest-test-")
import store, server
from http.server import ThreadingHTTPServer


def fresh():
    d = Path(tempfile.mkdtemp(prefix="nest-test-"))
    os.environ["NEST_DATA"] = str(d)
    return d


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.d = fresh()

    def test_models_and_colors_survive_restart(self):
        doc = store.load()
        models = [{"id": "m1", "name": "Bacio de poltrona", "color": "#4cc9f0"}]
        store.save({"models": models}, doc["rev"])
        again = store.load()            # "reinício": nova leitura do disco
        self.assertEqual(again["models"], models)

    def test_rev_conflict_blocks_stale_write(self):
        r = store.load()["rev"]
        store.save({"presets": [{"id": "a"}]}, r)
        with self.assertRaises(store.Conflict):
            store.save({"presets": []}, r)
        self.assertEqual(store.load()["presets"], [{"id": "a"}])

    def test_history_cannot_be_overwritten_by_client(self):
        store.log("import", {"n": 1}, "p1")
        store.save({"history": []}, store.load()["rev"])   # chave não editável
        self.assertEqual(len(store.load()["history"]), 1)

    def test_history_does_not_invalidate_rev(self):
        r = store.load()["rev"]
        store.log("import", {}, "p1")
        store.save({"models": []}, r)  # não deve levantar Conflict

    def test_export_log_goes_to_exports(self):
        store.log("export", {"file": "a.eps"}, "p1")
        self.assertEqual(store.load()["exports"][0]["detail"]["file"], "a.eps")

    def test_corrupt_main_uses_backup_and_keeps_bad_file(self):
        store.save({"models": [{"id": "x"}]}, 0)
        store.save({"models": [{"id": "y"}]}, 1)         # cria .bak com o estado "x"
        (self.d / "store.json").write_text("{quebrado", encoding="utf-8")
        self.assertEqual(store.load()["models"], [{"id": "x"}])
        self.assertTrue(list(self.d.glob("store.json.corrompido-*")))

    def test_projects_are_isolated_files(self):
        store.save_project("p1", {"parts": [1]})
        store.save_project("p2", {"parts": [2]})
        self.assertEqual(store.load_project("p1")["parts"], [1])
        self.assertEqual(store.load_project("p2")["parts"], [2])

    def test_project_id_rejects_path_tricks(self):
        for bad in ("../x", "a/b", "", "a b", "x" * 80):
            with self.assertRaises(store.BadId):
                store.save_project(bad, {})

    def test_no_partial_file_left_after_write(self):
        store.save({"models": []}, 0)
        self.assertFalse(list(self.d.glob("*.tmp")))


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fresh()
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def call(self, path, body=None):
        req = urllib.request.Request("http://127.0.0.1:%d%s" % (self.port, path),
                                     data=None if body is None else json.dumps(body).encode(),
                                     method="GET" if body is None else "POST")
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()

    def test_store_roundtrip_and_conflict(self):
        st, doc = self.call("/api/store")
        self.assertEqual(st, 200)
        st, _ = self.call("/api/store", {"rev": doc["rev"], "patch": {"models": [{"id": "m", "color": "#fff000"}]}})
        self.assertEqual(st, 200)
        st, _ = self.call("/api/store", {"rev": doc["rev"], "patch": {"models": []}})
        self.assertEqual(st, 409)

    def test_data_folder_and_code_not_served(self):
        for p in ("/data/store.json", "/server.py", "/store.py"):
            st, _ = self.call(p)
            self.assertEqual(st, 404, p)

    def test_bad_project_id_rejected(self):
        st, _ = self.call("/api/project/..%2fstore", {"parts": []})
        self.assertEqual(st, 400)


if __name__ == "__main__":
    unittest.main()
