"""DWG sem depender do ODA: conversor próprio (tools/dwgconv, ACadSharp) lê e grava; ODA só como reserva."""
import os, sys, unittest
from pathlib import Path
from unittest import mock
sys.path.insert(0, os.environ.get("NEST_SRC") or str(Path(__file__).resolve().parents[1]))
import server

DXF = ("0\nSECTION\n2\nENTITIES\n0\nPOLYLINE\n8\nCORTE\n66\n1\n70\n1\n"
       + "".join("0\nVERTEX\n8\nCORTE\n10\n%s\n20\n%s\n" % p for p in [(0, 0), (300, 0), (300, 200), (0, 200)])
       + "0\nSEQEND\n8\nCORTE\n0\nENDSEC\n0\nEOF\n")


@unittest.skipUnless(server.find_dwgconv(), "conversor DWG (tools/dwgconv) não compilado")
class DwgTests(unittest.TestCase):
    def test_round_trip_without_oda(self):
        with mock.patch.object(server, "find_oda", return_value=None):
            dwg = server.dxf_to_dwg(DXF)
            self.assertEqual(dwg[:6], b"AC1018")                    # DWG 2004
            back = server.dwg_to_dxf(dwg, "peca.dwg")
        self.assertIn("CORTE", back)
        for v in ("300", "200"):
            self.assertIn(v, back)

    def test_crlf_dxf(self):
        with mock.patch.object(server, "find_oda", return_value=None):
            self.assertEqual(server.dxf_to_dwg(DXF.replace("\n", "\r\n"))[:6], b"AC1018")

    def test_bad_file_message_without_oda(self):
        with mock.patch.object(server, "find_oda", return_value=None):
            with self.assertRaises(RuntimeError) as ctx:
                server.dwg_to_dxf(b"isto nao e um dwg", "x.dwg")
        self.assertIn("Não foi possível ler este DWG", str(ctx.exception))

    def test_reads_with_own_converter_first(self):
        calls = []
        def broken(*a):
            calls.append(a[0])
            raise RuntimeError("falhou")
        with mock.patch.object(server, "_dwgconv", side_effect=broken), mock.patch.object(server, "find_oda", return_value=None):
            with self.assertRaises(RuntimeError):
                server.dwg_to_dxf(b"x", "x.dwg")
        self.assertEqual(calls, ["to-dxf"])


if __name__ == "__main__":
    unittest.main()
