export interface Option {
  id: string;
  label: string;
  claimedBy: string | null;
  recipeUrl: string | null;
}
export interface Section { id: string; title: string; options: Option[] }
export interface SignupForm { title: string; sections: Section[] }
export interface ClaimInput {
  name: string;
  selections: { optionId: string; recipeUrl?: string }[];
  custom: { sectionId: string; label: string; recipeUrl?: string }[];
}
