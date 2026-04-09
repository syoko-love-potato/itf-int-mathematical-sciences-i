const glCanvas = document.getElementById('glCanvas');
const overlayCanvas = document.getElementById('overlayCanvas');
const simSurface = document.getElementById('simSurface');
const unsupportedMessage = document.getElementById('unsupportedMessage');

const modeValue = document.getElementById('modeValue');
const statusValue = document.getElementById('statusValue');
const gridValue = document.getElementById('gridValue');
const ruleValue = document.getElementById('ruleValue');

const toggleRunButton = document.getElementById('toggleRunButton');
const stepButton = document.getElementById('stepButton');
const resetButton = document.getElementById('resetButton');
const showArrowsCheckbox = document.getElementById('showArrowsCheckbox');
const modeButtons = Array.from(document.querySelectorAll('.mode-button'));

const MODE_LABELS = {
  dye: '染料',
  velocity: '速度',
  divergence: '発散',
  pressure: '圧力',
};

const MODE_RULES = {
  dye:
    '染料は <code>x \leftarrow x - u\,\Delta t</code> のように，その場所の速度で少し前の位置から運ばれます．局所的な速度の集まりが，全体の模様を動かします．',
  velocity:
    '各格子点に速度ベクトル <code>u(i,j)</code> を持たせています．矢印はその局所情報を粗い格子で抜き出したものです．',
  divergence:
    '発散は近傍との差分で <code>\mathrm{div}\,u \approx \tfrac{1}{2}\{(u_{i+1,j}-u_{i-1,j}) + (v_{i,j+1}-v_{i,j-1})\}</code> と近似しています．赤は湧き出し，青は吸い込みを表します．',
  pressure:
    '圧力は近傍 4 点と発散から <code>p_{i,j} \leftarrow \tfrac{1}{4}(p_{L}+p_{R}+p_{B}+p_{T}-\mathrm{div})</code> で反復更新します．その後，速度から圧力勾配を引いて全体の整合性を高めます．',
};

const state = {
  mode: 'dye',
  running: true,
  showArrows: true,
  supported: true,
};

function updateModeUI() {
  modeValue.textContent = MODE_LABELS[state.mode];
  ruleValue.innerHTML = MODE_RULES[state.mode];
  for (const button of modeButtons) {
    button.classList.toggle('is-active', button.dataset.mode === state.mode);
  }
}

function updateStatusUI() {
  statusValue.textContent = state.running ? '実行中' : '一時停止中';
  toggleRunButton.textContent = state.running ? '一時停止' : '再開';
}

updateModeUI();
updateStatusUI();

function supportRenderTextureFormat(gl, internalFormat, format, type) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);

  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(framebuffer);
  gl.deleteTexture(texture);
  return ok;
}

function isWebGL2Context(gl) {
  return typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
}

function getSupportedFormat(gl, internalFormat, format, type) {
  if (!supportRenderTextureFormat(gl, internalFormat, format, type)) {
    if (!isWebGL2Context(gl)) return null;

    switch (internalFormat) {
      case gl.R16F:
        return getSupportedFormat(gl, gl.RG16F, gl.RG, type);
      case gl.RG16F:
        return getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, type);
      default:
        return null;
    }
  }

  return { internalFormat, format };
}

