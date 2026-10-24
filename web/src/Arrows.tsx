import { forwardRef, useMemo } from "react";
import * as THREE from "three";
import type { Vec3 } from "./types";

// IKEA 설명서의 굵은 검은 화살표. 판과 철물에 가려지지 않도록 맨 위에 그린다.
const ARROW_COLOR = "#1f1f1f";
const RENDER_ORDER = 20;

function arrowMaterial() {
  return new THREE.MeshBasicMaterial({ color: ARROW_COLOR, depthTest: false, transparent: true });
}

// tail에서 head 쪽을 가리키는 직선 화살표. width는 화살촉 지름.
export const StraightArrow = forwardRef<THREE.Group, { tail: Vec3; head: Vec3; width: number }>(
  function StraightArrow({ tail, head, width }, ref) {
    const material = useMemo(arrowMaterial, []);
    const t = new THREE.Vector3(...tail), h = new THREE.Vector3(...head);
    const dir = h.clone().sub(t);
    const length = dir.length();
    const tip = Math.min(width * 1.4, length * 0.45);
    const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    return (
      <group ref={ref} position={tail} quaternion={quaternion} visible={false}>
        <mesh position={[0, (length - tip) / 2, 0]} material={material} renderOrder={RENDER_ORDER}>
          <cylinderGeometry args={[width * 0.2, width * 0.2, length - tip, 12]} />
        </mesh>
        <mesh position={[0, length - tip / 2, 0]} material={material} renderOrder={RENDER_ORDER}>
          <coneGeometry args={[width / 2, tip, 16]} />
        </mesh>
      </group>
    );
  },
);

// 조이는 방향 화살표: 부품 로컬 +Y(박히는 방향)를 축으로, 머리 쪽(-Y)에서 볼 때 시계 방향으로 도는 3/4 원.
export const TurnArrow = forwardRef<THREE.Group, { radius: number; y: number; width: number }>(
  function TurnArrow({ radius, y, width }, ref) {
    const material = useMemo(arrowMaterial, []);
    const tube = width * 0.2;
    return (
      <group ref={ref} position={[0, y, 0]} visible={false}>
        {/* XY 평면의 호를 XZ 평면으로 눕힌다. 머리 쪽에서 보면 각도가 커질수록 반시계 방향이다. */}
        <mesh rotation={[Math.PI / 2, 0, 0]} material={material} renderOrder={RENDER_ORDER}>
          <torusGeometry args={[radius, tube, 8, 32, Math.PI * 1.5]} />
        </mesh>
        {/* 그래서 화살촉은 호의 시작점(각도 0)에 두고 각도가 줄어드는 쪽(-Z)을 가리키게 한다. */}
        <mesh position={[radius, 0, -width * 0.35]} rotation={[-Math.PI / 2, 0, 0]} material={material}
          renderOrder={RENDER_ORDER}>
          <coneGeometry args={[width / 2, width * 1.1, 16]} />
        </mesh>
      </group>
    );
  },
);
