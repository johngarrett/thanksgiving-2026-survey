export interface Option {
  id: string;
  label: string;
  claimedBy: string | null;
  notes: string | null;
}
export interface Section { id: string; title: string; customPlaceholder: string; options: Option[] }
export interface SignupForm { title: string; sections: Section[] }
export interface ClaimInput {
  ownerId?: string;
  name: string;
  selections: { optionId: string; notes?: string; label?: string }[];
  custom: { sectionId: string; label: string; notes?: string }[];
}
