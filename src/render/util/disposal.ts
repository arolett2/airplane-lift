/** Helpers to release GPU resources owned by three.js objects. */
import * as THREE from 'three';

/** Dispose every texture referenced by a material's properties. */
function disposeMaterial(material: THREE.Material): void {
  for (const value of Object.values(material)) {
    if (value instanceof THREE.Texture) value.dispose();
  }
  material.dispose();
}

/**
 * Dispose geometries, materials and textures of `root` and all descendants. Does not detach
 * `root` from its parent. Only call on objects whose resources are not shared elsewhere.
 */
export function disposeObject3D(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const renderable = obj as THREE.Mesh;
    if (renderable.geometry) renderable.geometry.dispose();
    const mat = renderable.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach(disposeMaterial);
    else if (mat) disposeMaterial(mat);
    if (obj instanceof THREE.InstancedMesh) obj.dispose();
  });
}

/** Remove and dispose all children of a group (keeps the group itself). */
export function clearGroup(group: THREE.Object3D): void {
  for (let i = group.children.length - 1; i >= 0; i--) {
    const child = group.children[i]!;
    group.remove(child);
    disposeObject3D(child);
  }
}
