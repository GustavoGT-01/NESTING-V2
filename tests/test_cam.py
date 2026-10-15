"""Usinagem: compensação do raio, passadas, micro-juntas, furação, rebaixo e G-code (NCStudio)."""
import math, os, re, sys, time, unittest
from pathlib import Path
sys.path.insert(0, os.environ.get("NEST_SRC") or str(Path(__file__).resolve().parents[1]))
import cam


def rect(x, y, w, h):
    return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]


def circle(cx, cy, r, n=48):
    return [[cx + r * math.cos(2 * math.pi * k / n), cy + r * math.sin(2 * math.pi * k / n)] for k in range(n)]


TOOLS = [
    {"id": "f6", "name": "Fresa 6 mm", "kind": "fresa", "dia": 6, "num": 1, "rpm": 18000, "feed": 6000, "plunge": 1500, "step": 6, "stepover": 40},
    {"id": "b5", "name": "Broca 5 mm", "kind": "broca", "dia": 5, "num": 2, "rpm": 12000, "feed": 2000, "plunge": 1200, "step": 20},
]


def cfg(**over):
    c = {"machine": {"safe": 15, "over": 0.2, "atc": False},
         "tools": TOOLS,
         "strategy": {"profile_tool": "f6", "pocket_tool": "f6", "ramp": 30, "tabs": True, "tab_area": 20000,
                      "tab_count": 2, "tab_w": 6, "tab_h": 2}}
    for k, v in over.items():
        c[k] = {**c.get(k, {}), **v}
    return c


def zs(gcode):
    return [float(m) for m in re.findall(r"Z(-?[\d.]+)", gcode)]


class OffsetTests(unittest.TestCase):
    def test_square_out_and_in(self):
        sq = rect(0, 0, 100, 50)
        out = cam.offset(sq, 3)
        self.assertEqual(len(out), 1)
        self.assertAlmostEqual(cam.area(out[0]), 106 * 56 - (36 - 9 * math.pi), delta=3)   # cantos arredondados
        self.assertTrue(all(abs(cam.ring_dist(p, sq) - 3) < 0.05 for p in out[0]))
        inn = cam.offset(sq, -3)
        self.assertAlmostEqual(cam.area(inn[0]), 94 * 44, delta=0.5)                        # cantos vivos por dentro
        self.assertEqual(cam.offset(rect(0, 0, 5, 5), -3), [])                              # não cabe a ferramenta

    def test_concave_notch_closes(self):
        # "U" com abertura de 4 mm: por fora, a fresa de 6 não entra na fenda
        u = [[0, 0], [30, 0], [30, 40], [17, 40], [17, 10], [13, 10], [13, 40], [0, 40]]
        out = cam.offset(u, 3)
        self.assertEqual(len(out), 1)
        self.assertTrue(all(cam.ring_dist(p, u) > 2.9 for p in out[0]))
        self.assertFalse(any(13 < x < 17 and y < 38 for x, y in out[0]))

    def test_dumbbell_inner_splits(self):
        # furo com gargalo de 4 mm: por dentro, vira dois caminhos separados
        h = [[0, 0], [20, 0], [20, 8], [30, 8], [30, 0], [50, 0], [50, 20], [30, 20], [30, 12], [20, 12], [20, 20], [0, 20]]
        self.assertEqual(len(cam.offset(h, -3)), 2)

    def test_many_corners_fast(self):
        gear = []
        for k in range(240):
            a = 2 * math.pi * k / 240
            rr = 100 + (6 if k % 2 else 0)
            gear.append([rr * math.cos(a), rr * math.sin(a)])
        t0 = time.time()
        out = cam.offset(gear, 3)
        self.assertEqual(len(out), 1)
        self.assertLess(time.time() - t0, 5)

    def test_circle_detect(self):
        self.assertIsNotNone(cam.circle_of(circle(0, 0, 2.5)))
        self.assertIsNone(cam.circle_of(rect(0, 0, 10, 10)))


