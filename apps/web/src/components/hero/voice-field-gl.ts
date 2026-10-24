/**
 * The hero's real-time "voice field": a full-screen fragment shader that draws a handful of soft,
 * flowing sound ribbons (ember and ink) over a transparent canvas. No libraries, one draw call.
 * It calms to a slow swell while the demo is idle and widens and quickens while it is "Listening",
 * leans gently towards the pointer, and adapts its own resolution (or gives up) if frames get slow.
 * Loaded lazily by voice-field.tsx; returns null when WebGL is not available.
 */

const VERT = `
attribute vec2 p;
void main(){ gl_Position = vec4(p, 0.0, 1.0); }
`;

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 uRes;
uniform float uTime;
uniform float uEnergy;
uniform vec2 uPointer;
uniform float uPointerAmt;
uniform float uDark;

float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

// Core and halo of ribbon i at this pixel.
vec2 ribbon(vec2 uv, float aspect, float i){
  float x = uv.x;
  float t = uTime;
  float k = i / 6.0;
  float base = 0.30 + (k - 0.5) * (0.15 + 0.17 * uEnergy);
  float freq = 1.4 + i * 0.42;
  float speed = 0.16 + i * 0.035 + uEnergy * 0.16;
  float env = 0.3 + 0.7 * exp(-pow((x - 0.5) * 1.7, 2.0));
  float amp = (0.016 + 0.07 * uEnergy) * (0.7 + 0.3 * sin(i * 2.3));
  float w = sin(x * freq * 3.14159 + t * speed + i * 1.9) * 0.65
          + sin(x * freq * 5.3 - t * speed * 1.4 + i * 0.7) * 0.35;
  float voice = 0.55 + 0.45 * sin(x * 8.0 - t * (0.9 + 1.8 * uEnergy) + i * 1.3);
  w *= mix(1.0, voice, uEnergy);
  float pd = exp(-pow((x - uPointer.x) * aspect * 3.2, 2.0)) * uPointerAmt;
  float y = base + w * amp * env + (uPointer.y - base) * pd * 0.09;
  float d = abs(uv.y - y) * uRes.y;
  float core = smoothstep(1.4, 0.1, d);
  float halo = exp(-d / (9.0 + 16.0 * uEnergy));
  return vec2(core, halo);
}

