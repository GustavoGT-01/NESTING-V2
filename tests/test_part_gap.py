"""Espaço entre peças e margem da chapa por peça, nos dois motores (Rust e Python)."""
import os, sys, unittest
from pathlib import Path
sys.path.insert(0, os.environ.get("NEST_SRC") or str(Path(__file__).resolve().parents[1]))
import engine

RECT = [[[0, 0], [30, 0], [30, 20], [0, 20]]]


def item(i, **kw):
    return dict({"id": "p%d" % i, "rings": RECT, "area": 600, "mirror": False, "rot": "0", "gid": ""}, **kw)


def boxes(res):
    out = {}
    for sheet in res["G"]["sheets"]:
        for q in sheet:
            out.setdefault(q["id"], []).append((q["x"], q["y"], q["x"] + 30, q["y"] + 20))
    return out


def gap(a, b):
    return max(b[0] - a[2], a[0] - b[2], b[1] - a[3], a[1] - b[3])


class PartGapTests(unittest.TestCase):
    def run_engine(self, motor):
        items = [item(0, mar=25), item(1, gap=15), item(1, gap=15)] + [item(k) for k in range(2, 8)]
        payload = {"seconds": 2, "gap": 2, "mar": 3, "rot": 0, "cs": 1, "workers": 1,
                   "groups": {"G": {"w": 400, "h": 120, "items": items}}}
        return boxes(engine.nest_all(payload, workers=1, motor=motor))

    def check(self, b):
        all_boxes = [(k, x) for k, v in b.items() for x in v]
        self.assertEqual(len(all_boxes), 9)
        a = b["p0"][0]
        self.assertGreaterEqual(min(a[0], a[1], 400 - a[2], 120 - a[3]), 25 - 1e-6)        # margem própria
        for k, x in all_boxes:
            self.assertGreaterEqual(min(x[0], x[1], 400 - x[2], 120 - x[3]), 3 - 1e-6)       # margem global
        for i, (k1, x1) in enumerate(all_boxes):
            for k2, x2 in all_boxes[i + 1:]:
                need = 15 if "p1" in (k1, k2) else 2
                self.assertGreaterEqual(gap(x1, x2), need - 1e-6, (k1, k2))

    def test_python(self):
        self.check(self.run_engine("python"))

    @unittest.skipUnless(engine.find_motor(), "motor compilado ausente")
    def test_rust(self):
        self.check(self.run_engine("rust"))


if __name__ == "__main__":
    unittest.main()