function getSimulationContext(canvas) {
  const params = {
    alpha: true,
    depth: false,
    stencil: false,
    antialias: false,
    preserveDrawingBuffer: false,
  };

  let gl = canvas.getContext('webgl2', params);
  const isWebGL2 = !!gl;

  if (!gl) {
    gl = canvas.getContext('webgl', params) || canvas.getContext('experimental-webgl', params);
  }
  if (!gl) return null;

  let halfFloat = null;
  let supportLinearFiltering = null;

  if (isWebGL2) {
    gl.getExtension('EXT_color_buffer_float');
    supportLinearFiltering = gl.getExtension('OES_texture_float_linear');
  } else {
    halfFloat = gl.getExtension('OES_texture_half_float');
    supportLinearFiltering = gl.getExtension('OES_texture_half_float_linear');
    if (!halfFloat) return null;
  }

  gl.clearColor(0.0, 0.0, 0.0, 1.0);

  const halfFloatTexType = isWebGL2 ? gl.HALF_FLOAT : halfFloat.HALF_FLOAT_OES;

  const formatRGBA = isWebGL2
    ? getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, halfFloatTexType)
    : getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);

  if (!formatRGBA) return null;

  return {
    gl,
    isWebGL2,
    floatTexType: halfFloatTexType,
    floatColorFormat: formatRGBA,
    byteColorFormat: isWebGL2
      ? { internalFormat: gl.RGBA8, format: gl.RGBA }
      : { internalFormat: gl.RGBA, format: gl.RGBA },
    supportLinearFiltering: !!supportLinearFiltering,
  };
}

const contextInfo = getSimulationContext(glCanvas);

if (!contextInfo) {
  state.supported = false;
  unsupportedMessage.hidden = false;
  throw new Error('必要な WebGL 機能が利用できません。');
}

const gl = contextInfo.gl;
const isWebGL2 = contextInfo.isWebGL2;
const floatTexType = contextInfo.floatTexType;
const floatColorFormat = contextInfo.floatColorFormat;
const byteColorFormat = contextInfo.byteColorFormat;

gl.disable(gl.BLEND);
gl.disable(gl.DEPTH_TEST);

const overlayCtx = overlayCanvas.getContext('2d');

const quadBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
gl.bufferData(
  gl.ARRAY_BUFFER,
  new Float32Array([
    -1, -1,
     1, -1,
    -1,  1,
    -1,  1,
     1, -1,
     1,  1,
  ]),
  gl.STATIC_DRAW
);

const SIM_CONFIG = {
  pressureIterations: 18,
  velocityDissipation: 0.995,
  dyeDissipation: 0.998,
  advectScale: 1.0,
  splatRadius: 0.0018,
  forceScale: 0.42,
  densityAmount: 0.6,
  overlayEncodeScale: 72.0,
};

let sim = null;
let lastTime = 0;
let resizeRequested = true;
let overlayReadback = null;
let overlayRefreshTicker = 0;
let arrowsAvailable = true;

const resizeObserver = new ResizeObserver(() => {
  resizeRequested = true;
});
resizeObserver.observe(simSurface);
window.addEventListener('resize', () => {
  resizeRequested = true;
});

function makeVertexSource() {
  if (isWebGL2) {
    return `#version 300 es
precision highp float;
in vec2 aPosition;
out vec2 vUv;
void main() {
  vUv = 0.5 * (aPosition + 1.0);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;
  }

  return `
precision highp float;
attribute vec2 aPosition;
varying vec2 vUv;
void main() {
  vUv = 0.5 * (aPosition + 1.0);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;
}

function makeFragmentSource(body) {
  if (isWebGL2) {
    return `#version 300 es
precision highp float;
precision mediump sampler2D;
in vec2 vUv;
out vec4 fragColor;
${body
      .replaceAll('SAMPLE(', 'texture(')
      .replaceAll('FRAG_COLOR', 'fragColor')}`;
  }

  return `
precision highp float;
precision mediump sampler2D;
varying vec2 vUv;
${body
    .replaceAll('SAMPLE(', 'texture2D(')
    .replaceAll('FRAG_COLOR', 'gl_FragColor')}`;
}

const baseVertexShaderSource = makeVertexSource();

function compileShader(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(log || 'シェーダのコンパイルに失敗しました。');
  }
  return shader;
}

function createProgram(fragmentBody, uniformNames) {
  const vertexShader = compileShader(gl.VERTEX_SHADER, baseVertexShaderSource);
  const fragmentShader = compileShader(gl.FRAGMENT_SHADER, makeFragmentSource(fragmentBody));
  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(log || 'プログラムのリンクに失敗しました。');
  }
  const uniforms = {};
  for (const name of uniformNames) {
    uniforms[name] = gl.getUniformLocation(program, name);
  }
  return {
    program,
    uniforms,
    aPosition: gl.getAttribLocation(program, 'aPosition'),
  };
}