void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  float aspect = uRes.x / uRes.y;

  vec3 ember = mix(vec3(0.910, 0.439, 0.184), vec3(1.0, 0.541, 0.298), uDark);
  vec3 ink = mix(vec3(0.10, 0.09, 0.08), vec3(0.953, 0.937, 0.918), uDark);

  vec3 col = vec3(0.0);
  float a = 0.0;
  for (int n = 0; n < 7; n++) {
    float i = float(n);
    vec2 r = ribbon(uv, aspect, i);
    bool isEmber = mod(i, 2.0) > 0.5;
    vec3 c = isEmber ? ember : ink;
    float ac = isEmber ? 0.62 : 0.2;
    float ah = isEmber ? 0.075 : 0.025;
    float v = r.x * ac + r.y * ah;
    col += c * v;
    a += v;
  }

  // Keep the headline area calm: ribbons live in the lower part of the hero.
  float mask = smoothstep(0.56, 0.36, uv.y) * smoothstep(0.0, 0.1, uv.y);
  // Quiet at the very edges, so the section blends into the page.
  mask *= smoothstep(0.0, 0.12, uv.x) * smoothstep(1.0, 0.88, uv.x);
  col *= mask;
  a *= mask;

  // A breathing glow behind the demo window.
  float breath = 0.5 + 0.5 * sin(uTime * 0.55);
  vec2 hp = (uv - vec2(0.5, 0.28)) * vec2(aspect * 0.62, 1.0);
  float haze = exp(-dot(hp, hp) * 5.0) * (0.07 + 0.04 * breath + 0.1 * uEnergy);
  col += ember * haze;
  a += haze;

  a = clamp(a, 0.0, 0.9);
  col = min(col, vec3(a));
  float n = (hash(gl_FragCoord.xy + fract(uTime)) - 0.5) / 255.0;
  gl_FragColor = vec4(col + n * step(0.002, a), a);
}
`;

export interface VoiceFieldOptions {
  canvas: HTMLCanvasElement;
  /** 0 (idle) to 1 (listening), read every frame. */
  energy: () => number;
  /** Called once if the field stops itself (context lost, too slow). */
  onGiveUp: () => void;
}

export interface VoiceFieldHandle {
  destroy: () => void;
}

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export function startVoiceField(
  options: VoiceFieldOptions,
): VoiceFieldHandle | null {
  const { canvas } = options;
  const gl = canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "low-power",
  });
  if (!gl) return null;

  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  const program = gl.createProgram();
  if (!vs || !fs || !program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    gl.STATIC_DRAW,
  );
  const loc = gl.getAttribLocation(program, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const g: WebGLRenderingContext = gl;
  const u = (name: string) => gl.getUniformLocation(program, name);
  const uRes = u("uRes");
  const uTime = u("uTime");
  const uEnergy = u("uEnergy");
  const uPointer = u("uPointer");
  const uPointerAmt = u("uPointerAmt");
  const uDark = u("uDark");

  const root = document.documentElement;
  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
  let dark = 0;
  const readTheme = () => {
    dark = getComputedStyle(root).colorScheme.includes("dark") ? 1 : 0;
  };
  readTheme();
  const themeObserver = new MutationObserver(readTheme);
  themeObserver.observe(root, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  darkQuery.addEventListener("change", readTheme);

  // Resolution: device pixels, capped, then scaled down further if frames get slow.
  let quality = 0.75;
  let width = 0;
  let height = 0;
  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5) * quality;
    const w = Math.max(2, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(2, Math.round(canvas.clientHeight * dpr));
    if (w !== width || h !== height) {
      width = canvas.width = w;
      height = canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  };
  resize();
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);

  // Pointer, relative to the canvas, eased so ribbons lean rather than snap.
  const target = { x: 0.5, y: 0.4, amt: 0 };
  const pointer = { x: 0.5, y: 0.4, amt: 0 };
  const onPointer = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    if (r.width === 0) return;
    target.x = (e.clientX - r.left) / r.width;
    target.y = 1 - (e.clientY - r.top) / r.height;
    target.amt = e.clientY >= r.top && e.clientY <= r.bottom ? 1 : 0;
  };
  const onLeave = () => {
    target.amt = 0;
  };
  window.addEventListener("pointermove", onPointer, { passive: true });
  document.addEventListener("pointerleave", onLeave);

  let visible = true;
  const io = new IntersectionObserver(
    (entries) => {
      visible = entries.some((e) => e.isIntersecting);
      schedule();
    },
    { rootMargin: "80px 0px" },
  );
  io.observe(canvas);
  const onVisibility = () => schedule();
  document.addEventListener("visibilitychange", onVisibility);

  let frame = 0;
  let last = 0;
  let time = 0;
  let energy = 0;
  let slowFrames = 0;
  let sampled = 0;
  let stopped = false;

  const giveUp = () => {
    destroy();
    options.onGiveUp();
  };
  const onLost = (e: Event) => {
    e.preventDefault();
    giveUp();
  };
  canvas.addEventListener("webglcontextlost", onLost);

  function draw(now: number) {
    frame = 0;
    if (stopped) return;
    const dt = last ? Math.min((now - last) / 1000, 0.05) : 0.016;
    const raw = last ? now - last : 16;
    last = now;
    time += dt;

    // Adaptive quality: after a warm-up, lower the resolution once or twice, then give up.
    if (sampled++ > 20) {
      slowFrames = raw > 30 ? slowFrames + 1 : Math.max(0, slowFrames - 1);
      if (slowFrames > 40) {
        slowFrames = 0;
        if (quality > 0.4) {
          quality *= 0.65;
          resize();
        } else {
          giveUp();
          return;
        }
      }
    }

    const goal = options.energy();
    energy +=
      (goal - energy) * (1 - Math.exp(-dt * (goal > energy ? 3.2 : 1.4)));
    const k = 1 - Math.exp(-dt * 4);
    pointer.x += (target.x - pointer.x) * k;
    pointer.y += (target.y - pointer.y) * k;
    pointer.amt += (target.amt - pointer.amt) * (1 - Math.exp(-dt * 2));

    g.uniform2f(uRes, width, height);
    g.uniform1f(uTime, time);
    g.uniform1f(uEnergy, energy);
    g.uniform2f(uPointer, pointer.x, pointer.y);
    g.uniform1f(uPointerAmt, pointer.amt);
    g.uniform1f(uDark, dark);
    g.clearColor(0, 0, 0, 0);
    g.clear(g.COLOR_BUFFER_BIT);
    g.drawArrays(g.TRIANGLES, 0, 3);
    schedule();
  }

  function schedule() {
    if (stopped || frame || !visible || document.hidden) return;
    last = 0;
    frame = requestAnimationFrame(draw);
  }

  function destroy() {
    if (stopped) return;
    stopped = true;
    if (frame) cancelAnimationFrame(frame);
    io.disconnect();
    resizeObserver.disconnect();
    themeObserver.disconnect();
    darkQuery.removeEventListener("change", readTheme);
    window.removeEventListener("pointermove", onPointer);
    document.removeEventListener("pointerleave", onLeave);
    document.removeEventListener("visibilitychange", onVisibility);
    canvas.removeEventListener("webglcontextlost", onLost);
    g.getExtension("WEBGL_lose_context")?.loseContext();
  }

  schedule();
  return { destroy };
}
