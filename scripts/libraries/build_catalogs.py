#!/usr/bin/env python3
"""
Build compact catalogs of third-party 3D model libraries into public/libraries/.

    python3 scripts/libraries/build_catalogs.py [polyhaven gso smithsonian khronos]

Every catalog is {source, name, licence, home, credit, base, entries:[...]} where an entry is
    {id, t: title, c: category, tags?, lic?, by?, u: model url (relative to base), s?: [x, y, z]
     real-world size in metres (Y up), th?: thumbnail url, tri?: triangles, kb?: download size}
Smithsonian is large, so it is sharded into public/libraries/smithsonian/<category>.json with an
index listing the shards. See docs/research/libraries.md.

Stdlib only. Network goes through the machine's HTTPS proxy (urllib honours HTTPS_PROXY).
"""
import json
import os
import re
import ssl
import struct
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, 'public', 'libraries')
CA = '/root/.ccr/ca-bundle.crt'
CTX = ssl.create_default_context(cafile=CA) if os.path.exists(CA) else ssl.create_default_context()
UA = {'User-Agent': '3d-world-objects catalog builder'}


def get(url, rng=None, timeout=60):
    h = dict(UA)
    if rng:
        h['Range'] = f'bytes={rng[0]}-{rng[1]}'
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, context=CTX, timeout=timeout) as r:
        return r.read()


def get_json(url):
    return json.loads(get(url))


def write(name, data):
    p = os.path.join(OUT, name)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'w') as f:
        json.dump(data, f, separators=(',', ':'), ensure_ascii=False)
    print(f'wrote {p} ({os.path.getsize(p) // 1024} KB, {len(data.get("entries", data.get("shards", [])))} items)')


def r3(v):
    return [round(x, 3) for x in v]


# --------------------------------------------------------------------------- GLB header probe

def glb_bounds(url):
    """Size [x,y,z] of a GLB from its JSON chunk only (accessor min/max of POSITION, node scale
    and rotation ignored apart from the root's uniform scale). One small range request."""
    try:
        head = get(url, (0, 262143), timeout=40)
        magic, _ver, _len = struct.unpack_from('<III', head, 0)
        if magic != 0x46546C67:
            return None
        clen, _ctype = struct.unpack_from('<II', head, 12)
        if 20 + clen > len(head):
            head = get(url, (0, 20 + clen), timeout=60)
        g = json.loads(head[20:20 + clen])
        acc = g.get('accessors', [])
        lo = [1e30] * 3
        hi = [-1e30] * 3
        # walk nodes with translation + uniform scale (enough for scans / sample assets)
        nodes = g.get('nodes', [])
        meshes = g.get('meshes', [])

        def walk(i, s, t):
            n = nodes[i]
            sc = n.get('scale', [1, 1, 1])
            tr = n.get('translation', [0, 0, 0])
            m = n.get('matrix')
            if m:
                sc = [(m[0] ** 2 + m[1] ** 2 + m[2] ** 2) ** 0.5] * 3
                tr = m[12:15]
            nt = [t[k] + tr[k] * s for k in range(3)]
            ns = s * sum(sc) / 3
            if 'mesh' in n:
                for p in meshes[n['mesh']]['primitives']:
                    a = acc[p['attributes']['POSITION']]
                    if 'min' in a:
                        for k in range(3):
                            lo[k] = min(lo[k], nt[k] + a['min'][k] * ns)
                            hi[k] = max(hi[k], nt[k] + a['max'][k] * ns)
            for c in n.get('children', []):
                walk(c, ns, nt)

        sc = g.get('scenes', [{}])[g.get('scene', 0)]
        for i in sc.get('nodes', []):
            walk(i, 1.0, [0, 0, 0])
        if lo[0] > hi[0]:
            return None
        return r3([hi[k] - lo[k] for k in range(3)])
    except Exception as e:  # noqa
        print('  probe failed', url, e, file=sys.stderr)
        return None


# --------------------------------------------------------------------------- Poly Haven (CC0)

