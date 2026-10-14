"""Mesma ordem de peças -> mesmas posições no nest.py e no motor compilado (modo "order")."""
import itertools, json, os, random, subprocess, sys, unittest
from pathlib import Path
ROOT = Path(os.environ.get("NEST_SRC") or Path(__file__).resolve().parents[1])
sys.path.insert(0, str(ROOT))
import nest

MOTOR = ROOT / "motor" / "target" / "release" / ("motor.exe" if os.name == "nt" else "motor")


def rect(w, h):
    return [[0, 0], [w, 0], [w, h], [0, h]]


def pieces():
    """14 peças: retângulos, L, triângulo e peças com furo; algumas espelháveis e com giro próprio."""
    shapes = [
        [rect(220, 140)], [rect(300, 60)], [rect(90, 90)], [rect(160, 40)],
        [[[0, 0], [180, 0], [180, 50], [50, 50], [50, 160], [0, 160]]],          # L
        [[[0, 0], [200, 0], [60, 120]]],                                       # triângulo
        [rect(200, 200), [[60, 60], [140, 60], [140, 140], [60, 140]]],         # furo grande
        [rect(120, 80), [[20, 20], [50, 20], [50, 50], [20, 50]]],
        [rect(70, 250)], [rect(110, 30)], [rect(140, 100)],
        [[[0, 0], [150, 0], [150, 30], [30, 30], [30, 90], [0, 90]]],
        [rect(60, 60)], [rect(250, 45)],
    ]
    rots = ["auto", "auto", "90", "auto", "auto", "free", "auto", "180", "auto", "0", "auto", "auto", "auto", "auto"]
    out = []
    for n, (rings, rot) in enumerate(zip(shapes, rots)):
        xs = [p[0] for p in rings[0]]
        ys = [p[1] for p in rings[0]]
        out.append({"id": "p%d" % n, "rings": rings, "area": (max(xs) - min(xs)) * (max(ys) - min(ys)),
                    "mirror": n % 3 == 0, "rot": rot, "gid": ""})
    return out


def python_order(payload, order):
    gap, cs, rot = float(payload["gap"]), float(payload["cs"]), int(payload["rot"])
    g = payload["groups"]["G"]
    items = []
    for n, it in enumerate(g["items"]):
        items.append(dict(it, uid=n, gene=0, gid="", angs=nest.angle_set(it["rings"], rot, str(it.get("rot", "auto")))))
    seq = [dict(items[u], gene=gene) for u, gene in order]
    opt = {"cs": cs, "gap": gap, "mar": float(payload["mar"]), "rules": nest._rules(payload),
           "crit": payload["crit"], **nest.radii(gap, cs)}
    sheets, fail, _ = nest.pack(seq, {"w": g["w"], "h": g["h"]}, opt, {})
    return {"sheets": [[[u, a, mi, x, y] for u, _, a, mi, x, y in sh.placed] for sh in sheets], "fail": fail}


@unittest.skipUnless(MOTOR.is_file(), "motor compilado não existe (cargo build --release em motor/)")
class ParityTests(unittest.TestCase):
    def test_same_order_same_positions(self):
        items = pieces()
        rnd = random.Random(7)
        for crit, cs, rot in itertools.product(("x", "box"), (2, 3), (90, -1)):
            order = [[u, rnd.randrange(2)] for u in rnd.sample(range(len(items)), len(items))]
            payload = {"gap": 4, "mar": 5, "cs": cs, "rot": rot, "crit": crit, "order": order,
                       "groups": {"G": {"w": 520, "h": 330, "items": items}}}
            with self.subTest(crit=crit, cs=cs, rot=rot):
                done = subprocess.run([str(MOTOR)], input=json.dumps(payload).encode(), capture_output=True, timeout=60)
                self.assertEqual(done.returncode, 0, done.stderr.decode(errors="replace"))
                rust = json.loads(done.stdout)
                py = python_order(payload, order)
                self.assertGreater(len(py["sheets"]), 1)  # o caso precisa abrir mais de uma chapa
                self.assertEqual(rust["fail"], py["fail"])
                self.assertEqual([len(s) for s in rust["sheets"]], [len(s) for s in py["sheets"]])
                for sr, sp in zip(rust["sheets"], py["sheets"]):
                    for qr, qp in zip(sr, sp):
                        self.assertEqual(qr[:3], [qp[0], qp[1], int(qp[2])], (qr, qp))
                        self.assertAlmostEqual(qr[3], qp[3], places=6)
                        self.assertAlmostEqual(qr[4], qp[4], places=6)


if __name__ == "__main__":
    unittest.main()
