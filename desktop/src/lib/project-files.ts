export interface ProjectFilePreview {
  path: string;
  content: string;
}

export interface ProjectFileLineRange {
  readonly startLine: number;
  readonly endLine: number;
}
