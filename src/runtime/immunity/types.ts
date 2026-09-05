export type ImmunityTrigger = "rollback" | "rollback_turn" | "hard_steer";

export type ImmunityRule = Readonly<{
  id: string;
  repoId: string;
  createdAt: string;
  trigger: ImmunityTrigger;
  lesson: string;
  detail?: string;
  affectedFiles?: readonly string[];
}>;

export type ImmunityFileFormat = Readonly<{
  version: 1;
  updatedAt: string;
  rules: readonly ImmunityRule[];
}>;