const programs = {
  splat: createProgram(
    `
uniform sampler2D uTarget;
uniform vec2 uPoint;
uniform vec4 uValue;
uniform float uRadius;
uniform float uAspect;
void main() {
  vec2 delta = vUv - uPoint;
  delta.x *= uAspect;
  float gaussian = exp(-dot(delta, delta) / uRadius);
  FRAG_COLOR = SAMPLE(uTarget, vUv) + uValue * gaussian;
}`,
    ['uTarget', 'uPoint', 'uValue', 'uRadius', 'uAspect']
  ),

  advect: createProgram(
    `
uniform sampler2D uSource;
uniform sampler2D uVelocity;
uniform vec2 uTexel;
uniform float uDtScale;
uniform float uDissipation;

vec4 sampleBilinear(sampler2D tex, vec2 uv) {
  uv = clamp(uv, 0.5 * uTexel, vec2(1.0) - 0.5 * uTexel);
  vec2 size = 1.0 / uTexel;
  vec2 coord = uv * size - 0.5;
  vec2 index = floor(coord);
  vec2 fracPart = fract(coord);
  vec2 base = (index + 0.5) * uTexel;
  vec2 texel = uTexel;

  vec4 a = SAMPLE(tex, base);
  vec4 b = SAMPLE(tex, clamp(base + vec2(texel.x, 0.0), 0.5 * uTexel, vec2(1.0) - 0.5 * uTexel));
  vec4 c = SAMPLE(tex, clamp(base + vec2(0.0, texel.y), 0.5 * uTexel, vec2(1.0) - 0.5 * uTexel));
  vec4 d = SAMPLE(tex, clamp(base + texel, 0.5 * uTexel, vec2(1.0) - 0.5 * uTexel));

  return mix(mix(a, b, fracPart.x), mix(c, d, fracPart.x), fracPart.y);
}

void main() {
  vec2 velocity = SAMPLE(uVelocity, vUv).xy;
  vec2 prevUv = vUv - uDtScale * velocity;
  vec4 value = sampleBilinear(uSource, prevUv) * uDissipation;
  value.a = 1.0;
  FRAG_COLOR = value;
}`,
    ['uSource', 'uVelocity', 'uTexel', 'uDtScale', 'uDissipation']
  ),

  divergence: createProgram(
    `
uniform sampler2D uVelocity;
uniform vec2 uTexel;

vec2 fetchVelocity(vec2 uv) {
  return SAMPLE(uVelocity, clamp(uv, 0.5 * uTexel, vec2(1.0) - 0.5 * uTexel)).xy;
}

void main() {
  vec2 velL = fetchVelocity(vUv - vec2(uTexel.x, 0.0));
  vec2 velR = fetchVelocity(vUv + vec2(uTexel.x, 0.0));
  vec2 velB = fetchVelocity(vUv - vec2(0.0, uTexel.y));
  vec2 velT = fetchVelocity(vUv + vec2(0.0, uTexel.y));

  float div = 0.5 * ((velR.x - velL.x) + (velT.y - velB.y));
  FRAG_COLOR = vec4(div, 0.0, 0.0, 1.0);
}`,
    ['uVelocity', 'uTexel']
  ),

  pressure: createProgram(
    `
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
uniform vec2 uTexel;

float fetchPressure(vec2 uv) {
  return SAMPLE(uPressure, clamp(uv, 0.5 * uTexel, vec2(1.0) - 0.5 * uTexel)).x;
}

void main() {
  float pL = fetchPressure(vUv - vec2(uTexel.x, 0.0));
  float pR = fetchPressure(vUv + vec2(uTexel.x, 0.0));
  float pB = fetchPressure(vUv - vec2(0.0, uTexel.y));
  float pT = fetchPressure(vUv + vec2(0.0, uTexel.y));
  float div = SAMPLE(uDivergence, vUv).x;

  float pressure = 0.25 * (pL + pR + pB + pT - div);
  FRAG_COLOR = vec4(pressure, 0.0, 0.0, 1.0);
}`,
    ['uPressure', 'uDivergence', 'uTexel']
  ),

  gradientSubtract: createProgram(
    `
uniform sampler2D uVelocity;
uniform sampler2D uPressure;
uniform vec2 uTexel;

float fetchPressure(vec2 uv) {
  return SAMPLE(uPressure, clamp(uv, 0.5 * uTexel, vec2(1.0) - 0.5 * uTexel)).x;
}

void main() {
  float pL = fetchPressure(vUv - vec2(uTexel.x, 0.0));
  float pR = fetchPressure(vUv + vec2(uTexel.x, 0.0));
  float pB = fetchPressure(vUv - vec2(0.0, uTexel.y));
  float pT = fetchPressure(vUv + vec2(0.0, uTexel.y));
  vec2 velocity = SAMPLE(uVelocity, vUv).xy;
  velocity -= 0.5 * vec2(pR - pL, pT - pB);
  FRAG_COLOR = vec4(velocity, 0.0, 1.0);
}`,
    ['uVelocity', 'uPressure', 'uTexel']
  ),

  display: createProgram(
    `
uniform sampler2D uDye;
uniform sampler2D uDivergence;
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
uniform int uMode;

vec3 signedColor(float value) {
  float amount = 1.0 - exp(-abs(value) * 100.0);
  amount = pow(amount, 0.8);
  vec3 positive = vec3(0.88, 0.26, 0.26);
  vec3 negative = vec3(0.24, 0.35, 0.88);
  vec3 target = value >= 0.0 ? positive : negative;
  return mix(vec3(1.0), target, amount);
}

vec3 pressureColor(float value) {
  float t = 0.5 + 0.5 * (2.0 / 3.14159265) * atan(50.0 * value);
  float gray = mix(0.08, 0.98, 1.0 - t);
  return vec3(gray);
}

vec3 velocityColor(vec2 velocity) {
  float speed = length(velocity);
  if (speed < 0.0004) return vec3(0.96);
  float angle = atan(velocity.y, velocity.x);
  vec3 hue = 0.55 + 0.35 * cos(angle + vec3(0.0, 2.0943951, 4.1887902));
  float amount = 1.0 - exp(-speed * 100.0);
  return mix(vec3(0.96), hue, amount);
}

void main() {
  if (uMode == 0) {
    float dye = clamp(SAMPLE(uDye, vUv).x, 0.0, 1.0);
    vec3 background = vec3(1.0, 1.0, 1.0);
    vec3 ink = vec3(0.0, 0.68, 0.92);
    FRAG_COLOR = vec4(mix(background, ink, dye), 1.0);
  } else if (uMode == 1) {
    vec2 velocity = SAMPLE(uVelocity, vUv).xy;
    FRAG_COLOR = vec4(velocityColor(velocity), 1.0);
  } else if (uMode == 2) {
    float div = SAMPLE(uDivergence, vUv).x;
    FRAG_COLOR = vec4(signedColor(div), 1.0);
  } else {
    float pressure = SAMPLE(uPressure, vUv).x;
    FRAG_COLOR = vec4(pressureColor(pressure), 1.0);
  }
}`,
    ['uDye', 'uDivergence', 'uPressure', 'uVelocity', 'uMode']
  ),

  velocityEncode: createProgram(
    `
uniform sampler2D uVelocity;
uniform float uScale;
void main() {
  vec2 v = clamp(SAMPLE(uVelocity, vUv).xy * uScale, vec2(-1.0), vec2(1.0));
  FRAG_COLOR = vec4(v * 0.5 + 0.5, 0.0, 1.0);
}`,
    ['uVelocity', 'uScale']
  ),
};