class GcodeTests(unittest.TestCase):
    def sheet(self, parts):
        return {"name": "t", "w": 1000, "h": 600, "th": 15, "parts": parts}

    def test_profile_depth_passes_and_frame(self):
        r = cam.gcode_sheet(self.sheet([{"rings": [rect(100, 100, 300, 200)]}]), cfg(strategy={"tabs": False}))
        g = r["files"][0]["gcode"]
        self.assertTrue(g.startswith("G90 G17 G21"))
        self.assertTrue(g.rstrip().endswith("M30"))
        self.assertIn("S18000 M03", g)
        self.assertNotIn("M06", g)                                   # troca manual: sem M06
        self.assertAlmostEqual(min(zs(g)), -15.2, places=3)            # atravessa 0,2 mm
        self.assertIn(-10.133, [round(z, 3) for z in zs(g)])           # três passadas de 5,067 (passo 6)
        xs = [float(x) for ln in g.splitlines() if ln.startswith("G1") for x in re.findall(r"X(-?[\d.]+)", ln)]
        self.assertAlmostEqual(min(xs), 97, places=1)                  # compensou o raio por fora
        self.assertGreater(r["stats"]["cut_m"], 0)

    def test_climb_outside_is_clockwise(self):
        r = cam.gcode_sheet(self.sheet([{"rings": [rect(100, 100, 300, 200)]}]), cfg(strategy={"tabs": False, "ramp": 0}))
        loop = r["preview"][0]["pts"]
        self.assertLess(cam.area(loop), 0)
        r = cam.gcode_sheet(self.sheet([{"rings": [rect(100, 100, 300, 200)]}]), cfg(strategy={"tabs": False, "ramp": 0, "dir": "conv"}))
        self.assertGreater(cam.area(r["preview"][0]["pts"]), 0)

    def test_tabs_only_on_small_parts(self):
        small = {"rings": [rect(50, 50, 80, 60)]}
        big = {"rings": [rect(300, 50, 400, 400)]}
        r = cam.gcode_sheet(self.sheet([big, small]), cfg())
        g = r["files"][0]["gcode"]
        self.assertIn(-13.0, [round(z, 3) for z in zs(g)])            # topo da micro-junta: 2 mm de material
        prev = {p["op"]: p for p in r["preview"]}
        tabs = [p for p in r["preview"] if p["tabs"]]
        self.assertEqual(len(tabs), 1)
        self.assertEqual(len(tabs[0]["tabs"]), 2)
        # vácuo: a peça pequena é cortada antes da grande
        self.assertLess(cam.area(r["preview"][0]["pts"]) * -1, 100 * 80)

    def test_holes_drilled_or_profiled_before_outer(self):
        part = {"rings": [rect(100, 100, 300, 200), circle(150, 150, 2.5), rect(250, 150, 60, 40)]}
        r = cam.gcode_sheet(self.sheet([part]), cfg(strategy={"tabs": False}))
        ops = [p["op"] for p in r["preview"]]
        self.assertEqual(ops, ["furo", "interno", "externo"])
        self.assertEqual(len(r["files"]), 2)                           # troca manual: um arquivo por ferramenta
        self.assertIn("S12000 M03", r["files"][0]["gcode"])            # broca primeiro
        self.assertTrue(r["files"][0]["suffix"].endswith("_T2"))
        r = cam.gcode_sheet(self.sheet([part]), cfg(machine={"atc": True}, strategy={"tabs": False}))
        g = r["files"][0]["gcode"]
        self.assertEqual(len(r["files"]), 1)
        self.assertLess(g.index("T2 M06"), g.index("T1 M06"))

    def test_pocket_depth_and_layers(self):
        part = {"rings": [rect(100, 100, 300, 200)], "pockets": [{"r": rect(150, 150, 100, 60), "d": 5, "k": "rebaixo"}]}
        r = cam.gcode_sheet(self.sheet([part]), cfg(strategy={"tabs": False}))
        g = r["files"][0]["gcode"]
        pocket_z = [round(z, 3) for z in zs(g)]
        self.assertIn(-5.0, pocket_z)
        ops = [p["op"] for p in r["preview"]]
        self.assertEqual(ops[0], "rebaixo")
        self.assertGreater(len([p for p in r["preview"] if p["op"] == "rebaixo"]), 3)   # várias voltas de dentro para fora

    def test_zero_on_table(self):
        r = cam.gcode_sheet(self.sheet([{"rings": [rect(100, 100, 300, 200)]}]), cfg(machine={"zero": "mesa"}, strategy={"tabs": False}))
        self.assertAlmostEqual(min(zs(r["files"][0]["gcode"])), -0.2, places=3)

    def test_bad_input_rejected(self):
        with self.assertRaises(cam.CamError):
            cam.gcode_sheet(self.sheet([]), cfg(strategy={"profile_tool": "nada"}))
        with self.assertRaises(cam.CamError):
            cam.gcode_sheet({"w": 10, "h": 10, "th": float("nan"), "parts": []}, cfg())
        bad = [dict(TOOLS[0], dia=-1)]
        with self.assertRaises(cam.CamError):
            cam.gcode_sheet(self.sheet([]), {**cfg(), "tools": bad})


if __name__ == "__main__":
    unittest.main()
