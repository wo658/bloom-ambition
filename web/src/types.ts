export type Vec3 = [number, number, number];

export interface Panel {
  id: string;
  name_ko: string;
  size: Vec3;
  pos: Vec3;
  from: Vec3;
}

export type HardwareModel =
  | "connector_screw" | "dowel" | "euro_screw" | "wall_screw"
  | "corner_bracket" | "hook_plate" | "bracket_cover" | "felt_pad" | "hex_key";

export interface HardwareSpec {
  model: HardwareModel;
  color: string;
  dims: Record<string, number>;
}

// at·axis·up은 가구 좌표(cm). 부품 로컬 +Y가 axis(박히는 방향), +Z가 up.
export interface SmallPart {
  id: string;
  part_id: string;
  model: HardwareModel;
  dims: Record<string, number>;
  color: string;
  at: Vec3;
  axis: Vec3;
  up?: Vec3;
}

export interface Step {
  number: number;
  page: number;
  caption_ko: string;
  warning_ko: string | null;
  confidence: number;
  adds: string[];
  uses: { part_id: string; qty: number; name_ko: string }[];
  small: SmallPart[];
  pose: "lying" | "upright";
  wall: boolean;
}

export interface Scene {
  product: string;
  size: Vec3;
  wall_z: number;
  floor_offset: number;
  hardware: Record<string, HardwareSpec>;
  panels: Panel[];
  steps: Step[];
  safety_ko: string[];
  extracted_by: string;
  issues: string[];
}
