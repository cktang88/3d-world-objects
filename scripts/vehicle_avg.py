"""Average colours of the vehicle GLBs' embedded textures (mid/far LODs), so the game can draw a model's
instanced mid/far LODs without decoding any image (src/nyc/vehicleFleet.ts: the textures of those LODs are
only ever reduced to an average colour, and image decoding is what made the cars appear a minute late while
the city loaded). Same reduction as textureAverage(): a 16x16 thumbnail, the brighter half of its pixels.

    python3 scripts/vehicle_avg.py      -> public/assets/vehicles/avg.json
"""
import io, json, os, struct, sys
from PIL import Image

D = os.path.join(os.path.dirname(__file__), '..', 'public', 'assets', 'vehicles')
out = {}
for f in sorted(os.listdir(D)):
    if not (f.endswith('_lod1.glb') or f.endswith('_lod2.glb')):
        continue
    b = open(os.path.join(D, f), 'rb').read()
    jl = struct.unpack('<I', b[12:16])[0]
    j = json.loads(b[20:20 + jl])
    bin_off = 20 + jl + 8
    avgs = []
    for im in j.get('images', []):
        bv = j['bufferViews'][im['bufferView']]
        data = b[bin_off + bv.get('byteOffset', 0): bin_off + bv.get('byteOffset', 0) + bv['byteLength']]
        img = Image.open(io.BytesIO(data)).convert('RGB').resize((16, 16), Image.BILINEAR)
        px = [(r, g, bb, r * 0.3 + g * 0.59 + bb * 0.11) for (r, g, bb) in img.getdata()]
        px.sort(key=lambda p: -p[3])
        top = px[: max(1, len(px) // 2)]
        avgs.append([round(sum(p[k] for p in top) / len(top) / 255, 4) for k in range(3)])
    out[f[:-4]] = avgs
json.dump(out, open(os.path.join(D, 'avg.json'), 'w'), separators=(',', ':'))
print(len(out), 'files,', sum(len(v) for v in out.values()), 'images')