def polyhaven():
    d = get_json('https://api.polyhaven.com/assets?t=models')
    entries = []
    for pid, v in sorted(d.items()):
        cats = [c for c in v.get('categories', []) if not c.startswith('collection:')]
        dims = v.get('dimensions')  # millimetres, Blender axes (x, y=depth, z=up)
        s = r3([dims[0] / 1000, dims[2] / 1000, dims[1] / 1000]) if dims else None
        e = {
            'id': pid, 't': v['name'], 'c': (v.get('category') or '/'.join(cats)).split('/')[0].lower(),
            'tags': sorted(set(cats + v.get('tags', [])))[:14], 'by': ', '.join(v.get('authors', {}).keys()),
            'tri': v.get('polycount'),
        }
        if s:
            e['s'] = s
        entries.append(e)
    write('polyhaven.json', {
        'source': 'polyhaven', 'name': 'Poly Haven', 'licence': 'CC0-1.0', 'home': 'https://polyhaven.com/models',
        'credit': 'Poly Haven (CC0)', 'base': 'https://api.polyhaven.com/files/',
        'tpl': {'u': '{id}', 'th': 'https://cdn.polyhaven.com/asset_img/thumbs/{id}.png?width=256&height=256'},
        'note': 'u is the asset id: fetch base+id for the glTF file list (1k/2k/4k) at load time',
        'entries': entries})


# --------------------------------------------------------------------------- Google Scanned Objects (CC-BY 4.0)

GSO_BASE = 'https://huggingface.co/datasets/codepawl/scanned-objects-glb/resolve/main/'


def gso():
    rows = [json.loads(l) for l in get(GSO_BASE + 'metadata.jsonl').decode().splitlines() if l.strip()]
    entries = []
    for r in rows:
        tags = [x for x in [r.get('brand'), *(r.get('source_categories') or [])] if x]
        entries.append({
            'id': r['id'], 't': r['name'], 'c': r.get('category') or 'other', 'tags': tags,
            's': r3(r['size_metres']), 'tri': r.get('triangles'), 'kb': round(r.get('pack_bytes', 0) / 1024),
        })
    write('gso.json', {
        'source': 'gso', 'name': 'Google Scanned Objects', 'licence': 'CC-BY-4.0',
        'home': 'https://research.google/blog/scanned-objects-by-google-research-a-dataset-of-3d-scanned-common-household-items/',
        'credit': 'Google Scanned Objects by Google Research (CC BY 4.0), GLB conversion codepawl/scanned-objects-glb',
        'base': GSO_BASE, 'tpl': {'u': 'objects/{id}/{id}.glb', 'th': 'thumbs/{id}.webp', 'lod': 'lods/{id}/{id}_lod{n}.glb'},
        'entries': entries})


# --------------------------------------------------------------------------- Smithsonian 3D (CC0)

SI_BASE = 'https://3d-api.si.edu/content/document/'
SI_RULES = [
    ('space', r'\b(apollo|gemini|mercury|space ?suit|spacesuit|lunar|rocket|satellite|orbiter|capsule|module|space shuttle|helmet, pressure|glove, pressure|boot, lunar)\b'),
    ('aircraft', r'\b(airplane|aircraft|plane|jet|glider|wright flyer|biplane|helicopter|engine,|propeller|balloon)\b'),
    ('fossil', r'\b(fossil|dinosaur|skull|cast of|trilobite|mammoth|whale|tyrannosaurus|triceratops|stegosaurus|allosaurus)\b'),
    ('bone', r'\b(mandible|humerus|femur|radius|ulna|tibia|fibula|talus|calcaneus|cuboid|cuneiform|navicular|scaphoid|capitate|hamate|lunate|pisiform|trapezi\w*|mc\d|mt\d|metacarpal|metatarsal|cranium|vertebra|pelvis|scapula|clavicle|patella|phalan\w*|tooth|teeth|molar|hyoid|sacrum|bone|skeleton)\b'),
    ('shell', r'\b(anodonta|lampsilis|unio|elliptio|pleurobema|lasmigona|margaritana|alasmidonta|nephronaias|mycetopus|quadrula|villosa|obovaria|fusconaia|cyclonaias|epioblasma|shell|mussel|snail|conch|clam)\b'),
    ('sculpture', r'\b(sculpture|statue|bust|figure|figurine|head of|relief|carving|idol|mask|totem|torso|portrait)\b'),
    ('vessel', r'\b(vase|jar|bowl|pot|pitcher|jug|cup|beaker|bottle|ewer|urn|amphora|vessel|teapot|kettle|basin|plate|dish|flask|goblet|censer|garniture|cauldron|tureen)\b'),
    ('furniture', r'\b(chair|table|desk|cabinet|chest|bench|stool|sofa|clock|lamp|mirror|bed|cradle)\b'),
    ('instrument', r'\b(violin|guitar|drum|flute|horn|trumpet|piano|banjo|instrument|telescope|microscope|camera|telegraph|telephone|motor|machine|model of|patent)\b'),
    ('tool', r'\b(axe|knife|hammer|tool|spear|arrow|point|blade|sword|gun|rifle|pistol|cannon|harpoon|scraper|projectile)\b'),
    ('clothing', r'\b(shoe|boot|hat|dress|coat|jacket|costume|uniform|glove|helmet|cap|textile|basket)\b'),
    ('animal', r'\b(bird|fish|insect|beetle|frog|turtle|lizard|snake|crab|coral|bat|primate|gorilla|pan troglodytes|pongo|lemur|specimen)\b'),
    ('architecture', r'\b(mansion|building|interior|room|floor|house|church|temple|gate|facade|site|cave|monument|tomb)\b'),
]


