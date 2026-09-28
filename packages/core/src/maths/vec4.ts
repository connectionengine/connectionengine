import { ResizableArray, resizableArray, TypedArrayConstructor } from './common'

export interface Vec4View {
  x: number
  y: number
  z: number
  w: number
}

export type Vec4Tuple = [number, number, number, number] | Float32Array
export type Vec4 = Vec4View

export class Vec4SoA<T extends TypedArrayConstructor> {
  x: ResizableArray<T>
  y: ResizableArray<T>
  z: ResizableArray<T>
  w: ResizableArray<T>

  #views: Record<number, Vec4View> = {}

  constructor(typeConstructor: T) {
    this.x = resizableArray(typeConstructor) as ResizableArray<T>
    this.y = resizableArray(typeConstructor) as ResizableArray<T>
    this.z = resizableArray(typeConstructor) as ResizableArray<T>
    this.w = resizableArray(typeConstructor) as ResizableArray<T>
  }

  from(entity: number, array: ArrayLike<number>, offset = 0) {
    this.x[entity] = array[0 + offset]
    this.y[entity] = array[1 + offset]
    this.z[entity] = array[2 + offset]
    this.w[entity] = array[3 + offset]
  }

  to(entity: number, array: Vec4Tuple = [0, 0, 0, 0], offset = 0): Vec4Tuple {
    array[0 + offset] = this.x[entity]
    array[1 + offset] = this.y[entity]
    array[2 + offset] = this.z[entity]
    array[3 + offset] = this.w[entity]
    return array
  }

  view(entity: number): Vec4View {
    let v = this.#views[entity]
    if (v) return v
    v = Object.defineProperties({} as Vec4View, {
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
      },
      w: {
        get: () => this.w[entity],
        set: (n: number) => {
          this.w[entity] = n
        },
        enumerable: true
      }
    }) as Vec4View
    this.#views[entity] = v
    return v
  }

  resize(newSize: number) {
    this.x.resize(newSize)
    this.y.resize(newSize)
    this.z.resize(newSize)
    this.w.resize(newSize)
  }
}