function createTexture(width, height, formatDesc, type) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    formatDesc.internalFormat,
    width,
    height,
    0,
    formatDesc.format,
    type,
    null
  );
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}

function createFBO(width, height, kind = 'float') {
  const formatDesc = kind === 'float' ? floatColorFormat : byteColorFormat;
  const type = kind === 'float' ? floatTexType : gl.UNSIGNED_BYTE;
  const texture = createTexture(width, height, formatDesc, type);
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error('フレームバッファを作成できませんでした。');
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return {
    texture,
    framebuffer,
    width,
    height,
  };
}

function createDoubleFBO(width, height) {
  const a = createFBO(width, height, 'float');
  const b = createFBO(width, height, 'float');
  return {
    read: a,
    write: b,
    swap() {
      [this.read, this.write] = [this.write, this.read];
    },
  };
}

function disposeFBO(target) {
  if (!target) return;
  gl.deleteTexture(target.texture);
  gl.deleteFramebuffer(target.framebuffer);
}

function disposeDoubleFBO(target) {
  if (!target) return;
  disposeFBO(target.read);
  disposeFBO(target.write);
}

function makeSimulation(width, height) {
  return {
    width,
    height,
    texel: [1 / width, 1 / height],
    aspect: width / height,
    velocity: createDoubleFBO(width, height),
    dye: createDoubleFBO(width, height),
    pressure: createDoubleFBO(width, height),
    divergence: createFBO(width, height, 'float'),
    overlayPack: createFBO(width, height, 'byte'),
  };
}

