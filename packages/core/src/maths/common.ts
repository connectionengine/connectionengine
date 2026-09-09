export type TypedArray =
  | Uint8Array
  | Int8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array

export type TypedArrayConstructor =
  | Uint8ArrayConstructor
  | Int8ArrayConstructor
  | Uint8ClampedArrayConstructor
  | Int16ArrayConstructor
  | Uint16ArrayConstructor
  | Int32ArrayConstructor
  | Uint32ArrayConstructor
  | Float32ArrayConstructor
  | Float64ArrayConstructor

const MAX_ENTITIES = Math.pow(2, 20) // 1,048,576 entities

export function resizableArray<T extends TypedArrayConstructor>(TypeConstructor: T): ResizableArray<T> {
  const elementSize = TypeConstructor.BYTES_PER_ELEMENT
  // @ts-ignore - maxByteLength not included in TS definitions
  const arrayBuffer = new ArrayBuffer(0, { maxByteLength: MAX_ENTITIES * elementSize })
  const array = new TypeConstructor(arrayBuffer)

  // @ts-ignore
  array.resize = (newSize: number) => {
    const needed = newSize * elementSize
    if (arrayBuffer.byteLength < needed) {
      // @ts-ignore
      arrayBuffer.resize(needed)
    }
  }

  return array as ResizableArray<T>
}

export type ResizableArray<T extends TypedArrayConstructor> = InstanceType<T> & {
  resize: (newSize: number) => void
}
