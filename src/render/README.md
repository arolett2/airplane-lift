# render/

three.js views of physics outputs. Rules:

- Z-up world (`THREE.Object3D.DEFAULT_UP = (0,0,1)` is set in `SceneManager`), same axes as physics.
- Physics objects live under `SceneManager.modelRoot` in **meters**; never rescale physics data.
- Every class exposes `readonly object: THREE.Object3D`, idempotent `update*`/`set*` methods,
  and `dispose()` that frees geometries, materials and textures.
- No physics computations here, only drawing.
