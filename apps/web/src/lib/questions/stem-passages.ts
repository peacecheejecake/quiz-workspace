// UX12-PASSAGE RED stub: the implementing commit replaces this.
export interface StemPassageLine {
  readonly marker: string;
  readonly text: string;
  readonly subs: readonly { readonly marker: string; readonly text: string }[];
}
export interface StemPassage {
  readonly heading: string;
  readonly intro: string;
  readonly lines: readonly StemPassageLine[];
}
export interface StemPassageLayout {
  readonly lead: readonly string[];
  readonly passages: readonly StemPassage[];
  readonly rest: string;
}
export function stemPassageLayout(stem: string): StemPassageLayout | null {
  return stem === '' ? null : null;
}
