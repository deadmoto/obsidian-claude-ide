export interface SelectionPayload {
  filePath?: string;
  selection?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  } | null;
  text?: string;
}

export interface CurrentFilePayload {
  path: string;
  relativePath: string;
  language: string;
  content: string;
  isDirty: boolean;
  timestamp: string;
}
