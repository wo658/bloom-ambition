import type { Vec3 } from "./types";

export type KitPartKind = "plastic" | "photo_etch" | "clear" | "jig";

// 3D 장면의 조각 하나. 부품 하나가 좌우 한 쌍(mirror)이면 조각이 둘이다.
export interface KitPiece {
  key: string;
  step: number; // 원본 단계 인덱스
  part_id: string;
  kind: KitPartKind;
  markings: string[] | null;
  module: string;
  temp: boolean; // 지그: 그 단계에서만 보이고 빠진다
  model: string;
  dims: Record<string, unknown>;
  pos: Vec3;
  rot: Vec3; // 도(deg)
  from: Vec3; // 최종 위치에서 시작 위치까지
  color: string;
}

export interface KitStep {
  number: number;
  id: string;
  label: string | null;
  page: number;
  title_ko: string;
  caption_ko: string;
  adds: { id: string; name_ko: string; kind: KitPartKind; markings: string[] | null; optional: boolean }[];
  uses_steps: string[];
  joins: string[];
  markings: string[] | null;
  paints_ko: string[];
  warning_ko: string | null;
  confidence: number;
  pose: "bench" | "on_gear";
  focus: [number, number, number, number]; // 중심 xyz, 반지름
  view: Vec3; // 카메라가 초점에서 떨어져 있을 방향(부품이 날아오는 쪽)
}

export interface KitScene {
  kind: "kit3d";
  product: string;
  scale: number;
  markings: { id: string; title_ko: string; page: number }[];
  modules: Record<string, { offset: Vec3; join: number }>;
  poses: Record<KitStep["pose"], { pitch: number; height: number }>;
  pieces: KitPiece[];
  steps: KitStep[];
  notes_ko: string[];
  extracted_by: string;
  issues: string[];
}
