"""Planejamento no encaixe: produtos na ordem da lista (seq) e cada produto em chapas vizinhas (near)."""
import os, sys, unittest
from pathlib import Path
sys.path.insert(0, os.environ.get("NEST_SRC") or str(Path(__file__).resolve().parents[1]))
import engine


def rect(w, h):
    return [[[0, 0], [w, 0], [w, h], [0, h]]]


def payload(seq, near):
    items = []
    # 4 produtos; cada um enche pouco mais de meia chapa, então dividir mal espalharia peças
    for rank, (prod, w, h, n) in enumerate([("A", 60, 40, 5), ("B", 50, 30, 7), ("C", 70, 45, 4), ("D", 40, 40, 6)]):
        items += [{"id": "%s%d" % (prod, k), "rings": rect(w, h), "area": w * h, "mirror": False, "rot": "0", "gid": "",
                   "prod": prod, "rank": rank} for k in range(n)]
    return {"seconds": 2, "gap": 2, "mar": 2, "rot": 0, "cs": 1, "workers": 1, "seq": seq, "near": near,
            "groups": {"G": {"w": 260, "h": 130, "items": items}}}


def sheets_of(res):
    out = {}
    for si, sheet in enumerate(res["G"]["sheets"]):
        for q in sheet:
            out.setdefault(q["id"][0], set()).add(si)
    return out, len(res["G"]["sheets"])


class PlanNestTests(unittest.TestCase):
    def check(self, motor):
        res = engine.nest_all(payload(True, True), workers=1, motor=motor)
        self.assertFalse(res["G"]["fail"])
        by, n = sheets_of(res)
        for prod, ss in by.items():
            self.assertEqual(ss, set(range(min(ss), max(ss) + 1)), "%s em chapas não vizinhas: %s" % (prod, ss))
        # ordem da lista: o primeiro produto abre a primeira chapa; os seguintes podem aproveitar sobras
        self.assertEqual(min(by["A"]), 0)
        self.assertLessEqual(min(by["B"]), min(by["C"]))

    def test_python(self):
        self.check("python")

    @unittest.skipUnless(engine.find_motor(), "motor compilado ausente")
    def test_rust(self):
        self.check("rust")


if __name__ == "__main__":
    unittest.main()
