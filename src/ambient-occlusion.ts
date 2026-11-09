import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';

/** Guard r170's AO math: roundoff outside [-1,1] otherwise poisons denoise/bloom with NaNs. */
export function stabilizeGtao(pass: GTAOPass) {
  pass.gtaoMaterial.fragmentShader = pass.gtaoMaterial.fragmentShader.replace(
    'vec2 sinHorizons = sqrt(1. - cosHorizons * cosHorizons);',
    'cosHorizons = clamp(cosHorizons, vec2(-1.0), vec2(1.0));\nvec2 sinHorizons = sqrt(max(vec2(0.0), 1. - cosHorizons * cosHorizons));',
  );
  // Depth reconstruction samples two neighbours even at screen edges. texelFetch outside
  // the texture is undefined, unlike the clamped sampler used for regular depth reads.
  for (const material of [pass.gtaoMaterial, pass.pdMaterial]) {
    material.fragmentShader = material.fragmentShader.replace(
      'float fetchDepth(const ivec2 uv) {',
      'float fetchDepth(const ivec2 coord) {\n ivec2 uv = clamp(coord, ivec2(0), textureSize(tDepth, 0) - 1);',
    );
    material.needsUpdate = true;
  }
}
