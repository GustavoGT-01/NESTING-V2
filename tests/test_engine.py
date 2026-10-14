"""Limites do encaixe vindos da página: prazo, núcleos, encaixes simultâneos e JSON válido."""
import json, math, os, sys, threading, time, unittest
from unittest import mock
from pathlib import Path
sys.path.insert(0, os.environ.get("NEST_SRC") or str(Path(__file__).resolve().parents[1]))
import engine


class EngineLimitsTests(unittest.TestCase):
    def test_seconds_must_be_finite_and_in_range(self):
        for bad in (math.inf, -math.inf, math.nan, 0, -1, 7201, "x", None):
            with self.assertRaises(ValueError, msg=repr(bad)):
                engine._limits({"seconds": bad}, 1)
            with self.assertRaises(ValueError, msg=repr(bad)):
                engine.start({"seconds": bad, "groups": {}})
            with self.assertRaises(ValueError, msg=repr(bad)):
                engine.nest_all({"seconds": bad, "groups": {}}, motor="python")
        for ok in (1, 7200, "30"):
            self.assertEqual(engine._limits({"seconds": ok}, 1)["seconds"], float(ok))

    def test_workers_capped_by_cpu_count(self):
        cpus = os.cpu_count() or 1
        self.assertEqual(engine._limits({"workers": 10 ** 6}, 1)["workers"], cpus)
        self.assertEqual(engine._limits({"workers": -5}, 1)["workers"], 1)
        self.assertEqual(engine._limits({}, 10 ** 6)["workers"], cpus)

    def test_third_job_is_busy_and_status_is_strict_json(self):
        gate = threading.Event()

        def slow(payload, pool, workers, stop_file=None):  # segura o encaixe até o teste liberar
            gate.wait(10)
            return {}

        with mock.patch.object(engine, "find_motor", return_value=None), \
                mock.patch.object(engine, "_python", slow):
            a = engine.start({"seconds": 1, "groups": {}})
            b = engine.start({"seconds": 1, "groups": {}})
            try:
                with self.assertRaises(engine.Busy):
                    engine.start({"seconds": 1, "groups": {}})
                for job in (a, b):
                    st = job.status()
                    json.dumps(st, allow_nan=False)  # nunca Infinity/NaN
                    self.assertFalse(st["done"])
                    self.assertEqual(st["seconds"], 1.0)
            finally:
                for job in (a, b):
                    job.stop()
                gate.set()
            for _ in range(100):
                if a.ended and b.ended:
                    break
                threading.Event().wait(0.05)
            self.assertTrue(a.ended and b.ended)
            c = engine.start({"seconds": 1, "groups": {}})  # com os dois terminados, volta a aceitar
            c.stop()
        for job in (a, b):
            json.dumps(job.status(), allow_nan=False)

    def test_many_groups_stay_near_requested_seconds(self):
        # antes: piso de 1 s por grupo, vezes dois critérios → 8 s para seconds=1
        rect = [[[0, 0], [30, 0], [30, 20], [0, 20]]]
        small = [[[0, 0], [20, 0], [20, 15], [0, 15]]]
        groups = {}
        for i in range(8):
            groups[str(i)] = {"w": 200, "h": 100, "items": [
                {"id": "a%d" % i, "rings": rect, "area": 600, "mirror": False, "rot": "90", "gid": ""},
                {"id": "b%d" % i, "rings": small, "area": 300, "mirror": False, "rot": "90", "gid": ""},
            ]}
        payload = {"seconds": 1, "gap": 2, "mar": 2, "rot": 90, "cs": 4, "workers": 1, "groups": groups}
        t0 = time.time()
        with mock.patch.object(engine, "find_motor", return_value=None):
            engine.nest_all(payload, workers=1, motor="python")
        self.assertLess(time.time() - t0, 4.0)

    def test_stop_file_cuts_python_during_pack(self):
        items = []
        for i in range(40):
            w, h = 80 + i * 10, 40 + (i % 5) * 10
            items.append({"id": "p%d" % i, "rings": [[[0, 0], [w, 0], [w, h], [0, h]]],
                          "area": w * h, "mirror": False, "rot": "auto", "gid": ""})
        payload = {"seconds": 20, "gap": 4, "mar": 5, "rot": -1, "cs": 2, "workers": 1,
                   "groups": {"G": {"w": 3000, "h": 1500, "items": items}}}
        with mock.patch.object(engine, "find_motor", return_value=None):
            job = engine.start(payload, workers=1)
            time.sleep(0.15)
            job.stop()
            limit = time.time() + 3
            while job.ended is None and time.time() < limit:
                time.sleep(0.05)
            self.assertIsNotNone(job.ended)
            self.assertLess(job.ended - job.started, 3.0)


if __name__ == "__main__":
    unittest.main()
