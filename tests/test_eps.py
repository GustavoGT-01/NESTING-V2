import sys, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import eps

SQ = [[0, 0], [100, 0], [100, 50], [0, 50]]
HOLE = [[20, 10], [30, 10], [30, 20], [20, 20]]


def sheet(parts=None, w=3000, h=1250):
    return {"w": w, "h": h, "parts": parts if parts is not None else [{"rings": [SQ, HOLE], "color": "#4cc9f0"}]}


class EpsTests(unittest.TestCase):
    def test_header_bbox_and_eof(self):
        t = eps.build_eps(sheet())
        self.assertTrue(t.startswith("%!PS-Adobe-3.0 EPSF-3.0"))
        info = eps.parse_eps(t)
        self.assertEqual(info["bbox"], [0, 0, 8504, 3544])      # 3000×1250 mm em pt, arredondado para cima
        self.assertTrue(info["eof"])

    def test_real_dimensions_roundtrip_within_tolerance(self):
        s = sheet()
        r = eps.validate(eps.build_eps(s), s)
        self.assertTrue(r["ok"], r["issues"])
        self.assertEqual(r["bbox_mm"], [3000.0, 1250.0])
        self.assertLess(r["max_dev_mm"], 0.001)

    def test_orientation_matches_screen(self):
        s = sheet([{"rings": [[[10, 10], [20, 10], [20, 30]]]}], w=100, h=100)
        got = eps.parse_eps(eps.build_eps(s))["rings"][0]
        for (gx, gy), (wx, wy) in zip(got, [(10, 10), (20, 10), (20, 30)]):
            self.assertAlmostEqual(gx, wx, 3); self.assertAlmostEqual(gy, wy, 3)

    def test_holes_are_separate_closed_contours(self):
        info = eps.parse_eps(eps.build_eps(sheet()))
        self.assertEqual(len(info["rings"]), 2)

    def test_validation_detects_tampering(self):
        s = sheet()
        t = eps.build_eps(s).replace("%%EOF", "")
        self.assertFalse(eps.validate(t, s)["ok"])
        t2 = "\n".join(l for l in eps.build_eps(s).splitlines() if l.strip() != "h")
        self.assertFalse(eps.validate(t2, s)["ok"])

    def test_wrong_sheet_size_detected(self):
        s = sheet()
        t = eps.build_eps(s)
        bad = dict(s, w=2999)
        self.assertFalse(eps.validate(t, bad)["ok"])

    def test_rejects_invalid_geometry(self):
        for parts in ([{"rings": [[[0, 0], [1, 1]]]}], [{"rings": [[[0, 0], [float("nan"), 1], [2, 2]]]}]):
            with self.assertRaises(ValueError):
                eps.build_eps(sheet(parts))
        with self.assertRaises(ValueError):
            eps.build_eps(sheet(w=0))

    def test_colors_only_when_requested(self):
        self.assertNotIn("0.29804", eps.build_eps(sheet()))
        self.assertIn("0.29804", eps.build_eps(sheet(), use_colors=True))

    def test_title_cannot_inject_postscript(self):
        t = eps.build_eps(sheet(), title="x\n%%EOF\nshowpage")
        self.assertEqual(t.count("%%EOF"), 1)

    def test_empty_sheet_is_valid_eps(self):
        s = sheet([])
        self.assertTrue(eps.validate(eps.build_eps(s), s)["ok"])


if __name__ == "__main__":
    unittest.main()
