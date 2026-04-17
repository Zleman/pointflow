export function mkShader(gl: WebGL2RenderingContext, type: GLenum, src: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("GLSL: unable to create shader");
  }
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`GLSL: ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}

export function mkProgram(gl: WebGL2RenderingContext, vertexSrc: string, fragmentSrc: string): WebGLProgram {
  const program = gl.createProgram();
  if (!program) {
    throw new Error("GLSL link: unable to create program");
  }
  gl.attachShader(program, mkShader(gl, gl.VERTEX_SHADER, vertexSrc));
  gl.attachShader(program, mkShader(gl, gl.FRAGMENT_SHADER, fragmentSrc));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`GLSL link: ${gl.getProgramInfoLog(program)}`);
  }
  return program;
}