UNITS = {'mm': 0.001, 'cm': 0.01, 'm': 1.0, 'km': 1000.0, 'in': 0.0254, 'ft': 0.3048, 'yd': 0.9144}
# Smithsonian unit (EDAN record prefix) -> category for everything outside natural history
SI_UNITS = [('nasm', 'air-space'), ('nmah', 'american-history'), ('nmaahc', 'african-american'), ('chndm', 'design'),
            ('npg', 'portraits'), ('saam', 'art'), ('hmsg', 'art'), ('fsg', 'asian-art'), ('nmafa', 'african-art'),
            ('nmai', 'native-american'), ('npm', 'postal'), ('nzp', 'zoo'), ('sao', 'space'), ('acm', 'american-history')]
SI_NH = {'bone', 'shell', 'fossil', 'animal'}


def si_cat(title, edan=''):
    unit = edan.split(':', 1)[-1].lower()
    t = title.lower()
    rule = next((c for c, rx in SI_RULES if re.search(rx, t)), None)
    if unit.startswith('nmnh') or not unit:
        if rule in SI_NH:
            return rule
        if re.search(r'coral|acropora|porites|fungia|favia|goniopora|astrea|astraea|madrepor|polyp', t):
            return 'coral'
        return 'specimen' if unit.startswith('nmnh') else (rule or 'other')
    for pre, c in SI_UNITS:
        if unit.startswith(pre):
            return c
    return rule or 'other'


def qrot(q, v):
    x, y, z, w = q
    vx, vy, vz = v
    cx, cy, cz = y * vz - z * vy, z * vx - x * vz, x * vy - y * vx
    cx2, cy2, cz2 = y * cz - z * cy, z * cx - x * cz, x * cy - y * cx
    return (vx + 2 * (w * cx + cx2), vy + 2 * (w * cy + cy2), vz + 2 * (w * cz + cz2))


def si_package(pid, title, max_bytes=15e6):
    """Entry for one 3D package from its Voyager document (units, orientation, parts, record id)."""
    try:
        d = json.loads(get(f'{SI_BASE}{pid}/document.json', timeout=40))
    except Exception as e:  # noqa
        print('  no document', pid, e, file=sys.stderr)
        return None
    parts = []
    lo = [1e30] * 3
    hi = [-1e30] * 3
    kb = 0
    for m in d.get('models', [])[:16]:
        ders = {(x.get('usage'), x.get('quality')): x for x in m.get('derivatives', [])}
        pick = None
        for q in ('Medium', 'Low', 'High'):
            x = ders.get(('Web3D', q))
            if x and x['assets'] and x['assets'][0].get('byteSize', 0) <= max_bytes and x['assets'][0]['uri'].endswith('.glb'):
                pick = x['assets'][0]
                break
        if not pick:
            continue
        f = UNITS.get(m.get('units', 'm'), 1.0)
        q = m.get('rotation') or [0, 0, 0, 1]
        t = m.get('translation') or [0, 0, 0]
        bb = m.get('boundingBox')
        if bb:
            for i in range(8):
                c = [bb['max'][k] if (i >> k) & 1 else bb['min'][k] for k in range(3)]
                r = qrot(q, c)
                for k in range(3):
                    lo[k] = min(lo[k], (r[k] + t[k]) * f)
                    hi[k] = max(hi[k], (r[k] + t[k]) * f)
        kb += pick.get('byteSize', 0) // 1024
        part = {'u': f'{pid}/{pick["uri"]}', 'f': f}
        if any(abs(a - b) > 1e-4 for a, b in zip(q, [0, 0, 0, 1])):
            part['q'] = [round(x, 5) for x in q]
        if any(t):
            part['t'] = [round(x, 4) for x in t]
        parts.append(part)
    if not parts:
        return None
    edan = ''
    thumb = None
    for meta in d.get('metas', []):
        edan = edan or meta.get('collection', {}).get('edanRecordId', '')
        for im in meta.get('images', []):
            if im.get('quality') == 'Thumb':
                thumb = f'{pid}/{im["uri"]}'
        title = title or meta.get('collection', {}).get('title', '')
    title = re.sub(r'<[^>]+>', '', title).strip()
    if not title:
        return None
    e = {'id': pid.split(':', 1)[1], 't': title, 'c': si_cat(title, edan), 'edan': edan or None, 'kb': kb, 'th': thumb}
    if len(parts) == 1:
        e['u'] = parts[0]['u']
        if 'q' in parts[0]:
            e['q'] = parts[0]['q']
        e['f'] = parts[0]['f']
    else:
        e['parts'] = parts
    if lo[0] < hi[0] and max(hi[k] - lo[k] for k in range(3)) > 0.005:
        e['s'] = r3([hi[k] - lo[k] for k in range(3)])
    return {k: v for k, v in e.items() if v is not None}


