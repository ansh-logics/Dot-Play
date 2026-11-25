// One-off tool for the GTA-mode drive: writes low-poly versions of the Poly Haven models
// next to them (<name>.lod.json). The drive loads these instead of the full meshes, which
// are made for close-up renders (a 61k-triangle road barrier repeated every 1.6 m).
//
//   node scripts/drive-simplify-models.mjs
//
// Uses three's SimplifyModifier (keeps uvs and normals). Small meshes are left alone.
import * as THREE from "three"
import { SimplifyModifier } from "three/examples/jsm/modifiers/SimplifyModifier.js"
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js"
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "../public/drive/models")
/** Target triangle count per mesh (meshes already below it are kept as they are). */
const TARGETS = { street_lamp_01: 1800, concrete_road_barrier: 600, shrub_02: 99999 }

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }
const ARRAYS = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array }

for (const [name, target] of Object.entries(TARGETS)) {
  const dir = path.join(ROOT, name)
  const file = path.join(dir, `${name}.gltf`)
  if (!fs.existsSync(file)) continue
  const g = JSON.parse(fs.readFileSync(file, "utf8"))
  const bin = fs.readFileSync(path.join(dir, g.buffers[0].uri))
  const read = (i) => {
    const a = g.accessors[i]
    const v = g.bufferViews[a.bufferView]
    const T = ARRAYS[a.componentType]
    const start = bin.byteOffset + (v.byteOffset ?? 0) + (a.byteOffset ?? 0)
    return new T(bin.buffer.slice(start, start + a.count * COMPONENTS[a.type] * T.BYTES_PER_ELEMENT))
  }
  const out = []
  for (const mesh of g.meshes)
    for (const p of mesh.primitives) {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute("position", new THREE.BufferAttribute(read(p.attributes.POSITION), 3))
      if (p.attributes.NORMAL !== undefined) geo.setAttribute("normal", new THREE.BufferAttribute(read(p.attributes.NORMAL), 3))
      if (p.attributes.TEXCOORD_0 !== undefined) geo.setAttribute("uv", new THREE.BufferAttribute(read(p.attributes.TEXCOORD_0), 2))
      geo.setIndex(new THREE.BufferAttribute(read(p.indices), 1))
      const tris = geo.index.count / 3
      const verts = geo.attributes.position.count
      if (tris <= target) continue
      const merged = mergeVertices(geo)
      const keepRatio = target / tris
      const remove = Math.floor(merged.attributes.position.count * (1 - keepRatio))
      const s = new SimplifyModifier().modify(merged, remove)
      const enc = (arr) => Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString("base64")
      out.push({
        // How the loader recognises the original mesh.
        match: { tris, verts },
        position: enc(new Float32Array(s.attributes.position.array)),
        normal: s.attributes.normal ? enc(new Float32Array(s.attributes.normal.array)) : null,
        uv: s.attributes.uv ? enc(new Float32Array(s.attributes.uv.array)) : null,
        index: s.index ? enc(new Uint32Array(s.index.array)) : null,
      })
      console.log(`${name}/${mesh.name}: ${tris} → ${(s.index ? s.index.count : s.attributes.position.count) / 3} triangles`)
    }
  if (out.length) fs.writeFileSync(path.join(dir, `${name}.lod.json`), JSON.stringify(out))
}
