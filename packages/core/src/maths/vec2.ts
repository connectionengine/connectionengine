import { ResizableArray, resizableArray, TypedArrayConstructor } from './common'

export type Vec2 = [number, number] | Float32Array

export class Vec2SoA<T extends TypedArrayConstructor> {
  x: ResizableArray<T>
  y: ResizableArray<T>

  constructor(typeConstructor: T) {
    this.x = resizableArray(typeConstructor) as ResizableArray<T>
    this.y = resizableArray(typeConstructor) as ResizableArray<T>
  }

  from(entity: number, array: Vec2, offset = 0) {
    this.x[entity] = array[0 + offset]
    this.y[entity] = array[1 + offset]
  }

  to(entity: number, array: Vec2 = [0, 0], offset = 0): Vec2 {
    array[0 + offset] = this.x[entity]
    array[1 + offset] = this.y[entity]
    return array
  }

  resize(newSize: number) {
    this.x.resize(newSize)
    this.y.resize(newSize)
  }
}
