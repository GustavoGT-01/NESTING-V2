import json, os, sys, tempfile, threading, unittest, urllib.request, urllib.error
from unittest import mock
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
        self.assertNotIn("history", store.load())
        self.assertEqual(store.read_history()["total"], 1)

    def test_history_does_not_invalidate_rev(self):
        r = store.load()["rev"]
        store.log("import", {}, "p1")
        store.save({"models": []}, r)  # não deve levantar Conflict

    def test_export_log_goes_to_exports(self):
        store.log("export", {"file": "a.eps"}, "p1")
        self.assertNotIn("exports", store.load())
        self.assertEqual(store.read_history(bucket="exports")["items"][0]["detail"]["file"], "a.eps")

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

    def test_patch_with_wrong_types_rejected(self):
        for patch in ({"projects": "x"}, {"models": {}}, {"settings": []}):
            with self.assertRaises(ValueError):
                store.save(patch, store.load()["rev"])
        self.assertEqual(store.load()["projects"], [])

    def test_project_must_be_object_with_lists(self):
        for bad in ([1, 2], {"parts": "x"}, {"files": {}}):
            with self.assertRaises(ValueError):
                store.save_project("p1", bad)

    def test_project_rev_conflict_and_legacy(self):
        self.assertEqual(store.load_project("p1")["rev"], 0)
        self.assertEqual(store.save_project("p1", {"parts": [1]}), 1)   # sem rev: aceito
        self.assertEqual(store.save_project("p1", {"parts": [2], "rev": 1}), 2)
        with self.assertRaises(store.Conflict):
            store.save_project("p1", {"parts": [3], "rev": 1})
        doc = store.load_project("p1")
        self.assertEqual((doc["parts"], doc["rev"]), ([2], 2))

    def test_exports_are_capped(self):
        doc = store.empty()
        doc["exports"] = [{"kind": "export"}] * store.EXPORTS_MAX
        store._write(doc)
        store.log("export", {"file": "ultimo.eps"})
        page = store.read_history(0, 1, "exports")
        self.assertEqual(page["total"], store.EXPORTS_MAX)
        self.assertEqual(page["items"][0]["detail"]["file"], "ultimo.eps")

    def test_big_or_bad_detail_rejected(self):
        with self.assertRaises(ValueError):
            store.log("export", {"x": "a" * 20001})
        with self.assertRaises(ValueError):
            store.log("export", [1])
        store.log("nota", "texto curto")
        self.assertEqual(store.read_history()["total"], 1)

    def test_recovered_backup_is_promoted(self):
        store.save({"models": [{"id": "x"}]}, 0)
        store.save({"models": [{"id": "y"}]}, 1)
        (self.d / "store.json").write_text("{quebrado", encoding="utf-8")
        first, second = store.load(), store.load()   # 2ª leitura não pode cair em vazio
        self.assertEqual(second["models"], [{"id": "x"}])
        self.assertEqual(second["rev"], first["rev"])
        with self.assertRaises(store.Conflict):
            store.save({"models": []}, 0)            # rev 0 antigo não passa mais
        self.assertEqual(store.load()["models"], [{"id": "x"}])

    def test_both_corrupt_raises_not_empty(self):
        store.save({"models": [{"id": "x"}]}, 0)
        store.save({"models": [{"id": "y"}]}, 1)
        for name in ("store.json", "store.json.bak"):
            (self.d / name).write_text("{quebrado", encoding="utf-8")
        for _ in range(2):
            with self.assertRaises(ValueError):
                store.load()
        with self.assertRaises(ValueError):
            store.save({"models": []}, 0)
        self.assertEqual(store.load_project("novo")["parts"], [])  # projeto inexistente: padrão vazio

    def test_replace_retries_on_permission_error(self):
        real, calls = os.replace, []
        def flaky(src, dst):
            calls.append(src)
            if len(calls) < 3:
                raise PermissionError(5, "Acesso negado")
            real(src, dst)
        with mock.patch("store.os.replace", flaky):
            store.save({"models": [{"id": "z"}]}, 0)
        self.assertEqual(store.load()["models"], [{"id": "z"}])
        with mock.patch("store.os.replace", side_effect=PermissionError(5, "Acesso negado")):
            with self.assertRaises(PermissionError):
                store.save({"models": []}, 1)
        self.assertFalse(list(self.d.glob("*.tmp")))
        self.assertEqual(store.load()["models"], [{"id": "z"}])

    def test_delete_project_keeps_file_aside(self):
        store.save_project("pA", {"parts": [{"id": 1}], "files": []})
        name = store.delete_project("pA")
        self.assertTrue(name.startswith("project_pA.json.excluido-"))
        self.assertTrue((self.d / name).exists())                 # recuperável
        self.assertFalse((self.d / "project_pA.json").exists())
        self.assertEqual(store.load_project("pA")["parts"], [])   # some da leitura
        self.assertEqual(store.delete_project("pA"), "")          # de novo: nada a fazer
        with self.assertRaises(store.BadId):
            store.delete_project("../x")

    def test_product_files_apart_from_projects(self):
        rev = store.save_project("x1", {"name": "Mesa", "parts": [{"id": 1}]}, "product")
        self.assertEqual(rev, 1)
        self.assertTrue((self.d / "product_x1.json").exists())
        self.assertFalse((self.d / "project_x1.json").exists())
        self.assertEqual(store.load_project("x1", "product")["name"], "Mesa")
        self.assertEqual(store.load_project("x1")["parts"], [])            # projeto de mesmo id: outro arquivo
        self.assertTrue(store.delete_project("x1", "product").startswith("product_x1.json.excluido-"))
        with self.assertRaises(store.BadId):
            store.load_project("x1", "../store")
        self.assertIn("products", store.load())

    def test_snapshot_daily_and_prunes(self):
        store.save({"models": [{"id": "m"}]}, 0)
        store.log("import", {"n": 1})
        root = self.d / "backups"
        for i in range(1, 17):
            (root / ("2000-01-%02d" % i)).mkdir(parents=True)
        day = store.snapshot(keep=14)
        self.assertTrue((day / "store.json").exists())
        self.assertTrue((day / "history.jsonl").exists())
        self.assertIsNone(store.snapshot(keep=14))       # já feito hoje
        days = sorted(p.name for p in root.iterdir())
        self.assertEqual(len(days), 14)
        self.assertIn(day.name, days)
        self.assertNotIn("2000-01-01", days)
        self.assertEqual(store.load()["models"], [{"id": "m"}])  # load segue no topo de data/

    def test_old_store_history_moves_once(self):
        doc = store.empty()
        doc["history"] = [{"t": "t", "kind": "import", "project": "p", "detail": {"n": 1}}]
        doc["exports"] = [{"t": "t", "kind": "export", "project": "p", "detail": {"file": "a.eps"}}]
        store._write(doc)
        store.load()
        store.load()  # segunda leitura não duplica
        raw = json.loads((self.d / "store.json").read_text(encoding="utf-8"))
        self.assertNotIn("history", raw)
        self.assertNotIn("exports", raw)
        self.assertEqual(store.read_history()["total"], 1)
        self.assertEqual(store.read_history(bucket="exports")["items"][0]["detail"]["file"], "a.eps")
        self.assertEqual((self.d / "history.jsonl").read_text(encoding="utf-8").count("\n"), 1)


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

    def test_project_stale_rev_gets_409(self):
        st, body = self.call("/api/project/h1", {"parts": []})
        self.assertEqual((st, body["rev"]), (200, 1))
        st, body = self.call("/api/project/h1", {"parts": [1], "rev": 1})
        self.assertEqual((st, body["rev"]), (200, 2))
        st, _ = self.call("/api/project/h1", {"parts": [2], "rev": 1})
        self.assertEqual(st, 409)
        st, _ = self.call("/api/project/h1", [1])
        self.assertEqual(st, 400)
        st, _ = self.call("/api/store", {"rev": self.call("/api/store")[1]["rev"], "patch": {"projects": "x"}})
        self.assertEqual(st, 400)

    def test_corrupt_store_gets_500(self):
        d = Path(os.environ["NEST_DATA"])
        self.call("/api/store", {"rev": self.call("/api/store")[1]["rev"], "patch": {"models": []}})
        for name in ("store.json", "store.json.bak"):
            (d / name).write_text("{quebrado", encoding="utf-8")
        try:
            st, _ = self.call("/api/store")
            self.assertEqual(st, 500)
        finally:
            for name in ("store.json", "store.json.bak"):
                (d / name).unlink()

    def test_history_page_rejects_bad_query(self):
        st, _ = self.call("/api/history", {"kind": "import", "detail": {"n": 1}})
        self.assertEqual(st, 200)
        st, doc = self.call("/api/store")
        self.assertNotIn("history", doc)
        st, page = self.call("/api/history?limit=10")
        self.assertEqual(st, 200)
        self.assertEqual(page["items"][0]["kind"], "import")
        st, _ = self.call("/api/history?limit=0")
        self.assertEqual(st, 400)
        st, _ = self.call("/api/history?bucket=../store")
        self.assertEqual(st, 400)

    def test_bad_project_id_rejected(self):
        st, _ = self.call("/api/project/..%2fstore", {"parts": []})
        self.assertEqual(st, 400)


if __name__ == "__main__":
    unittest.main()
