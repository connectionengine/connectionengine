import { ResizableArray, resizableArray, TypedArrayConstructor } from './common'

export interface Quat2View {
  x1: number
  y1: number
  z1: number
  w1: number
  x2: number
  y2: number
  z2: number
  w2: number
}

export type Quat2Tuple = [number, number, number, number, number, number, number, number] | Float32Array
export type Quat2 = Quat2View

export class Quat2SoA<T extends TypedArrayConstructor> {
  x1: ResizableArray<T>
  y1: ResizableArray<T>
  z1: ResizableArray<T>
  w1: ResizableArray<T>
  x2: ResizableArray<T>
  y2: ResizableArray<T>
  z2: ResizableArray<T>
  w2: ResizableArray<T>

  #views: Record<number, Quat2View> = {}

  constructor(typeConstructor: T) {
    this.x1 = resizableArray(typeConstructor) as ResizableArray<T>
    this.y1 = resizableArray(typeConstructor) as ResizableArray<T>
    this.z1 = resizableArray(typeConstructor) as ResizableArray<T>
    this.w1 = resizableArray(typeConstructor) as ResizableArray<T>
    this.x2 = resizableArray(typeConstructor) as ResizableArray<T>
    this.y2 = resizableArray(typeConstructor) as ResizableArray<T>
    this.z2 = resizableArray(typeConstructor) as ResizableArray<T>
    this.w2 = resizableArray(typeConstructor) as ResizableArray<T>
  }

  from(entity: number, array: ArrayLike<number>, offset = 0) {
    this.x1[entity] = array[0 + offset]
    this.y1[entity] = array[1 + offset]
    this.z1[entity] = array[2 + offset]
    this.w1[entity] = array[3 + offset]
    this.x2[entity] = array[4 + offset]
    this.y2[entity] = array[5 + offset]
    this.z2[entity] = array[6 + offset]
    this.w2[entity] = array[7 + offset]
  }

  to(entity: number, array: Quat2Tuple = [0, 0, 0, 0, 0, 0, 0, 0], offset = 0): Quat2Tuple {
    array[0 + offset] = this.x1[entity]
    array[1 + offset] = this.y1[entity]
    array[2 + offset] = this.z1[entity]
    array[3 + offset] = this.w1[entity]
    array[4 + offset] = this.x2[entity]
    array[5 + offset] = this.y2[entity]
    array[6 + offset] = this.z2[entity]
    array[7 + offset] = this.w2[entity]
    return array
  }

  view(entity: number): Quat2View {
    let v = this.#views[entity]
    if (v) return v
    const axis = (key: 'x1' | 'y1' | 'z1' | 'w1' | 'x2' | 'y2' | 'z2' | 'w2'): PropertyDescriptor => ({
      get: () => this[key][entity],
      set: (n: number) => {
        this[key][entity] = n
      },
      enumerable: true
    })
    v = Object.defineProperties({} as Quat2View, {
      x1: axis('x1'),
      y1: axis('y1'),
      z1: axis('z1'),
      w1: axis('w1'),
      x2: axis('x2'),
      y2: axis('y2'),
      z2: axis('z2'),
      w2: axis('w2')
    }) as Quat2View
    this.#views[entity] = v
    return v
  }

  resize(newSize: number) {
    this.x1.resize(newSize)
    this.y1.resize(newSize)
    this.z1.resize(newSize)
    this.w1.resize(newSize)
    this.x2.resize(newSize)
    this.y2.resize(newSize)
    this.z2.resize(newSize)
    this.w2.resize(newSize)
  }
}
