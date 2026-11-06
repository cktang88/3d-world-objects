"""
Bake a tangent-space normal map from a high-poly GLB onto its simplified LOD (Blender/Cycles,
selected-to-active), and write the LOD back out with a second UV set ("bake", TEXCOORD_1) and the map
wired as every material's normalTexture (texCoord 1). Detail lost by simplification (panel lines,
rounded bevels, rim spokes) comes back in shading.

  nice -n 19 <venv>/bin/python scripts/bake_normals.py hi.glb lo.glb out.glb out_normal.png \
      [--size 1024] [--extrusion 0.02] [--ray 0.06] [--margin 0.004] [--samples 4]

hi and lo must be in the same frame (same scene transforms). Distances are in the GLB's units
(metres): --extrusion is the cage push along the low normals (just above the largest gap between
the low and high surfaces), --ray caps the search so rays do not hit the far side of thin parts.
The low's own UVs (TEXCOORD_0, base colour) are kept; the bake gets its own non-overlapping
Smart-UV-Project atlas so mirrored/overlapping/tiled UVs of the source do not break it.
Logs timestamped progress to stdout. One car (15k low / 100k high, 1024 px) takes ~1-3 min on CPU.
"""
import sys, time, math, argparse

T0 = time.time()


def log(*a):
    print(f"[bake +{time.time() - T0:5.1f}s]", *a, flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('hi'); ap.add_argument('lo'); ap.add_argument('out'); ap.add_argument('png')
    ap.add_argument('--size', type=int, default=1024)
    ap.add_argument('--extrusion', type=float, default=0.02)
    ap.add_argument('--ray', type=float, default=0.06)
    ap.add_argument('--margin', type=float, default=0.004)
    ap.add_argument('--samples', type=int, default=4)
    ap.add_argument('--angle', type=float, default=66.0, help='Smart UV Project angle limit (deg)')
    a = ap.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:])

    import bpy
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene

    def import_join(path, name):
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=path, merge_vertices=True)  # merged: UV islands follow the surface, not single faces
        objs = [o for o in bpy.data.objects if o not in before and o.type == 'MESH']
        bpy.ops.object.select_all(action='DESELECT')
        for o in objs:
            o.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        # bake world transforms into the vertices (keeps hi and lo in the same frame) and join
        bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        if len(objs) > 1:
            bpy.ops.object.join()
        o = bpy.context.view_layer.objects.active
        o.name = name
        for e in [x for x in bpy.data.objects if x.type != 'MESH']:
            bpy.data.objects.remove(e)
        return o

    # the low first, so its materials keep their exact names (the high's become "NAME.001")
    lo = import_join(a.lo, 'LO')
    log('lo', len(lo.data.polygons), 'faces,', len(lo.data.materials), 'materials')
    hi = import_join(a.hi, 'HI')
    log('hi', len(hi.data.polygons), 'faces')

    # bake atlas: a fresh UV set on the low, unwrapped and packed without overlaps
    me = lo.data
    uv = me.uv_layers.new(name='bake')
    me.uv_layers.active = uv
    bpy.ops.object.select_all(action='DESELECT')
    lo.select_set(True)
    bpy.context.view_layer.objects.active = lo
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    nv = len(me.vertices)
    # one surface for unwrapping: crease/material splits would otherwise make every face its own island
    bpy.ops.mesh.remove_doubles(threshold=1e-5, use_sharp_edge_from_normals=True)
    bpy.ops.object.mode_set(mode='OBJECT')
    log('welded', nv, '->', len(me.vertices), 'verts')
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(a.angle), island_margin=a.margin, area_weight=0.0, scale_to_bounds=True)
    bpy.ops.object.mode_set(mode='OBJECT')
    log('unwrapped')

    img = bpy.data.images.new('bake_normal', a.size, a.size, alpha=False, float_buffer=False)
    img.colorspace_settings.name = 'Non-Color'
    img.generated_color = (0.5, 0.5, 1.0, 1.0)
    # every low material gets the image as the active (bake target) node
    for m in me.materials:
        if m is None:
            continue
        m.use_nodes = True
        nt = m.node_tree
        tex = nt.nodes.new('ShaderNodeTexImage')
        tex.image = img
        tex.interpolation = 'Linear'
        uvn = nt.nodes.new('ShaderNodeUVMap')
        uvn.uv_map = 'bake'
        nt.links.new(uvn.outputs['UV'], tex.inputs['Vector'])
        for n in nt.nodes:
            n.select = False
        tex.select = True
        nt.nodes.active = tex

    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = a.samples
    sc.render.threads_mode = 'FIXED'
    sc.render.threads = 2
    bk = sc.render.bake
    bk.use_selected_to_active = True
    bk.cage_extrusion = a.extrusion
    bk.max_ray_distance = a.ray
    bk.margin = 8
    bk.normal_space = 'TANGENT'
    bpy.ops.object.select_all(action='DESELECT')
    hi.select_set(True)
    lo.select_set(True)
    bpy.context.view_layer.objects.active = lo
    log('baking', a.size, 'px, extrusion', a.extrusion, 'ray', a.ray)
    bpy.ops.object.bake(type='NORMAL', use_selected_to_active=True, cage_extrusion=a.extrusion, max_ray_distance=a.ray, normal_space='TANGENT', margin=8)
    img.filepath_raw = a.png
    img.file_format = 'PNG'
    img.save()
    log('baked ->', a.png)

    # wire the map: Normal Map node (tangent space, bake UVs) into each Principled BSDF
    for m in me.materials:
        if m is None:
            continue
        nt = m.node_tree
        tex = nt.nodes.active
        bsdf = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
        if bsdf is None:
            continue
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nm.space = 'TANGENT'
        nm.uv_map = 'bake'
        nt.links.new(tex.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])

    bpy.data.objects.remove(hi)
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.export_scene.gltf(
        filepath=a.out, export_format='GLB', use_selection=False, export_tangents=True, export_normals=True,
        export_texcoords=True, export_materials='EXPORT', export_image_format='AUTO', export_apply=False,
        export_yup=True, export_extras=False,
    )
    log('exported', a.out)


main()