function clearTarget(target, r = 0, g = 0, b = 0, a = 1) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
  gl.viewport(0, 0, target.width, target.height);
  gl.clearColor(r, g, b, a);
  gl.clear(gl.COLOR_BUFFER_BIT);
}

function clearSimulation() {
  clearTarget(sim.velocity.read, 0, 0, 0, 1);
  clearTarget(sim.velocity.write, 0, 0, 0, 1);
  clearTarget(sim.dye.read, 0, 0, 0, 1);
  clearTarget(sim.dye.write, 0, 0, 0, 1);
  clearTarget(sim.pressure.read, 0, 0, 0, 1);
  clearTarget(sim.pressure.write, 0, 0, 0, 1);
  clearTarget(sim.divergence, 0, 0, 0, 1);
  clearTarget(sim.overlayPack, 127 / 255, 127 / 255, 0, 1);
}

function bindTexture(texture, unit) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
}

function drawFullscreen(program, target, setupUniforms) {
  gl.useProgram(program.program);
  gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.framebuffer : null);
  gl.viewport(0, 0, target ? target.width : glCanvas.width, target ? target.height : glCanvas.height);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.enableVertexAttribArray(program.aPosition);
  gl.vertexAttribPointer(program.aPosition, 2, gl.FLOAT, false, 0, 0);
  if (setupUniforms) setupUniforms(program.uniforms);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function applySplat(uvX, uvY, vx, vy, density) {
  if (!sim) return;

  drawFullscreen(programs.splat, sim.velocity.write, (u) => {
    bindTexture(sim.velocity.read.texture, 0);
    gl.uniform1i(u.uTarget, 0);
    gl.uniform2f(u.uPoint, uvX, uvY);
    gl.uniform4f(u.uValue, vx, vy, 0.0, 0.0);
    gl.uniform1f(u.uRadius, SIM_CONFIG.splatRadius);
    gl.uniform1f(u.uAspect, sim.aspect);
  });
  sim.velocity.swap();

  drawFullscreen(programs.splat, sim.dye.write, (u) => {
    bindTexture(sim.dye.read.texture, 0);
    gl.uniform1i(u.uTarget, 0);
    gl.uniform2f(u.uPoint, uvX, uvY);
    gl.uniform4f(u.uValue, density, density, density, 0.0);
    gl.uniform1f(u.uRadius, SIM_CONFIG.splatRadius * 1.15);
    gl.uniform1f(u.uAspect, sim.aspect);
  });
  sim.dye.swap();
}

