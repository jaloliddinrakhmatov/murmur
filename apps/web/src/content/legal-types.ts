export type LegalBlock = { p: string } | { ul: string[] };
export interface LegalSection {
  id: string;
  title: string;
  blocks: LegalBlock[];
}
export interface LegalDoc {
  eyebrow: string;
  title: string;
  updated: string;
  sections: LegalSection[];
}
