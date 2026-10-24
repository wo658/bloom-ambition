// 오프닝 전용 재질과 종이 휘기 계산. 기존 뷰어 재질(wood.ts)은 가져다 쓰기만 한다.
import * as THREE from "three";
import { oakMaps } from "../wood";

// ── 종이 휘기 ──────────────────────────────────────────────
// 늘어나지 않는 종이 띠를 한 축(s) 방향으로 휜다. 시작 각도 theta에서 곡률 kappa만큼 일정하게 돌아간다.
// 반환: 띠 위 s 지점의 [앞으로 간 거리, 옆으로 뜬 거리]
export function bend(s: number, theta: number, kappa: number): [number, number] {
  if (Math.abs(kappa) < 1e-5) return [s * Math.cos(theta), s * Math.sin(theta)];
  return [
    (Math.sin(theta + kappa * s) - Math.sin(theta)) / kappa,
    (Math.cos(theta) - Math.cos(theta + kappa * s)) / kappa,
  ];
}

// 책장 넘기기: 책등(x=0)을 축으로 theta 0(오른쪽) → PI(왼쪽). 바깥 끝이 늦게 따라오며 휜다.
export function flipSheet(geo: THREE.BufferGeometry, rest: Float32Array, width: number, theta: number, lift: number) {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const kappa = (-1.1 * Math.sin(theta)) / width;
  for (let i = 0; i < pos.count; i++) {
    const [x, z] = bend(rest[i * 3], theta, kappa);
    // 화면 쪽으로 너무 튀어나오지 않게 들리는 높이는 절반 남짓만 쓴다.
    pos.setXYZ(i, x, rest[i * 3 + 1], z * 0.45 + lift);
  }
  pos.needsUpdate = true;
  geo.computeBoundingSphere();
}

// 바닥에 눕기: 아랫변(y=0)을 경첩으로 뒤로(-z) 눕는다. theta 0(서 있음) → PI/2(누움). 윗부분이 공기에 밀려 살짝 늦는다.
export function lieSheet(geo: THREE.BufferGeometry, rest: Float32Array, height: number, theta: number) {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const kappa = (-0.9 * Math.sin(2 * theta)) / height;
  for (let i = 0; i < pos.count; i++) {
    // bend의 각도는 바닥에서 잰 것이라, 세로에서 잰 theta를 PI/2 - theta로 바꿔 넣는다.
    const [back, up] = bend(rest[i * 3 + 1], Math.PI / 2 - theta, -kappa);
    pos.setXYZ(i, rest[i * 3], up, -back);
  }
  pos.needsUpdate = true;
  geo.computeBoundingSphere();
}

// 아랫변(또는 왼쪽 변)이 원점에 오도록 옮긴 평면과 그 처음 좌표
export function stripGeometry(width: number, height: number, segX: number, segY: number, anchor: "left" | "bottom") {
  const geo = new THREE.PlaneGeometry(width, height, segX, segY);
  if (anchor === "left") geo.translate(width / 2, 0, 0);
  else geo.translate(0, height / 2, 0);
  return { geo, rest: Float32Array.from(geo.attributes.position.array as Float32Array) };
}