def smithsonian():
    rows = []
    start = 0
    while True:
        d = get_json(f'https://3d-api.si.edu/api/v1.0/content/file/search?rows=1000&start={start}')
        rows += d['rows']
        start += 1000
        print(f'  smithsonian rows {len(rows)}/{d["rowCount"]}')
        if start >= d['rowCount'] or not d['rows']:
            break
    pk = {}
    for r in rows:
        u = r['content']['model_url']
        t = (r.get('title') or '').strip()
        if t and not pk.get(u):
            pk[u] = t
        else:
            pk.setdefault(u, '')
    print(f'  smithsonian packages: {len(pk)}')
    with ThreadPoolExecutor(16) as ex:
        entries = [e for e in ex.map(lambda kv: si_package(*kv), pk.items()) if e]
    print(f'  smithsonian packages with a web GLB: {len(entries)}')
    # ~2000 primate post-cranial bones would dominate the catalog: keep skulls and skeletons only
    entries = [e for e in entries if e['c'] != 'bone' or re.search(r'cranium|skull|skeleton', e['t'], re.I)]
    entries.sort(key=lambda e: (e['c'], e['t']))
    shards = {}
    for e in entries:
        shards.setdefault(e['c'], []).append(e)
    meta = {'source': 'smithsonian', 'name': 'Smithsonian 3D (Open Access)', 'licence': 'CC0-1.0',
            'home': 'https://3d.si.edu/', 'credit': 'Smithsonian Institution, Open Access (CC0)', 'base': SI_BASE,
            'tpl': {'th': '3d_package:{id}/scene-image-thumb.jpg'},
            'note': 'u / parts[].u relative to base; f = metres per model unit; q = model rotation (x,y,z,w); '
                    't = part translation in model units; s = real size in metres after rotation; edan = EDAN record id'}
    for c, es in shards.items():
        for e in es:
            if e.get('th') == f'3d_package:{e["id"]}/scene-image-thumb.jpg':
                del e['th']
        write(f'smithsonian/{c}.json', {**meta, 'category': c, 'entries': es})
    write('smithsonian/index.json', {**meta, 'shards': [{'c': c, 'n': len(es)} for c, es in sorted(shards.items())]})


# --------------------------------------------------------------------------- Khronos glTF-Sample-Assets (per-model licence)