function computeDivergence() {
  drawFullscreen(programs.divergence, sim.divergence, (u) => {
    bindTexture(sim.velocity.read.texture, 0);
    gl.uniform1i(u.uVelocity, 0);
    gl.uniform2f(u.uTexel, sim.texel[0], sim.texel[1]);
  });
}

function solvePressure() {
  clearTarget(sim.pressure.read, 0, 0, 0, 1);
  clearTarget(sim.pressure.write, 0, 0, 0, 1);

  for (let i = 0; i < SIM_CONFIG.pressureIterations; i += 1) {
    drawFullscreen(programs.pressure, sim.pressure.write, (u) => {
      bindTexture(sim.pressure.read.texture, 0);
      bindTexture(sim.divergence.texture, 1);
      gl.uniform1i(u.uPressure, 0);
      gl.uniform1i(u.uDivergence, 1);
      gl.uniform2f(u.uTexel, sim.texel[0], sim.texel[1]);
    });
    sim.pressure.swap();
  }
}

function subtractPressureGradient() {
  drawFullscreen(programs.gradientSubtract, sim.velocity.write, (u) => {
    bindTexture(sim.velocity.read.texture, 0);
    bindTexture(sim.pressure.read.texture, 1);
    gl.uniform1i(u.uVelocity, 0);
    gl.uniform1i(u.uPressure, 1);
    gl.uniform2f(u.uTexel, sim.texel[0], sim.texel[1]);
  });
  sim.velocity.swap();
}

function advectField(source, velocity, target, dtScale, dissipation) {
  drawFullscreen(programs.advect, target.write, (u) => {
    bindTexture(source.read.texture, 0);
    bindTexture(velocity.read.texture, 1);
    gl.uniform1i(u.uSource, 0);
    gl.uniform1i(u.uVelocity, 1);
    gl.uniform2f(u.uTexel, sim.texel[0], sim.texel[1]);
    gl.uniform1f(u.uDtScale, dtScale);
    gl.uniform1f(u.uDissipation, dissipation);
  });
  target.swap();
}

function stepSimulation(dtSeconds) {
  if (!sim) return;
  const dtScale = Math.min(0.035, dtSeconds) * 60 * SIM_CONFIG.advectScale;

  advectField(sim.velocity, sim.velocity, sim.velocity, dtScale, SIM_CONFIG.velocityDissipation);
  computeDivergence();
  solvePressure();
  subtractPressureGradient();
  computeDivergence();
  advectField(sim.dye, sim.velocity, sim.dye, dtScale, SIM_CONFIG.dyeDissipation);
}

function renderDisplay() {
  const displayMode = state.mode === 'dye' ? 0 : state.mode === 'velocity' ? 1 : state.mode === 'divergence' ? 2 : 3;
  drawFullscreen(programs.display, null, (u) => {
    bindTexture(sim.dye.read.texture, 0);
    bindTexture(sim.divergence.texture, 1);
    bindTexture(sim.pressure.read.texture, 2);
    bindTexture(sim.velocity.read.texture, 3);
    gl.uniform1i(u.uDye, 0);
    gl.uniform1i(u.uDivergence, 1);
    gl.uniform1i(u.uPressure, 2);
    gl.uniform1i(u.uVelocity, 3);
    gl.uniform1i(u.uMode, displayMode);
  });
}

function ensureCanvasSizes() {
  const rect = simSurface.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.max(1, Math.round(rect.width * dpr));
  const pixelHeight = Math.max(1, Math.round(rect.height * dpr));

  if (glCanvas.width !== pixelWidth || glCanvas.height !== pixelHeight) {
    glCanvas.width = pixelWidth;
    glCanvas.height = pixelHeight;
    overlayCanvas.width = pixelWidth;
    overlayCanvas.height = pixelHeight;
  }

  return rect;
}

