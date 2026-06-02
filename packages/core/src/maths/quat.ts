import { ResizableArray, resizableArray, TypedArrayConstructor } from './common'

export type Quat = [number, number, number, number] | Float32Array

export class QuatSoA<T extends TypedArrayConstructor> {
  x: ResizableArray<T>
  y: ResizableArray<T>
  z: ResizableArray<T>
  w: ResizableArray<T>

  constructor(typeConstructor: T) {
    this.x = resizableArray(typeConstructor) as ResizableArray<T>
    this.y = resizableArray(typeConstructor) as ResizableArray<T>
    this.z = resizableArray(typeConstructor) as ResizableArray<T>
    this.w = resizableArray(typeConstructor) as ResizableArray<T>
  }

  from(entity: number, array: Quat, offset = 0) {
    this.x[entity] = array[0 + offset]
    this.y[entity] = array[1 + offset]
    this.z[entity] = array[2 + offset]
    this.w[entity] = array[3 + offset]
  }

  to(entity: number, array: Quat = [0, 0, 0, 0], offset = 0): Quat {
    array[0 + offset] = this.x[entity]
    array[1 + offset] = this.y[entity]
    array[2 + offset] = this.z[entity]
    array[3 + offset] = this.w[entity]
    return array
  }

  resize(newSize: number) {
    this.x.resize(newSize)
    this.y.resize(newSize)
    this.z.resize(newSize)
    this.w.resize(newSize)
  }
}
