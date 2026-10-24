import * as THREE from "three";

// 오일 마감 오크 텍스처(TORNVIKEN 재질에서 추출). 한 장이 실제로 덮는 크기(cm), 나뭇결은 가로 방향.
const TEX_W = 120;
const TEX_H = 60;

export type OakMaps = { map: THREE.Texture; normalMap: THREE.Texture; roughnessMap: THREE.Texture };
let maps: OakMaps | null = null;

// 판마다 따로 만들지 않도록 한 번만 불러 공유한다. 무늬 위치는 UV 오프셋으로 다르게 준다.
export function oakMaps(): OakMaps {
  if (maps) return maps;
  const loader = new THREE.TextureLoader();
  const load = (name: string, srgb = false) => {
    const t = loader.load(`/textures/oak/${name}.jpg`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  // glTF metallicRoughness 맵: G 채널이 거칠기라 three의 roughnessMap에 그대로 쓴다.
  maps = { map: load("base", true), normalMap: load("normal"), roughnessMap: load("mr") };
  return maps;
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}

// 상자의 면마다 실제 치수에 맞춰 UV를 늘리고, 나뭇결이 면의 긴 변을 따라가게 돌린다.
export function woodBox(size: [number, number, number], seed: string) {
  const [w, h, d] = size;
  const geo = new THREE.BoxGeometry(w, h, d);
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  // BoxGeometry 면 순서: +x, -x, +y, -y, +z, -z (면당 정점 4개). [u 방향 길이, v 방향 길이]
  const faces: [number, number][] = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  const ou = hash(seed), ov = hash(seed + "v");
  faces.forEach(([fu, fv], f) => {
    for (let i = f * 4; i < f * 4 + 4; i++) {
      const u = uv.getX(i), v = uv.getY(i);
      if (fu >= fv) uv.setXY(i, ou + (u * fu) / TEX_W, ov + (v * fv) / TEX_H);
      else uv.setXY(i, ou + (v * fv) / TEX_W, ov + (u * fu) / TEX_H);
    }
  });
  uv.needsUpdate = true;
  return geo;
}