KH_BASE = 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/'
# realistic, real-world things (skip test/feature-demo assets)
KH_KEEP = {
    'ABeautifulGame': 'game', 'AnisotropyBarnLamp': 'lighting', 'Avocado': 'food', 'BarramundiFish': 'animal',
    'BoomBox': 'electronics', 'Corset': 'clothing', 'DamagedHelmet': 'props', 'DragonAttenuation': 'decorative',
    'FlightHelmet': 'props', 'GlamVelvetSofa': 'furniture', 'IridescenceLamp': 'lighting', 'Lantern': 'lighting',
    'MaterialsVariantsShoe': 'clothing', 'SheenChair': 'furniture', 'SheenWoodLeatherSofa': 'furniture',
    'SunglassesKhronos': 'clothing', 'ToyCar': 'toy', 'WaterBottle': 'containers', 'ChairDamaskPurplegold': 'furniture',
    'CommercialRefrigerator': 'appliances', 'GlassBrokenWindow': 'structures', 'GlassHurricaneCandleHolder': 'decorative',
    'GlassVaseFlowers': 'decorative', 'PotOfCoals': 'decorative', 'ScatteringSkull': 'decorative',
    'StainedGlassLamp': 'lighting', 'AnisotropyStrongPolishedCopper': 'containers',
    'CarConcept': 'vehicle', 'DiffuseTransmissionPlant': 'plants', 'DiffuseTransmissionTeacup': 'dishes',
    'ChronographWatch': 'props', 'Fox': 'animal', 'CesiumMan': 'people',
    'AntiqueCamera': 'props', 'MosquitoInAmber': 'decorative', 'LightsPunctualLamp': 'lighting',
}
# sample assets are not all modelled at real scale: true largest dimension in metres
KH_REAL = {
    'ABeautifulGame': 0.5, 'AntiqueCamera': 1.9, 'Avocado': 0.1, 'BoomBox': 0.6, 'CesiumMan': 1.75, 'ChronographWatch': 0.05,
    'Corset': 0.45, 'Fox': 1.0, 'Lantern': 2.4, 'MosquitoInAmber': 0.04, 'PotOfCoals': 0.35, 'ToyCar': 0.25,
}
KH_LICENCES = ('CC0-1.0', 'CC-BY-4.0')


def khronos():
    idx = get_json(KH_BASE + 'model-index.json')
    entries = []

    def one(m):
        name = m['name']
        if name not in KH_KEEP:
            return None
        v = m.get('variants', {})
        fn = v.get('glTF-Binary')
        if not fn:
            return None
        try:
            meta = get_json(f'{KH_BASE}{name}/metadata.json')
        except Exception:
            meta = {}
        legal = meta.get('legal', [])
        lics = sorted(set(l.get('spdx') or l.get('license') for l in legal if l))
        # only CC0 / CC-BY (LegalMark-* entries are trademark notices, not licences)
        if not lics or any(l not in KH_LICENCES and not (l or '').startswith('LicenseRef-LegalMark') for l in lics):
            return None
        u = f'{name}/glTF-Binary/{fn}'
        e = {'id': name, 't': m.get('label', name), 'c': KH_KEEP[name], 'tags': m.get('tags', []),
             'lic': ' AND '.join(lics) or 'see source', 'by': ', '.join(sorted(set(l.get('artist', '') for l in legal if l.get('artist')))),
             'u': u, 'th': f'{name}/{m.get("screenshot", "screenshot/screenshot.jpg")}'}
        s = glb_bounds(KH_BASE + u)
        if s and name in KH_REAL:
            s = r3([x * KH_REAL[name] / max(s) for x in s])
        if s:
            e['s'] = s
        return e

    with ThreadPoolExecutor(8) as ex:
        entries = [e for e in ex.map(one, idx) if e]
    entries.sort(key=lambda e: e['id'])
    write('khronos.json', {
        'source': 'khronos', 'name': 'Khronos glTF Sample Assets', 'licence': 'per model (CC0 / CC-BY 4.0)',
        'home': 'https://github.com/KhronosGroup/glTF-Sample-Assets', 'credit': 'Khronos glTF Sample Assets (see each model)',
        'base': KH_BASE, 'entries': entries})


if __name__ == '__main__':
    which = sys.argv[1:] or ['polyhaven', 'gso', 'khronos', 'smithsonian']
    for w in which:
        print('==', w)
        globals()[w]()
    srcs = []
    for s in ['polyhaven', 'gso', 'smithsonian', 'khronos']:
        p = os.path.join(OUT, 'smithsonian/index.json' if s == 'smithsonian' else f'{s}.json')
        if os.path.exists(p):
            d = json.load(open(p))
            n = sum(x['n'] for x in d['shards']) if 'shards' in d else len(d['entries'])
            srcs.append({'source': s, 'name': d['name'], 'licence': d['licence'], 'home': d['home'], 'count': n,
                         'file': 'smithsonian/index.json' if s == 'smithsonian' else f'{s}.json'})
    write('index.json', {'sources': srcs, 'entries': []})
