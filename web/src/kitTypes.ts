export type Box = [number, number, number, number];

export interface KitPartRef {
  id: string;
  markings: string[] | null;
  optional: boolean;
}

export interface KitStep {
  number: number;
  id: string;
  label: string | null;
  page: number;
  region: Box;
  title_ko: string;
  caption_ko: string;
  parts: KitPartRef[];
  uses_steps: string[];
  markings: string[] | null;
  paints_ko: string[];
  warning_ko: string | null;
  confidence: number;
  hits: { id: string; box: Box }[];
  missing: string[];
}

export interface KitGuideData {
  kind: "kit";
  product: string;
  markings: { id: string; title_ko: string; page: number }[];
  steps: KitStep[];
  notes_ko: string[];
  extracted_by: string;
  page_aspect: number;
  ocr_recall: number;
}
