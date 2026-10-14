"""Limites do encaixe vindos da página: prazo, núcleos, encaixes simultâneos e JSON válido."""
import json, math, os, sys, threading, unittest
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

        def slow(payload, pool, workers):  # segura o encaixe até o teste liberar
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


if __name__ == "__main__":
    unittest.main()
