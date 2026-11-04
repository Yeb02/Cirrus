/** The WebGL calls a Texture2D makes (a recording stand-in serves the tests, without WebGL under Node). */
export type TextureGl = Pick<WebGL2RenderingContext,
  'createTexture' | 'bindTexture' | 'texParameteri' | 'pixelStorei' | 'texImage2D' | 'texSubImage2D' | 'activeTexture' | 'deleteTexture'
  | 'TEXTURE_2D' | 'TEXTURE_MIN_FILTER' | 'TEXTURE_MAG_FILTER' | 'TEXTURE_WRAP_S' | 'TEXTURE_WRAP_T' | 'CLAMP_TO_EDGE' | 'LINEAR' | 'NEAREST'
  | 'UNPACK_PREMULTIPLY_ALPHA_WEBGL' | 'UNPACK_FLIP_Y_WEBGL' | 'RGBA8' | 'RGBA' | 'UNSIGNED_BYTE' | 'RGBA32F' | 'FLOAT' | 'TEXTURE0'>;

/**
 * A 2D texture, clamped at its edges: an 8-bit RGBA image (the MSDF atlas, sampled linearly, as it was decoded: no
 * premultiplication, no colour conversion), or RGBA32F data read texel by texel (texelFetch: nearest, no mipmaps: the
 * item texture, plan 3c task 8).
 */
export class Texture2D {
  readonly texture: WebGLTexture | null;
  width = 0;
  height = 0;
  private readonly gl: TextureGl;

  constructor(gl: TextureGl, filter: 'linear' | 'nearest') {
    this.gl = gl;
    this.texture = gl.createTexture();
    const f = filter === 'linear' ? gl.LINEAR : gl.NEAREST;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** An image as it is (an ImageBitmap made with premultiplyAlpha and colorSpaceConversion 'none'). */
  setImage(image: ImageBitmap): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
    this.width = image.width;
    this.height = image.height;
  }

  /**
   * Float storage of `width` × `height` texels, made anew (contents undefined) unless it already has that size; returns
   * whether it was made, after which every row is to be sent again.
   */
  allocate(width: number, height: number): boolean {
    if (width === this.width && height === this.height) return false;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
    this.width = width;
    this.height = height;
    return true;
  }

  /** Rows [from, to) of `data` (four floats per texel, rows of `width` texels from row 0), and only those (texSubImage2D). */
  setRows(data: Float32Array, from: number, to: number): void {
    if (to <= from) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, from, this.width, to - from, gl.RGBA, gl.FLOAT, data, from * this.width * 4);
  }

  bind(unit: number): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
  }

  dispose(): void {
    this.gl.deleteTexture(this.texture);
  }
}
