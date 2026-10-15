"""Gera installer/icone.ico (chapa com pecas encaixadas) so com a biblioteca padrao.

Uso: python installer/icone.py
"""
import struct
import zlib
from pathlib import Path

BG, SHEET, AC, ALT, OK = (11, 15, 20), (27, 38, 51), (56, 189, 248), (99, 102, 241), (52, 211, 153)
# retangulos em fracao do lado: (x0, y0, x1, y1, cor)
SHAPES = [
    (0.12, 0.12, 0.88, 0.88, SHEET),
    (0.20, 0.20, 0.52, 0.50, AC),
    (0.58, 0.20, 0.80, 0.62, ALT),
    (0.20, 0.56, 0.52, 0.80, OK),
    (0.58, 0.68, 0.80, 0.80, AC),
]


def png(size: int) -> bytes:
    rows = []
    r = size * 0.18  # raio do canto do fundo
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            cx = min(max(x + 0.5, r), size - r)
            cy = min(max(y + 0.5, r), size - r)
            inside = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r
            color, alpha = BG, 255 if inside else 0
            for x0, y0, x1, y1, c in SHAPES:
                if x0 * size <= x < x1 * size and y0 * size <= y < y1 * size:
                    color = c
            row += bytes(color) + bytes([alpha])
        rows.append(bytes(row))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b"")


def ico(sizes=(16, 32, 48, 256)) -> bytes:
    images = [png(s) for s in sizes]
    out = struct.pack("<HHH", 0, 1, len(sizes))
    offset = 6 + 16 * len(sizes)
    for s, img in zip(sizes, images):
        out += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(img), offset)
        offset += len(img)
    return out + b"".join(images)


if __name__ == "__main__":
    data = ico()
    assert data[:4] == b"\x00\x00\x01\x00" and data.count(b"IEND") == 4
    target = Path(__file__).with_name("icone.ico")
    target.write_bytes(data)
    print(target, len(data), "bytes")
