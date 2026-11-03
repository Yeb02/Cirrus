/**
 * A 2D texture, clamped at its edges: an 8-bit RGBA image (the MSDF atlas, sampled linearly, as it was decoded: no
 * premultiplication, no colour conversion), or RGBA32F data read texel by texel (texelFetch: nearest, no mipmaps).
 */
export class Texture2D {
  readonly texture: WebGLTexture | null;
  width = 0;
  height = 0;
  private readonly gl: WebGL2RenderingContext;

  constructor(gl: WebGL2RenderingContext, filter: 'linear' | 'nearest') {
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
   * Float data, four per texel, rows of `width` texels: the first `rows` rows are sent (texSubImage2D); a texture too
   * small is allocated anew at `width` × `height`.
   */
  setData(width: number, height: number, data: Float32Array, rows = height): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    if (width !== this.width || height > this.height) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
      this.width = width;
      this.height = height;
    }
    if (rows > 0) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, rows, gl.RGBA, gl.FLOAT, data, 0);
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
