#!/usr/bin/env python3
"""Generate the .3dcp project-file icons from the app logo (build/icon.png).

Run from the repo root:  python scripts/generate-file-icons.py
Needs Pillow:            pip install pillow

Output
  build/appx/FileIcon3dcp*.png           Microsoft Store (APPX/MSIX) .3dcp file-type icon assets
"""
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
LOGO = os.path.join(ROOT, 'build', 'icon.png')
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
SS = 4  # supersampling factor


def render(size):
    """Draw one file icon at `size` px: a document page carrying the logo."""
    S = size * SS
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))

    # Page geometry (portrait page, centred, a little margin for the shadow).
    mx = S * 0.13
    top, bot = S * 0.05, S * 0.95
    left, right = mx, S - mx
    fold = (right - left) * 0.30
    r = S * 0.05

    page = [(left, top), (right - fold, top), (right, top + fold), (right, bot), (left, bot)]

    # Drop shadow.
    sh = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(sh).polygon([(x + S * 0.012, y + S * 0.02) for x, y in page], fill=(0, 0, 0, 90))
    sh = sh.filter(ImageFilter.GaussianBlur(S * 0.018))
    img.alpha_composite(sh)

    # Page body with a soft vertical gradient, clipped to the page outline
    # (rounded corners except the folded one).
    mask = Image.new('L', (S, S), 0)
    md = ImageDraw.Draw(mask)
    md.polygon(page, fill=255)
    # round the three square corners by erasing and re-adding quarter discs
    for cx, cy, sx, sy in [(left, top, 1, 1), (left, bot, 1, -1), (right, bot, -1, -1)]:
        md.rectangle([min(cx, cx + sx * r), min(cy, cy + sy * r), max(cx, cx + sx * r), max(cy, cy + sy * r)], fill=0)
        md.pieslice([cx if sx > 0 else cx - 2 * r, cy if sy > 0 else cy - 2 * r,
                     cx + 2 * r if sx > 0 else cx, cy + 2 * r if sy > 0 else cy],
                    {(1, 1): 180, (1, -1): 90, (-1, -1): 0}[(sx, sy)],
                    {(1, 1): 270, (1, -1): 180, (-1, -1): 90}[(sx, sy)], fill=255)
    grad = Image.new('RGBA', (S, S))
    gd = ImageDraw.Draw(grad)
    for y in range(S):
        t = max(0.0, min(1.0, (y - top) / (bot - top)))
        c = int(255 - 22 * t)
        gd.line([(0, y), (S, y)], fill=(c, c, min(255, c + 3), 255))
    body = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    body.paste(grad, (0, 0), mask)
    img.alpha_composite(body)

    # Folded corner.
    d = ImageDraw.Draw(img)
    d.polygon([(right - fold, top), (right, top + fold), (right - fold, top + fold)], fill=(222, 224, 230, 255))
    d.line([(right - fold, top), (right - fold, top + fold), (right, top + fold)], fill=(190, 193, 202, 255), width=max(1, int(S * 0.006)))
    # Hairline page border, taken from the page mask so rounded corners stay clean.
    bw = max(1, int(S * 0.006)) * 2 + 1
    inner = mask.filter(ImageFilter.MinFilter(bw if bw % 2 else bw + 1))
    edge = Image.new('L', (S, S), 0)
    edge.paste(mask, (0, 0))
    edge = Image.eval(Image.composite(Image.new('L', (S, S), 0), mask, inner), lambda v: v)
    outline = Image.new('RGBA', (S, S), (170, 174, 184, 255))
    ol = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ol.paste(outline, (0, 0), edge)
    img.alpha_composite(ol)

    # Logo.
    logo = Image.open(LOGO).convert('RGBA')
    small = size <= 32
    show_label = size >= 48
    box_w = (right - left) * (0.86 if small else 0.74)
    scale = box_w / logo.width
    lw = int(logo.width * scale)
    lh = int(logo.height * scale)
    logo = logo.resize((lw, lh), Image.LANCZOS)
    cx = (left + right) / 2
    if show_label:
        cy = top + (bot - top) * 0.46
    else:
        cy = top + (bot - top) * 0.54
    img.alpha_composite(logo, (int(cx - lw / 2), int(cy - lh / 2)))

    # ".3DCP" label ribbon (only where it stays legible).
    if show_label:
        rh = (bot - top) * 0.15
        ry1 = bot - (bot - top) * 0.07
        ry0 = ry1 - rh
        rx0, rx1 = left + (right - left) * 0.10, right - (right - left) * 0.10
        rib = Image.new('RGBA', (S, S), (0, 0, 0, 0))
        rd = ImageDraw.Draw(rib)
        # horizontal brand gradient (orange -> pink) taken from the logo palette
        for x in range(int(rx0), int(rx1)):
            t = (x - rx0) / (rx1 - rx0)
            col = (int(250 - 12 * t), int(100 - 30 * t), int(60 + 70 * t), 255)
            rd.line([(x, ry0), (x, ry1)], fill=col)
        rmask = Image.new('L', (S, S), 0)
        ImageDraw.Draw(rmask).rounded_rectangle([rx0, ry0, rx1, ry1], radius=rh * 0.28, fill=255)
        ribbon = Image.new('RGBA', (S, S), (0, 0, 0, 0))
        ribbon.paste(rib, (0, 0), rmask)
        img.alpha_composite(ribbon)
        font = ImageFont.truetype(FONT, int(rh * 0.62))
        text = '.3DCP'
        d = ImageDraw.Draw(img)
        tb = d.textbbox((0, 0), text, font=font)
        tw, th = tb[2] - tb[0], tb[3] - tb[1]
        d.text(((rx0 + rx1) / 2 - tw / 2 - tb[0], (ry0 + ry1) / 2 - th / 2 - tb[1]), text, font=font, fill=(255, 255, 255, 255))

    return img.resize((size, size), Image.LANCZOS)


def main():
    appx = os.path.join(ROOT, 'build', 'appx')
    # Default asset + targetsize variants (plain + unplated, matching the
    # Square44x44Logo set already in build/appx).
    render(256).save(os.path.join(appx, 'FileIcon3dcp.png'))
    for s in [16, 24, 32, 48, 256]:
        im = render(s)
        for alt in ('', '_altform-unplated', '_altform-lightunplated'):
            im.save(os.path.join(appx, f'FileIcon3dcp.targetsize-{s}{alt}.png'))
    print('done')


if __name__ == '__main__':
    main()
