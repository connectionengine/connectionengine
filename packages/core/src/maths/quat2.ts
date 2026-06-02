import { ResizableArray, resizableArray, TypedArrayConstructor } from './common'

export type Quat2 = [number, number, number, number, number, number, number, number] | Float32Array

export class Quat2SoA<T extends TypedArrayConstructor> {
  x1: ResizableArray<T>
  y1: ResizableArray<T>
  z1: ResizableArray<T>
  w1: ResizableArray<T>
  x2: ResizableArray<T>
  y2: ResizableArray<T>
  z2: ResizableArray<T>
  w2: ResizableArray<T>

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

  from(entity: number, array: Quat2, offset = 0) {
    this.x1[entity] = array[0 + offset]
    this.y1[entity] = array[1 + offset]
    this.z1[entity] = array[2 + offset]
    this.w1[entity] = array[3 + offset]
    this.x2[entity] = array[4 + offset]
    this.y2[entity] = array[5 + offset]
    this.z2[entity] = array[6 + offset]
    this.w2[entity] = array[7 + offset]
  }

  to(entity: number, array: Quat2 = [0, 0, 0, 0, 0, 0, 0, 0], offset = 0): Quat2 {
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
