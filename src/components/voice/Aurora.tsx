"use client";

import { useEffect, useRef } from "react";
import { usePlayer } from "./player";
import { useTalkState } from "./talk-store";

/**
 * Voice's moving backdrop: liquid smoke in the voice's two colours flowing behind the page (domain-warped noise in a
 * fragment shader), brightening with whatever plays. It draws at a fraction of the page's size (the light is soft, so
 * the browser's own scaling smooths it), at most 30 times a second, only while it's on screen and the tab is shown; for
 * reduced motion it draws once and stays. Without WebGL it draws nothing and the CSS backdrop under it shows.
 */

const SCALE = 0.36;
const FRAME_MS = 1000 / 30;

const VERT = `attribute vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }`;

const FRAG = `precision mediump float;
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uA;
uniform vec3 uB;
uniform float uLevel;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int k = 0; k < 4; k++) { v += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float t = uTime * 0.045;
  // Liquid smoke: noise bent by noise bent by noise, each layer drifting its own way.
  vec2 q = vec2(fbm(p * 1.5 + vec2(0.0, t)), fbm(p * 1.5 + vec2(5.2, -t * 0.8)));
  vec2 r = vec2(fbm(p * 1.5 + 3.2 * q + vec2(1.7, 9.2) + t * 0.6), fbm(p * 1.5 + 3.2 * q + vec2(8.3, 2.8) - t * 0.5));
  float f = fbm(p * 1.5 + 3.4 * r);

  vec3 col = vec3(0.052, 0.044, 0.066);
  // The deep colour in broad folds, the light one in the bright crests where the folds meet.
  col = mix(col, uB * 0.62, smoothstep(0.32, 0.92, f));
  col = mix(col, uA * 0.82, smoothstep(0.62, 1.08, f + 0.45 * r.x) * 0.75);
  // Thin silk highlights along the folds.
  col += uA * 0.16 * smoothstep(0.02, 0.0, abs(f - 0.58)) * smoothstep(0.2, 0.8, q.y);
  // Light pooled behind the orb, breathing with the sound.
  float glow = exp(-2.6 * length((p - vec2(0.0, 0.2)) * vec2(0.9, 1.15)));
  col += uB * glow * (0.16 + 0.34 * uLevel) + uA * glow * glow * (0.05 + 0.2 * uLevel);
  // Darker toward the edges and the bottom, where the words and the bar sit; a little dimmer overall.
  col *= smoothstep(1.35, 0.25, length(p * vec2(0.72, 1.0)));
  col *= mix(0.5, 1.0, smoothstep(0.0, 0.6, uv.y));
  gl_FragColor = vec4(col * 0.82, 1.0);
}`;

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function Aurora({ hues, className }: { hues: [string, string]; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const target = useRef({ a: rgb(hues[0]), b: rgb(hues[1]) });
  const redraw = useRef<(() => void) | null>(null);
  // The colours it eases to (and, for reduced motion, one more frame in them).
  useEffect(() => {
    target.current = { a: rgb(hues[0]), b: rgb(hues[1]) };
    redraw.current?.();
  }, [hues]);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const gl = el.getContext("webgl", { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: "low-power", preserveDrawingBuffer: false });
    if (!gl) return;
    const shader = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
    };
    const vs = shader(gl.VERTEX_SHADER, VERT);
    const fs = shader(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "a");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const u = { res: gl.getUniformLocation(prog, "uRes"), time: gl.getUniformLocation(prog, "uTime"), a: gl.getUniformLocation(prog, "uA"), b: gl.getUniformLocation(prog, "uB"), level: gl.getUniformLocation(prog, "uLevel") };
    el.dataset.ready = "";

    // Colours ease to the voice's; the level follows the sound, quick up and slow down.
    const now = { a: [...target.current.a], b: [...target.current.b], level: 0 };
    // Whatever sounds: a take playing, or a live talk (your voice or its answer).
    let heard = 0;
    let talked = 0;
    const off = usePlayer.subscribe((s) => (heard = s.playing ? s.level : 0));
    const offTalk = useTalkState.subscribe((s) => (talked = s.level));

    const size = () => {
      const w = Math.max(2, Math.round(el.clientWidth * SCALE));
      const h = Math.max(2, Math.round(el.clientHeight * SCALE));
      if (el.width !== w || el.height !== h) {
        el.width = w;
        el.height = h;
        gl.viewport(0, 0, w, h);
      }
      gl.uniform2f(u.res, w, h);
    };
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const born = performance.now() - 40_000 * Math.random();
    const draw = (ms: number) => {
      size();
      for (const k of ["a", "b"] as const) for (let i = 0; i < 3; i++) now[k][i] += (target.current[k][i] - now[k][i]) * 0.06;
      const loud = Math.max(heard, talked);
      now.level += (loud - now.level) * (loud > now.level ? 0.35 : 0.06);
      gl.uniform1f(u.time, (ms - born) / 1000);
      gl.uniform3f(u.a, now.a[0], now.a[1], now.a[2]);
      gl.uniform3f(u.b, now.b[0], now.b[1], now.b[2]);
      gl.uniform1f(u.level, Math.min(1, now.level * 1.6));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    let raf = 0;
    let last = 0;
    let visible = true;
    const loop = (ms: number) => {
      raf = 0;
      if (!visible || document.hidden) return;
      if (ms - last >= FRAME_MS) {
        last = ms;
        draw(ms);
      }
      raf = requestAnimationFrame(loop);
    };
    const start = () => {
      if (still) {
        // Reduced motion: one frame now, another when the colours change (see the hues effect below).
        draw(performance.now());
        return;
      }
      if (!raf) raf = requestAnimationFrame(loop);
    };
    const seen = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (visible) start();
    });
    seen.observe(el);
    const shown = () => !document.hidden && visible && start();
    document.addEventListener("visibilitychange", shown);
    // Reduced motion: the colours jump straight to the new voice's.
    redraw.current = () => {
      if (!still) return;
      now.a = [...target.current.a];
      now.b = [...target.current.b];
      draw(performance.now());
    };
    start();
    return () => {
      cancelAnimationFrame(raf);
      seen.disconnect();
      document.removeEventListener("visibilitychange", shown);
      off();
      offTalk();
      redraw.current = null;
      delete el.dataset.ready;
      // The context goes with the canvas. Losing it here on purpose would hand a dead one to the next mount of the same
      // canvas (React mounts twice while developing), and nothing would draw.
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(buf);
    };
  }, []);

  return <canvas ref={canvas} aria-hidden="true" className={className} />;
}
