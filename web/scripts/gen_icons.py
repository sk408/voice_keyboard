"""Generate PWA icons: dark rounded square with a microphone glyph."""
from PIL import Image, ImageDraw

BG = (26, 29, 41, 255)      # #1a1d29
ACCENT = (79, 140, 255, 255)  # #4f8cff
FG = (232, 234, 242, 255)   # #e8eaf2


def rounded_mask(size: int, radius: int) -> Image:
    m = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def draw_icon(size: int, maskable: bool, path: str) -> None:
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Background tile (full-bleed for maskable, rounded otherwise).
    if maskable:
        d.rectangle([0, 0, size, size], fill=BG)
    else:
        tile = Image.new('RGBA', (size, size), BG)
        tile.putalpha(rounded_mask(size, int(size * 0.22)))
        img.alpha_composite(tile)

    # Microphone glyph, centered in the safe zone (~80% for maskable).
    s = size * (0.72 if maskable else 1.0)
    off = (size - s) / 2
    cx = size / 2
    head_w, head_h = s * 0.22, s * 0.34
    head_top = off + s * 0.14
    # Mic head (capsule)
    d.rounded_rectangle(
        [cx - head_w / 2, head_top, cx + head_w / 2, head_top + head_h],
        radius=head_w / 2,
        fill=FG,
    )
    # Cradle arc
    arc_w = s * 0.40
    arc_top = head_top + head_h * 0.35
    d.arc(
        [cx - arc_w / 2, arc_top, cx + arc_w / 2, arc_top + s * 0.42],
        start=0,
        end=180,
        fill=ACCENT,
        width=max(2, int(s * 0.045)),
    )
    # Stem and base
    stem_top = arc_top + s * 0.42
    d.line([cx, stem_top, cx, stem_top + s * 0.10], fill=ACCENT, width=max(2, int(s * 0.045)))
    d.line(
        [cx - s * 0.12, stem_top + s * 0.10, cx + s * 0.12, stem_top + s * 0.10],
        fill=ACCENT,
        width=max(2, int(s * 0.045)),
    )

    img.save(path)


draw_icon(192, False, 'public/icons/icon-192.png')
draw_icon(512, False, 'public/icons/icon-512.png')
draw_icon(512, True, 'public/icons/icon-512-maskable.png')
print('icons written')
