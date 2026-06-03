import { ResizableArray, resizableArray, TypedArrayConstructor } from './common'

export interface Vec2View {
  x: number
  y: number
}

export type Vec2Tuple = [number, number] | Float32Array
export type Vec2 = Vec2View

export class Vec2SoA<T extends TypedArrayConstructor> {
  x: ResizableArray<T>
  y: ResizableArray<T>

  #views: Record<number, Vec2View> = {}

  constructor(typeConstructor: T) {
    this.x = resizableArray(typeConstructor) as ResizableArray<T>
    this.y = resizableArray(typeConstructor) as ResizableArray<T>
  }

  from(entity: number, array: ArrayLike<number>, offset = 0) {
    this.x[entity] = array[0 + offset]
    this.y[entity] = array[1 + offset]
  }

  to(entity: number, array: Vec2Tuple = [0, 0], offset = 0): Vec2Tuple {
    array[0 + offset] = this.x[entity]
    array[1 + offset] = this.y[entity]
    return array
  }

  view(entity: number): Vec2View {
    let v = this.#views[entity]
    if (v) return v
    v = Object.defineProperties({} as Vec2View, {
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
      }
    }) as Vec2View
    this.#views[entity] = v
    return v
  }

  resize(newSize: number) {
    this.x.resize(newSize)
    this.y.resize(newSize)
  }
}
