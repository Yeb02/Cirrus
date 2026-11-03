/** Growable Float32Array: a rebuild refills the same storage instead of allocating per element. */
export class FloatList {
  private data: Float32Array;
  private n = 0;

  constructor(initial = 1024) {
    this.data = new Float32Array(Math.max(4, initial));
  }

  private reserve(extra: number): void {
    if (this.n + extra <= this.data.length) return;
    let cap = this.data.length * 2;
    while (cap < this.n + extra) cap *= 2;
    const next = new Float32Array(cap);
    next.set(this.data.subarray(0, this.n));
    this.data = next;
  }

  push(...v: number[]): void {
    this.reserve(v.length);
    for (const x of v) this.data[this.n++] = x;
  }

  push1(a: number): void {
    this.reserve(1);
    this.data[this.n++] = a;
  }

  push2(a: number, b: number): void {
    this.reserve(2);
    this.data[this.n++] = a;
    this.data[this.n++] = b;
  }

  push3(a: number, b: number, c: number): void {
    this.reserve(3);
    this.data[this.n++] = a;
    this.data[this.n++] = b;
    this.data[this.n++] = c;
  }

  /** Lengthens the list by `count` floats and returns where they start, to be written in `storage` (hot loops). */
  extend(count: number): number {
    this.reserve(count);
    const at = this.n;
    this.n += count;
    return at;
  }

  /** The whole storage, valid until the list grows again. */
  get storage(): Float32Array {
    return this.data;
  }

  get length(): number {
    return this.n;
  }

  /** The filled part (a view on the storage: copy it before the next clear if it must survive). */
  view(): Float32Array {
    return this.data.subarray(0, this.n);
  }

  clear(): void {
    this.n = 0;
  }
}

export class IndexList {
  private data: Uint32Array;
  private n = 0;

  constructor(initial = 1024) {
    this.data = new Uint32Array(Math.max(4, initial));
  }

  push(...v: number[]): void {
    if (this.n + v.length > this.data.length) {
      let cap = this.data.length * 2;
      while (cap < this.n + v.length) cap *= 2;
      const next = new Uint32Array(cap);
      next.set(this.data.subarray(0, this.n));
      this.data = next;
    }
    for (const x of v) this.data[this.n++] = x;
  }

  get length(): number {
    return this.n;
  }

  view(): Uint32Array {
    return this.data.subarray(0, this.n);
  }

  clear(): void {
    this.n = 0;
  }
}
