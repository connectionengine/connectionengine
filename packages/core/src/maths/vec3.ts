import { ResizableArray, resizableArray, TypedArrayConstructor } from './common'

export interface Vec3View {
  x: number
  y: number
  z: number
}

/** Mutable array shape. The `to()` write targets and the snapshot serialisers
 *  use it. */
export type Vec3Tuple = [number, number, number] | Float32Array

/**
 * Canonical read shape for a Vec3 SoA field. `getComponent` returns this view.
 * The math API also accepts an array or a typed array for a write, through
 * `from()` and through the value parameter of `setComponent`.
 */
export type Vec3 = Vec3View

export class Vec3SoA<T extends TypedArrayConstructor> {
  y: ResizableArray<T>
  x: ResizableArray<T>
  z: ResizableArray<T>

  #views: Record<number, Vec3View> = {}

  constructor(typeConstructor: T) {
    this.x = resizableArray(typeConstructor) as ResizableArray<T>
    this.y = resizableArray(typeConstructor) as ResizableArray<T>
    this.z = resizableArray(typeConstructor) as ResizableArray<T>
  }

  from(entity: number, array: ArrayLike<number>, offset = 0) {
    this.x[entity] = array[0 + offset]
    this.y[entity] = array[1 + offset]
    this.z[entity] = array[2 + offset]
  }

  to(entity: number, array: Vec3Tuple = [0, 0, 0], offset = 0): Vec3Tuple {
    array[0 + offset] = this.x[entity]
    array[1 + offset] = this.y[entity]
    array[2 + offset] = this.z[entity]
    return array
  }

  /**
   * Return a stable per-entity view object. Its `.x`, `.y`, and `.z` accessors
   * read and write the underlying SoA arrays directly. The view is cached per
   * entity, so every call returns the same object reference.
   */
  view(entity: number): Vec3View {
    let v = this.#views[entity]
    if (v) return v
    v = Object.defineProperties({} as Vec3View, {
      x: {
        get: () => this.x[entity],
        set: (n: number) => {
          this.x[entity] = n
        },
        enumerable: true
      },
      y: {
        get: () => this.y[entity],
        set: (n: number) => {
          this.y[entity] = n
        },
        enumerable: true
      },
      z: {
        get: () => this.z[entity],
        set: (n: number) => {
          this.z[entity] = n
        },
        enumerable: true
      }
    }) as Vec3View
    this.#views[entity] = v
    return v
  }

  resize(newSize: number) {
    this.x.resize(newSize)
    this.y.resize(newSize)
    this.z.resize(newSize)
  }
}
