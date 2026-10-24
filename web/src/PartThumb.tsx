import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { Edges } from "@react-three/drei";
import * as THREE from "three";
import { HardwareMesh, METAL, orientation } from "./Hardware";
import type { HardwareSpec, Vec3 } from "./types";

// 부품 목록 썸네일: 3D 장면과 같은 형상을 등각 시점으로 그린 작은 캔버스.
const VIEW = new THREE.Vector3(1, 0.8, 1.3).normalize();
const BOARD = "#e9dcc6";
const EDGE = "#3b3b3b";

// 축이 긴 부품(나사·나무못)은 머리가 왼쪽 위, 끝이 오른쪽 아래로 오게 눕힌다.
const LONG = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, (-2 * Math.PI) / 3));
// 브래킷류는 3D 장면에서 붙는 자세 그대로(판 쪽이 왼쪽, 벽 쪽이 뒤).
const MOUNTED = orientation([-1, 0, 0], [0, 0, 1]);
// 커버는 열린 쪽(판·벽 쪽)이 보이게 돌려 놓는다.
const OPEN_SIDE = MOUNTED.clone().premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
const POSE: Record<HardwareSpec["model"], THREE.Quaternion> = {
  connector_screw: LONG, euro_screw: LONG, wall_screw: LONG, dowel: LONG,
  corner_bracket: MOUNTED, hook_plate: MOUNTED, bracket_cover: OPEN_SIDE,
  felt_pad: new THREE.Quaternion(), hex_key: new THREE.Quaternion(),
  hammer: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI / 2)),
  screwdriver: LONG, pencil: LONG, wall_mark: new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)),
};

// 내용물을 원점에 모으고, 화면에 투영된 크기에 맞춰 직교 카메라 배율을 정한다.
function Fit({ children }: { children: ReactNode }) {
  const ref = useRef<THREE.Group>(null);
  const { camera, size, invalidate } = useThree();
  useLayoutEffect(() => {
    const group = ref.current;
    if (!group) return;
    group.position.set(0, 0, 0);
    group.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(group);
    const center = box.getCenter(new THREE.Vector3());
    group.position.copy(center).negate();
    box.translate(center.clone().negate());

    const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
    camera.position.copy(VIEW).multiplyScalar(radius * 4 + 10);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const view = camera.matrixWorldInverse;
    const xs: number[] = [], ys: number[] = [];
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      const p = new THREE.Vector3(x, y, z).applyMatrix4(view);
      xs.push(p.x); ys.push(p.y);
    }
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
    const ortho = camera as THREE.OrthographicCamera;
    ortho.zoom = Math.min(size.width / w, size.height / h) * 0.82;
    ortho.near = 0.1;
    ortho.far = radius * 10 + 100;
    ortho.updateProjectionMatrix();
    invalidate();
  }, [camera, size, invalidate]);
  return <group ref={ref}>{children}</group>;
}

function Thumb({ children }: { children: ReactNode }) {
  return (
    <Canvas orthographic frameloop="demand" dpr={[1, 2]} gl={{ alpha: true, antialias: true }} className="thumb-canvas">
      <ambientLight intensity={1.1} />
      <directionalLight position={[3, 5, 4]} intensity={1.8} />
      <Fit>{children}</Fit>
    </Canvas>
  );
}

export function PanelThumb({ size, active }: { size: Vec3; active?: boolean }) {
  return (
    <Thumb>
      <mesh>
        <boxGeometry args={size} />
        <meshStandardMaterial color={active ? "#ff9a4d" : BOARD} roughness={0.8} />
        <Edges color={EDGE} />
      </mesh>
    </Thumb>
  );
}

export function HardwareThumb({ spec }: { spec: HardwareSpec }) {
  const metal = METAL.includes(spec.model);
  const material = useMemo(
    () => new THREE.MeshStandardMaterial({
      color: spec.color, metalness: metal ? 0.6 : 0, roughness: metal ? 0.35 : 0.75, side: THREE.DoubleSide,
    }),
    [spec.color, metal],
  );
  const accent = useMemo(() => new THREE.MeshBasicMaterial({ color: "#222222", side: THREE.DoubleSide }), []);
  return (
    <Thumb>
      <group quaternion={POSE[spec.model]}>
        <HardwareMesh part={spec} material={material} accent={accent} renderOrder={0} />
      </group>
    </Thumb>
  );
}
