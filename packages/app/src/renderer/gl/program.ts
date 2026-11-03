/** The program in use, per context: `set` binds its program only when another is. */
const inUse = new WeakMap<WebGL2RenderingContext, WebGLProgram | null>();

interface Uniform { loc: WebGLUniformLocation; type: number }

/** The compiler's message with the faulty lines quoted (ANGLE: "ERROR: 0:12: …"). */
function report(kind: string, name: string, source: string, log: string): Error {
  const lines = source.split('\n');
  const quoted = [...log.matchAll(/ERROR: \d+:(\d+):/g)].map((m) => `  ${m[1]} | ${lines[Number(m[1]) - 1]?.trim() ?? ''}`);
  return new Error(`Shader ${name} (${kind}) : compilation impossible.\n${log.trim()}${quoted.length > 0 ? `\n${[...new Set(quoted)].join('\n')}` : ''}`);
}

function compile(gl: WebGL2RenderingContext, type: number, source: string, name: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  // A lost context reports nothing: the restoration makes the program again.
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(sh) ?? '';
    gl.deleteShader(sh);
    throw report(type === gl.VERTEX_SHADER ? 'sommets' : 'fragments', name, source, log);
  }
  return sh;
}

/**
 * A GLSL ES 3.00 program: compiled and linked at once (a failure names the faulty line), its uniforms' locations and
 * types read once. `set` takes a number or a list of numbers and calls the uniform function of the uniform's type; a
 * uniform the compiler dropped is ignored.
 */
export class Program {
  readonly program: WebGLProgram;
  private readonly uniforms = new Map<string, Uniform>();
  private readonly gl: WebGL2RenderingContext;

  constructor(gl: WebGL2RenderingContext, name: string, vertex: string, fragment: string) {
    this.gl = gl;
    const vs = compile(gl, gl.VERTEX_SHADER, vertex, name), fs = compile(gl, gl.FRAGMENT_SHADER, fragment, name);
    const pr = gl.createProgram()!;
    gl.attachShader(pr, vs);
    gl.attachShader(pr, fs);
    gl.linkProgram(pr);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS) && !gl.isContextLost()) {
      const log = gl.getProgramInfoLog(pr) ?? '';
      gl.deleteProgram(pr);
      throw new Error(`Shader ${name} : édition des liens impossible.\n${log.trim()}`);
    }
    this.program = pr;
    const n = gl.isContextLost() ? 0 : (gl.getProgramParameter(pr, gl.ACTIVE_UNIFORMS) as number);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(pr, i);
      const loc = info && gl.getUniformLocation(pr, info.name);
      if (info && loc) this.uniforms.set(info.name.replace(/\[0\]$/, ''), { loc, type: info.type });
    }
  }

  use(): void {
    if (inUse.get(this.gl) === this.program) return;
    this.gl.useProgram(this.program);
    inUse.set(this.gl, this.program);
  }

  attribute(name: string): number {
    return this.gl.getAttribLocation(this.program, name);
  }

  set(name: string, v: number | ArrayLike<number>): void {
    const u = this.uniforms.get(name);
    if (!u) return;
    this.use();
    const gl = this.gl, a = v as Float32List;
    switch (u.type) {
      case gl.FLOAT: gl.uniform1f(u.loc, typeof v === 'number' ? v : v[0]); break;
      case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, a); break;
      case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, a); break;
      case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, a); break;
      case gl.FLOAT_MAT3: gl.uniformMatrix3fv(u.loc, false, a); break;
      default: gl.uniform1i(u.loc, typeof v === 'number' ? v : v[0]); break;
    }
  }

  dispose(): void {
    if (inUse.get(this.gl) === this.program) inUse.set(this.gl, null);
    this.gl.deleteProgram(this.program);
  }
}
