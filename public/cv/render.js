/**
 * Desenha quadros I420 (8 bits) num <canvas>. WebGL faz a conversão YUV→RGB na GPU;
 * sem WebGL, cai numa conversão em JavaScript (mais lenta, mas funciona em qualquer lugar).
 */

const VERT = `
attribute vec2 p;
varying vec2 t;
void main(){ gl_Position = vec4(p, 0.0, 1.0); t = vec2((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5); }`;

const FRAG = `
precision mediump float;
uniform sampler2D Y, U, V;
uniform vec4 m;            // m.x: Cr→R, m.y: Cb→G, m.z: Cr→G, m.w: Cb→B
varying vec2 t;
void main(){
  float y = (texture2D(Y, t).r - 0.0627451) * 1.164384;
  float u = texture2D(U, t).r - 0.5019608;
  float v = texture2D(V, t).r - 0.5019608;
  gl_FragColor = vec4(y + m.x * v, y - m.y * u - m.z * v, y + m.w * u, 1.0);
}`;

// Faixa limitada (16–235). 709 para HD, 601 para SD (é o que os navegadores fazem quando o arquivo não diz).
const MATRIX = {
  '709': [1.792741, 0.213249, 0.532909, 2.112402],
  '601': [1.596027, 0.391762, 0.812968, 2.017232]
};

export class YuvRenderer {
  /** @param {HTMLCanvasElement} canvas @param {{matrix?: '709'|'601'}} opts */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.matrix = MATRIX[opts.matrix] ? opts.matrix : '709';
    this.w = 0;
    this.h = 0;
    this.cw = 0;
    this.ch = 0;
    this.last = null;
    this.gl = null;
    this.ctx2d = null;
    this.image = null;
    this.lost = false;
    this.mode = this._initGL() ? 'webgl' : this._init2D();
    this._onLost = (e) => { e.preventDefault(); this.lost = true; };
    this._onRestored = () => {
      this.lost = false;
      this.w = this.h = 0;
      if (this._initGL() && this.last) this.draw(this.last);
    };
    canvas.addEventListener('webglcontextlost', this._onLost);
    canvas.addEventListener('webglcontextrestored', this._onRestored);
  }

  _initGL() {
    let gl = null;
    try {
      gl = this.canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true, desynchronized: true })
        || this.canvas.getContext('experimental-webgl');
    } catch (e) { gl = null; }
    if (!gl) return false;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
      return s;
    };
    try {
      const prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link');
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      this.tex = ['Y', 'U', 'V'].map((name, i) => {
        const tex = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.uniform1i(gl.getUniformLocation(prog, name), i);
        return tex;
      });
      this.mLoc = gl.getUniformLocation(prog, 'm');
      this.gl = gl;
      this._applyMatrix();
      return true;
    } catch (e) {
      this.gl = null;
      return false;
    }
  }

  _init2D() {
    this.ctx2d = this.canvas.getContext('2d', { alpha: false });
    return '2d';
  }

  _applyMatrix() {
    if (this.gl) this.gl.uniform4fv(this.mLoc, MATRIX[this.matrix]);
  }

  setMatrix(name) {
    if (!MATRIX[name] || name === this.matrix) return;
    this.matrix = name;
    this._applyMatrix();
    if (this.last) this.draw(this.last);
  }

  draw(f) {
    this.last = f;
    if (this.lost) return;
    if (this.gl) return this._drawGL(f);
    return this._draw2D(f);
  }

  _drawGL(f) {
    const gl = this.gl;
    const resized = f.w !== this.w || f.h !== this.h || f.cw !== this.cw || f.ch !== this.ch;
    if (resized) {
      this.w = f.w; this.h = f.h; this.cw = f.cw; this.ch = f.ch;
      this.canvas.width = f.w;
      this.canvas.height = f.h;
      gl.viewport(0, 0, f.w, f.h);
    }
    const planes = [[f.y, f.w, f.h], [f.u, f.cw, f.ch], [f.v, f.cw, f.ch]];
    for (let i = 0; i < 3; i++) {
      const [data, w, h] = planes[i];
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, this.tex[i]);
      if (resized) gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, w, h, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, data);
      else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.LUMINANCE, gl.UNSIGNED_BYTE, data);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  _draw2D(f) {
    if (f.w !== this.w || f.h !== this.h) {
      this.w = f.w; this.h = f.h;
      this.canvas.width = f.w;
      this.canvas.height = f.h;
      this.image = this.ctx2d.createImageData(f.w, f.h);
    }
    const [m0, m1, m2, m3] = MATRIX[this.matrix];
    const out = this.image.data;
    const { y, u, v, w, h, cw } = f;
    let o = 0;
    for (let j = 0; j < h; j++) {
      const yr = j * w;
      const cr = (j >> 1) * cw;
      for (let i = 0; i < w; i++) {
        const yy = (y[yr + i] - 16) * 1.164384;
        const uu = u[cr + (i >> 1)] - 128;
        const vv = v[cr + (i >> 1)] - 128;
        const r = yy + m0 * vv;
        const g = yy - m1 * uu - m2 * vv;
        const b = yy + m3 * uu;
        out[o++] = r < 0 ? 0 : r > 255 ? 255 : r;
        out[o++] = g < 0 ? 0 : g > 255 ? 255 : g;
        out[o++] = b < 0 ? 0 : b > 255 ? 255 : b;
        out[o++] = 255;
      }
    }
    this.ctx2d.putImageData(this.image, 0, 0);
  }

  dispose() {
    this.canvas.removeEventListener('webglcontextlost', this._onLost);
    this.canvas.removeEventListener('webglcontextrestored', this._onRestored);
    if (this.gl) {
      try { const ext = this.gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); } catch (e) { /* ignore */ }
    }
    this.gl = null;
    this.last = null;
  }
}