// ── 종이 → 청사진 재질 ───────────────────────────────────────
// sweep(0~1)이 아래에서 위로 지나가면, 지나간 자리는 남색 바탕에 빛나는 하늘색 선(청사진)으로 바뀐다.
export const CYAN = new THREE.Color("#5fd8ff");
// focus(u1,v1,u2,v2 · 0~1)를 주면 focusAmt만큼 그 바깥을 어둡게 눌러, 판이 솟을 (i) 그림 쪽으로 눈을 모은다.
export function paperMaterial(map: THREE.Texture, transparent = true) {
  return new THREE.ShaderMaterial({
    transparent,
    side: THREE.DoubleSide,
    uniforms: {
      map: { value: map },
      uSweep: { value: -1 },
      uOpacity: { value: 1 },
      uInk: { value: CYAN.clone().multiplyScalar(2.4) },
      uBase: { value: new THREE.Color("#0b2a4a") },
      uFlip: { value: 0 },
      uFocus: { value: new THREE.Vector4(0, 0, 1, 1) },
      uFocusAmt: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      uniform float uSweep, uOpacity, uFlip, uFocusAmt;
      uniform vec3 uInk, uBase;
      uniform vec4 uFocus;
      varying vec2 vUv;
      void main() {
        vec2 uv = vec2(mix(vUv.x, 1.0 - vUv.x, uFlip), vUv.y);
        vec3 paper = texture2D(map, uv).rgb;
        float ink = 1.0 - dot(paper, vec3(0.333));
        float d = vUv.y - uSweep;
        float behind = smoothstep(0.015, -0.015, d);
        vec3 blue = mix(uBase, uInk, smoothstep(0.08, 0.6, ink));
        vec3 col = mix(paper, blue, behind);
        col += uInk * 0.45 * exp(-pow(d / 0.008, 2.0));
        vec2 inside = step(uFocus.xy, vUv) * step(vUv, uFocus.zw);
        col *= mix(1.0, 0.28, uFocusAmt * (1.0 - inside.x * inside.y));
        gl_FragColor = vec4(col, uOpacity);
        #include <colorspace_fragment>
      }`,
  });
}

// ── 원목 재질(아래에서 위로 입혀지는) ─────────────────────────
// App의 원목과 같은 재질에, reveal 높이(월드 y) 위쪽은 아직 안 보이게 자르고 경계에 빛나는 띠를 둔다.
// 오프닝 캔버스는 발광 효과 때문에 톤 매핑을 끄고 그리므로, 원목만 App과 같은 ACES 톤 매핑을 직접 입힌다.
const ACES = /* glsl */ `
vec3 opRRT(vec3 v) { vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }
vec3 opACES(vec3 color) {
  const mat3 inM = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 outM = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  color *= 1.0 / 0.6;
  return clamp(outM * opRRT(inM * color), 0.0, 1.0);
}`;

export type WoodUniforms = { uReveal: { value: number }; uRim: { value: THREE.Color }; uPlain: { value: number } };

export function woodMaterial() {
  const uniforms: WoodUniforms = {
    uReveal: { value: -1000 },
    uRim: { value: CYAN.clone().multiplyScalar(1.4) },
    uPlain: { value: 0 },
  };
  const mat = new THREE.MeshStandardMaterial({ color: "#ffffff", ...oakMaps(), roughness: 1, metalness: 0 });
  mat.normalScale.set(0.6, 0.6);
  // 외곽선이 판 면과 같은 자리에 겹쳐 점선처럼 끊겨 보이지 않게, 면을 아주 살짝 뒤로 민다.
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = 1;
  mat.polygonOffsetUnits = 1;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vOpWorld;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvOpWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vOpWorld;\nuniform float uReveal, uPlain;\nuniform vec3 uRim;\n${ACES}`)
      .replace("#include <clipping_planes_fragment>", "#include <clipping_planes_fragment>\nfloat opD = vOpWorld.y - uReveal;\nif (opD > 0.0) discard;")
      // uPlain 1이면 나뭇결을 빼고 색만 남긴다(App의 '이번 단계 부품' 주황 판과 같은 모습).
      .replace("#include <map_fragment>", `#ifdef USE_MAP
        vec4 sampledDiffuseColor = texture2D(map, vMapUv);
        diffuseColor *= mix(sampledDiffuseColor, vec4(1.0), uPlain);
      #endif`)
      .replace("#include <opaque_fragment>", "outgoingLight = opACES(outgoingLight) + uRim * exp(-pow(opD / 2.5, 2.0));\n#include <opaque_fragment>");
  };
  mat.customProgramCacheKey = () => "opening-wood";
  return { mat, uniforms };
}

// ── 배경 ────────────────────────────────────────────────
// App의 .viewer 배경(가운데 흰색 → 가장자리 회청색)과 같은 그라데이션. 도착할 때 이음새가 안 보이게 한다.
export function appBackground() {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 512;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(256, 205, 0, 256, 205, 362);
  grad.addColorStop(0, "#ffffff");
  grad.addColorStop(0.55, "#f1f4f8");
  grad.addColorStop(1, "#dfe4eb");
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