function chooseSimulationResolution(cssWidth, cssHeight) {
  const aspect = cssWidth / Math.max(cssHeight, 1);
  const longSide = cssWidth < 560 ? 176 : 224;
  let width;
  let height;
  if (aspect >= 1) {
    width = longSide;
    height = Math.round(longSide / aspect);
  } else {
    height = longSide;
    width = Math.round(longSide * aspect);
  }
  width = Math.max(72, width);
  height = Math.max(72, height);
  return { width, height };
}

function destroySimulation() {
  if (!sim) return;
  disposeDoubleFBO(sim.velocity);
  disposeDoubleFBO(sim.dye);
  disposeDoubleFBO(sim.pressure);
  disposeFBO(sim.divergence);
  disposeFBO(sim.overlayPack);
  sim = null;
}

function seedDemoState() {
  if (!sim) return;
  const splats = [
    [0.32, 0.62, 0.20, -1.0, 0.85],
    [0.68, 0.44, -0.18, 1.4, 0.75],
    [0.50, 0.72, 0.000, -2.0, 0.65],
  ];
  for (const [x, y, vx, vy, density] of splats) {
    applySplat(x, y, vx, vy, density);
  }
  for (let i = 0; i < 24; i += 1) {
    stepSimulation(1 / 60);
  }
}

function resetSimulation() {
  if (!sim) return;
  clearSimulation();
  seedDemoState();
  overlayRefreshTicker = 0;
}

function rebuildSimulationIfNeeded() {
  if (!resizeRequested) return;
  resizeRequested = false;

  const rect = ensureCanvasSizes();
  const desired = chooseSimulationResolution(rect.width, rect.height);
  if (!sim || sim.width !== desired.width || sim.height !== desired.height) {
    destroySimulation();
    sim = makeSimulation(desired.width, desired.height);
    gridValue.textContent = `${sim.width} × ${sim.height}`;
    resetSimulation();
  }
}

function drawArrow(ctx, x, y, dx, dy) {
  const x2 = x + dx;
  const y2 = y + dy;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  const angle = Math.atan2(dy, dx);
  const head = 4.5;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 7), y2 - head * Math.sin(angle - Math.PI / 7));
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 7), y2 - head * Math.sin(angle + Math.PI / 7));
  ctx.stroke();
}

function updateOverlay() {
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  const shouldShowArrows = state.mode === 'velocity' || state.showArrows;
  if (!sim || !shouldShowArrows || !arrowsAvailable) return;

  if (!overlayReadback || overlayReadback.length !== sim.width * sim.height * 4) {
    overlayReadback = new Uint8Array(sim.width * sim.height * 4);
  }

  overlayRefreshTicker = (overlayRefreshTicker + 1) % 2;
  if (overlayRefreshTicker === 0) {
    drawFullscreen(programs.velocityEncode, sim.overlayPack, (u) => {
      bindTexture(sim.velocity.read.texture, 0);
      gl.uniform1i(u.uVelocity, 0);
      gl.uniform1f(u.uScale, SIM_CONFIG.overlayEncodeScale);
    });

    gl.bindFramebuffer(gl.FRAMEBUFFER, sim.overlayPack.framebuffer);
    gl.readPixels(0, 0, sim.width, sim.height, gl.RGBA, gl.UNSIGNED_BYTE, overlayReadback);
    const err = gl.getError();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (err !== gl.NO_ERROR) {
      arrowsAvailable = false;
      showArrowsCheckbox.checked = false;
      state.showArrows = false;
      return;
    }
  }

  const width = overlayCanvas.width;
  const height = overlayCanvas.height;
  const columns = Math.max(10, Math.round(width / 44));
  const rows = Math.max(8, Math.round(height / 44));
  const cellWidth = width / columns;
  const cellHeight = height / rows;
  const lengthCap = 0.43 * Math.min(cellWidth, cellHeight);
  const arrowScale = 0.85 * Math.min(cellWidth, cellHeight) * SIM_CONFIG.overlayEncodeScale;

  overlayCtx.strokeStyle = 'rgba(17, 17, 17, 0.62)';
  overlayCtx.lineWidth = 1.2;
  overlayCtx.lineCap = 'round';
  overlayCtx.lineJoin = 'round';

  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < columns; i += 1) {
      const fx = (i + 0.5) / columns;
      const fyTop = (j + 0.5) / rows;
      const uvx = fx;
      const uvy = 1 - fyTop;
      const sx = Math.min(sim.width - 1, Math.max(0, Math.round(uvx * (sim.width - 1))));
      const sy = Math.min(sim.height - 1, Math.max(0, Math.round(uvy * (sim.height - 1))));
      const base = 4 * (sy * sim.width + sx);
      const vx = ((overlayReadback[base] / 255) * 2 - 1) / SIM_CONFIG.overlayEncodeScale;
      const vy = ((overlayReadback[base + 1] / 255) * 2 - 1) / SIM_CONFIG.overlayEncodeScale;
      const magnitude = Math.hypot(vx, vy);
      if (magnitude < 0.0009) continue;

      const length = Math.min(lengthCap, magnitude * arrowScale);
      const dx = (vx / magnitude) * length;
      const dy = -(vy / magnitude) * length;
      const px = fx * width;
      const py = fyTop * height;
      drawArrow(overlayCtx, px, py, dx, dy);
    }
  }
}

