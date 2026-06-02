import { ResizableArray, resizableArray, TypedArrayConstructor } from './common'

export type Vec3 = [number, number, number] | Float32Array

export class Vec3SoA<T extends TypedArrayConstructor> {
  y: ResizableArray<T>
  x: ResizableArray<T>
  z: ResizableArray<T>

  constructor(typeConstructor: T) {
    this.x = resizableArray(typeConstructor) as ResizableArray<T>
    this.y = resizableArray(typeConstructor) as ResizableArray<T>
    this.z = resizableArray(typeConstructor) as ResizableArray<T>
  }

  from(entity: number, array: Vec3, offset = 0) {
    this.x[entity] = array[0 + offset]
    this.y[entity] = array[1 + offset]
    this.z[entity] = array[2 + offset]
  }

  to(entity: number, array: Vec3 = [0, 0, 0], offset = 0): Vec3 {
    array[0] = this.x[entity + offset]
    array[1] = this.y[entity + offset]
    array[2] = this.z[entity + offset]
    return array
  }

  resize(newSize: number) {
    this.x.resize(newSize)
    this.y.resize(newSize)
    this.z.resize(newSize)
  }
}
