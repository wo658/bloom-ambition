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
  | "corner_bracket" | "hook_plate" | "bracket_cover" | "felt_pad" | "hex_key"
  | "hammer" | "screwdriver" | "pencil" | "wall_mark" | "spirit_level";

export interface HardwareSpec {
  model: HardwareModel;
  color: string;
  dims: Record<string, number>;
}

// at·axis·up은 가구 좌표(cm). 부품 로컬 +Y가 axis(박히는 방향), +Z가 up.
// approach는 다가오는 방향(없으면 axis), travel은 움직이는 거리, tool은 함께 그릴 공구의 부품 번호.
// drop은 그만큼 위에서 들어온 뒤 내려앉는 거리(열쇠 구멍에 거는 고리 판), transient는 그 단계에서만 보이는 것.
export interface SmallPart {
  id: string;
  part_id: string;
  model: HardwareModel;
  dims: Record<string, number>;
  color: string;
  at: Vec3;
  axis: Vec3;
  up?: Vec3;
  approach?: Vec3;
  travel?: number;
  tool?: string;
  drop?: number;
  transient?: boolean;
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
  reseat?: string[]; // 이미 붙은 판을 살짝 뺐다가 다시 끝까지 밀어 넣는다
  unit_offset?: Vec3; // 가구 전체를 잠시 옮겨 두는 거리
}

export interface Scene {
  product: string;
  size: Vec3;
  wall_z: number;
  floor_offset: number;
  reseat_ratio?: number;
  hardware: Record<string, HardwareSpec>;
  panels: Panel[];
  steps: Step[];
  safety_ko: string[];
  extracted_by: string;
  issues: string[];
}