function animate(time) {
  rebuildSimulationIfNeeded();
  if (!sim) {
    requestAnimationFrame(animate);
    return;
  }

  const dt = lastTime === 0 ? 1 / 60 : Math.min(0.05, (time - lastTime) / 1000);
  lastTime = time;

  if (state.running) {
    stepSimulation(dt);
  }

  renderDisplay();
  updateOverlay();
  requestAnimationFrame(animate);
}

for (const button of modeButtons) {
  button.addEventListener('click', () => {
    state.mode = button.dataset.mode;
    updateModeUI();
  });
}

toggleRunButton.addEventListener('click', () => {
  state.running = !state.running;
  updateStatusUI();
});

stepButton.addEventListener('click', () => {
  if (!sim) return;
  stepSimulation(1 / 60);
  renderDisplay();
  updateOverlay();
});

resetButton.addEventListener('click', () => {
  resetSimulation();
});

showArrowsCheckbox.addEventListener('change', () => {
  state.showArrows = showArrowsCheckbox.checked;
  overlayRefreshTicker = 0;
  updateOverlay();
});

const pointerState = {
  active: false,
  x: 0,
  y: 0,
};

function pointerToUv(event) {
  const rect = glCanvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  return {
    x: Math.min(1, Math.max(0, x)),
    y: Math.min(1, Math.max(0, 1 - y)),
  };
}

glCanvas.addEventListener('pointerdown', (event) => {
  glCanvas.setPointerCapture(event.pointerId);
  const uv = pointerToUv(event);
  pointerState.active = true;
  pointerState.x = uv.x;
  pointerState.y = uv.y;
  applySplat(uv.x, uv.y, 0.0, 0.0, SIM_CONFIG.densityAmount * 0.9);
});

glCanvas.addEventListener('pointermove', (event) => {
  if (!pointerState.active) return;
  const uv = pointerToUv(event);
  const dx = uv.x - pointerState.x;
  const dy = uv.y - pointerState.y;
  pointerState.x = uv.x;
  pointerState.y = uv.y;
  const vx = Math.max(-0.04, Math.min(0.04, dx * SIM_CONFIG.forceScale));
  const vy = Math.max(-0.04, Math.min(0.04, dy * SIM_CONFIG.forceScale));
  applySplat(uv.x, uv.y, vx, vy, SIM_CONFIG.densityAmount);
});

function endPointer(event) {
  if (pointerState.active) {
    pointerState.active = false;
    glCanvas.releasePointerCapture(event.pointerId);
  }
}

glCanvas.addEventListener('pointerup', endPointer);
glCanvas.addEventListener('pointercancel', endPointer);
glCanvas.addEventListener('pointerleave', (event) => {
  if (event.buttons === 0) {
    pointerState.active = false;
  }
});

requestAnimationFrame(animate);
