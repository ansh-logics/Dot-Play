import * as THREE from "three"

/**
 * Aerial perspective: height-based exponential haze with a warm glow towards the sun.
 * Replaces three's linear fog on every material, so distant hills soften into the sky's
 * horizon colour instead of turning into a dark wall. The density thins with altitude
 * (low valleys hazier than ridgelines), and each colour channel fades at its own rate, so
 * distance reads slightly blue-ish, the way real air looks.
 * Method after Íñigo Quílez, "Better fog": https://iquilezles.org/articles/fog/
 */
export const HAZE = {
  uHazeDensity: { value: 0.0005 },
  /** How fast the haze thins with height (1/m). */
  uHazeFalloff: { value: 0.004 },
  uHazeSunDir: { value: new THREE.Vector3(0, 0.2, 1).normalize() },
  uHazeSunColor: { value: new THREE.Color(1, 0.8, 0.6) },
  /** Per-channel extinction: red fades first, blue last. */
  uHazeTint: { value: new THREE.Vector3(1.0, 0.9, 0.78) },
}

export const HAZE_PARS = /* glsl */ `
uniform float uHazeDensity;
uniform float uHazeFalloff;
uniform vec3 uHazeSunDir;
uniform vec3 uHazeSunColor;
uniform vec3 uHazeTint;
`

/** Mixes gl_FragColor towards the haze. Needs `fogColor` (scene fog) and a world position. */
export const hazeApply = (worldPos: string) => /* glsl */ `
#ifdef USE_FOG
{
  vec3 hzRay = ${worldPos} - cameraPosition;
  float hzDist = length(hzRay);
  vec3 hzDir = hzRay / max(hzDist, 1e-4);
  float hzRy = abs(hzDir.y) < 1e-4 ? 1e-4 : hzDir.y;
  float hzB = uHazeFalloff;
  float hzAmount = (uHazeDensity / hzB) * exp(-max(cameraPosition.y, 0.0) * hzB) * (1.0 - exp(-hzDist * hzRy * hzB)) / hzRy;
  hzAmount = max(hzAmount, 0.0);
  vec3 hzExt = 1.0 - exp(-hzAmount * uHazeTint);
  float hzSun = pow(max(dot(hzDir, uHazeSunDir), 0.0), 8.0);
  vec3 hzCol = mix(fogColor, uHazeSunColor, hzSun * 0.6);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, hzCol, hzExt);
}
#endif
`

const VERT_WORLD = /* glsl */ `
#include <fog_vertex>
{
  vec4 hzW = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    hzW = instanceMatrix * hzW;
  #endif
  vHazeWorld = (modelMatrix * hzW).xyz;
}
`

/**
 * Adds the haze to a built-in material (MeshStandard/Physical/Lambert…), keeping any
 * onBeforeCompile it already has. Safe to call more than once.
 */
export function hazeMaterial(mat: THREE.Material) {
  // Keyed by uuid: material.clone() copies userData but not onBeforeCompile.
  if (mat.userData.hazed === mat.uuid || mat instanceof THREE.ShaderMaterial) return
  mat.userData.hazed = mat.uuid
  const prev = mat.onBeforeCompile
  // Evaluate the existing key now: three's default key is the callback's source text,
  // which after wrapping would be the same for every material.
  const baseKey = mat.customProgramCacheKey()
  mat.onBeforeCompile = (shader, renderer) => {
    prev.call(mat, shader, renderer)
    Object.assign(shader.uniforms, HAZE)
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vHazeWorld;")
      .replace("#include <fog_vertex>", VERT_WORLD)
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vHazeWorld;\n${HAZE_PARS}`)
      .replace("#include <fog_fragment>", hazeApply("vHazeWorld"))
  }
  mat.customProgramCacheKey = () => `${baseKey}|haze`
  mat.needsUpdate = true
}

/** Applies the haze to every material under an object (new chunks, a loaded car…). */
export function hazeObject(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material
    if (!m) return
    for (const mat of Array.isArray(m) ? m : [m]) hazeMaterial(mat)
  })
}
