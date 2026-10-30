"use client";

import {
  AlwaysDepth,
  Color,
  DepthTexture,
  HalfFloatType,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  type PerspectiveCamera,
  type WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import type { ShotLook } from "@/lib/director/look";

/** Layer of on-set helpers (floor marks, grid, selection): drawn over the picture, never captured. */
export const HELPER_LAYER = 1;
export const STAGE_BACKGROUND = new Color("#0d0e11");

const vertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/**
 * The camera's own processing, after the set is rendered: lens blur from real depth (thin-lens
 * circle of confusion), then white balance, exposure, contrast, saturation, split toning,
 * faded blacks, vignette and grain. Writes the set's depth back so helpers drawn afterwards
 * are hidden behind people and walls.
 */
const fragment = /* glsl */ `
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform vec2 resolution;
  uniform float cameraNear;
  uniform float cameraFar;
  uniform float focus;
  uniform float focal;
  uniform float aperture;
  uniform float sensor;
  uniform float maxBlur;
  uniform vec3 balance;
  uniform float exposure;
  uniform float contrast;
  uniform float saturation;
  uniform vec4 shadowTint;
  uniform vec4 highlightTint;
  uniform float lift;
  uniform float vignette;
  uniform float grain;
  uniform bool writeDepth;
  varying vec2 vUv;

  float linearDepth(float d) {
    float z = d * 2.0 - 1.0;
    return (2.0 * cameraNear * cameraFar) / (cameraFar + cameraNear - z * (cameraFar - cameraNear));
  }

  // Blur radius as a share of the frame height.
  float blurAt(float z) {
    float c = (focal * focal) / (aperture * max(focus - focal, 0.001)) * abs(z - focus) / max(z, 0.001);
    return min(0.5 * c / sensor, maxBlur);
  }

  // Interleaved gradient noise: stable on every GPU (sin-based hashes band on large inputs).
  float hash(vec2 p) {
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
  }

  // Film grain wants white noise without structure (Dave Hoskins' hash without sine).
  float grainAt(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  vec3 toSRGB(vec3 c) {
    c = max(c, 0.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  }

  void main() {
    float d = texture2D(tDepth, vUv).x;
    float z = linearDepth(d);
    float blur = blurAt(z);
    vec3 color;
    if (blur * resolution.y < 0.75) {
      color = texture2D(tColor, vUv).rgb;
    } else {
      float aspect = resolution.x / resolution.y;
      float spin = hash(gl_FragCoord.xy) * 6.2831;
      vec3 sum = vec3(0.0);
      float weight = 0.0;
      for (int i = 0; i < 48; i++) {
        float r = sqrt((float(i) + 0.5) / 48.0);
        float a = float(i) * 2.39996 + spin;
        vec2 uv = vUv + vec2(cos(a) / aspect, sin(a)) * r * blur;
        float zs = linearDepth(texture2D(tDepth, uv).x);
        // Things behind always blend in; sharper things in front only reach as far as their own blur.
        float w = zs >= z - 0.05 ? 1.0 : clamp(blurAt(zs) / max(r * blur, 0.0001), 0.0, 1.0);
        sum += texture2D(tColor, uv).rgb * w;
        weight += w;
      }
      color = sum / max(weight, 0.0001);
    }

    color *= balance * exposure;
    vec3 g = toSRGB(color);
    float luma = dot(g, vec3(0.2126, 0.7152, 0.0722));
    g = (g - 0.5) * contrast + 0.5;
    g = mix(vec3(dot(g, vec3(0.2126, 0.7152, 0.0722))), g, saturation);
    g += (shadowTint.rgb - 0.5) * shadowTint.a * (1.0 - smoothstep(0.0, 0.55, luma));
    g += (highlightTint.rgb - 0.5) * highlightTint.a * smoothstep(0.45, 1.0, luma);
    g = g * (1.0 - lift) + lift;
    vec2 q = (vUv - 0.5) * vec2(resolution.x / resolution.y, 1.0);
    g *= mix(1.0, smoothstep(1.05, 0.25, length(q)), vignette);
    g += (grainAt(gl_FragCoord.xy) - 0.5) * grain;
    gl_FragColor = vec4(clamp(g, 0.0, 1.0), 1.0);
    if (writeDepth) gl_FragDepthEXT = d;
  }
`;

/** Renders the set through the camera's look: scene → (lens blur + grade) → screen or a target. */
export class ShotRenderer {
  private target: WebGLRenderTarget;
  private quad: Mesh;
  private quadScene = new Scene();
  private quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  readonly material: ShaderMaterial;

  constructor(width = 1, height = 1) {
    this.target = new WebGLRenderTarget(width, height, {
      type: HalfFloatType,
      samples: 4,
      depthTexture: new DepthTexture(width, height),
    });
    this.material = new ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      // Depth writes need the test on (GL skips writes when it's off); "always" lets every pixel through.
      depthTest: true,
      depthFunc: AlwaysDepth,
      depthWrite: true,
      uniforms: {
        tColor: { value: this.target.texture },
        tDepth: { value: this.target.depthTexture },
        resolution: { value: [width, height] },
        cameraNear: { value: 0.05 },
        cameraFar: { value: 1000 },
        focus: { value: 5 },
        focal: { value: 0.035 },
        aperture: { value: 2.8 },
        sensor: { value: 0.024 },
        maxBlur: { value: 0.02 },
        balance: { value: [1, 1, 1] },
        exposure: { value: 1 },
        contrast: { value: 1 },
        saturation: { value: 1 },
        shadowTint: { value: [0.5, 0.5, 0.5, 0] },
        highlightTint: { value: [0.5, 0.5, 0.5, 0] },
        lift: { value: 0 },
        vignette: { value: 0 },
        grain: { value: 0 },
        writeDepth: { value: true },
      },
    });
    this.quad = new Mesh(new PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  setSize(width: number, height: number) {
    if (this.target.width === width && this.target.height === height) return;
    this.target.setSize(width, height);
    this.material.uniforms.resolution.value = [width, height];
  }

  /** Draw the set (layer 0) through the look into `output` (null = the canvas). */
  render(gl: WebGLRenderer, scene: Scene, camera: PerspectiveCamera, look: ShotLook, output: WebGLRenderTarget | null) {
    const u = this.material.uniforms;
    const mask = camera.layers.mask;
    camera.layers.set(0);
    const prevTarget = gl.getRenderTarget();
    const prevClear = gl.getClearColor(new Color());
    const prevAlpha = gl.getClearAlpha();
    gl.setClearColor(STAGE_BACKGROUND, 1);
    gl.setRenderTarget(this.target);
    gl.clear();
    gl.render(scene, camera);
    camera.layers.mask = mask;

    u.cameraNear.value = camera.near;
    u.cameraFar.value = camera.far;
    u.focus.value = look.focus;
    u.focal.value = look.focal;
    u.aperture.value = look.aperture;
    u.sensor.value = look.sensor;
    u.maxBlur.value = look.maxBlur;
    u.balance.value = look.balance;
    u.exposure.value = look.exposure;
    u.contrast.value = look.contrast;
    u.saturation.value = look.saturation;
    u.shadowTint.value = look.shadows;
    u.highlightTint.value = look.highlights;
    u.lift.value = look.lift;
    u.vignette.value = look.vignette;
    u.grain.value = look.grain;
    u.writeDepth.value = output === null;

    gl.setRenderTarget(output);
    gl.clear();
    gl.render(this.quadScene, this.quadCamera);
    gl.setRenderTarget(prevTarget);
    gl.setClearColor(prevClear, prevAlpha);
  }

  dispose() {
    this.target.depthTexture?.dispose();
    this.target.dispose();
    this.material.dispose();
    this.quad.geometry.dispose();
  }
}
