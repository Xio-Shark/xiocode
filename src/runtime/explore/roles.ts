import type { ExploreLane } from "./lanes.ts";

export type ExploreRoleId = "locator" | "flow_analyst" | "impact_test" | "adversarial";

export type ExploreRole = Readonly<{
  id: ExploreRoleId;
  focus: string;
  /** Relative turn budget multiplier (1 = default maxTurns). */
  turnCapFactor: number;
  /** Relative output char budget multiplier. */
  outputCapFactor: number;
  /** Prefer cheaper/faster model when available. */
  preferFastModel: boolean;
}>;

export const EXPLORE_ROLES: readonly ExploreRole[] = [
  {
    id: "locator",
    focus: "paths, symbols, entrypoints, package boundaries",
    turnCapFactor: 0.5,
    outputCapFactor: 0.5,
    preferFastModel: true,
  },
  {
    id: "flow_analyst",
    focus: "call flow, data path, control flow across modules",
    turnCapFactor: 0.75,
    outputCapFactor: 0.75,
    preferFastModel: false,
  },
  {
    id: "impact_test",
    focus: "dependents, tests, blast radius, ownership of failures",
    turnCapFactor: 0.75,
    outputCapFactor: 0.75,
    preferFastModel: false,
  },
  {
    id: "adversarial",
    focus: "gaps, contradictions, missed edges, over-claimed evidence",
    turnCapFactor: 0.5,
    outputCapFactor: 0.5,
    preferFastModel: true,
  },
] as const;

export type RoleOwnership = Readonly<{
  role: ExploreRoleId;
  /** Path prefixes / globs assigned by dispatcher (non-overlapping preferred). */
  paths: readonly string[];
  /** Question ids owned by this worker. */
  questions: readonly string[];
}>;

export type RolePlan = Readonly<{
  ownership: RoleOwnership;
  role: ExploreRole;
}>;

/**
 * Assign roles for a lane with preferably non-overlapping path ownership.
 * Paths are partitioned round-robin across selected roles.
 */
export function planExploreRoles(
  lane: ExploreLane,
  paths: readonly string[],
  questions: readonly string[] = [],
): readonly RolePlan[] {
  if (lane === "fast") {
    return [];
  }
  const roleIds = rolesForLane(lane);
  if (roleIds.length === 0) return [];

  const buckets: { role: ExploreRoleId; paths: string[]; questions: string[] }[] = roleIds.map((id) => ({
    role: id,
    paths: [],
    questions: [],
  }));

  paths.forEach((pathValue, index) => {
    buckets[index % buckets.length]!.paths.push(pathValue);
  });
  questions.forEach((question, index) => {
    buckets[index % buckets.length]!.questions.push(question);
  });

  // If no paths provided, still emit roles with empty ownership (dispatcher may fill later).
  return buckets.map((bucket) => {
    const role = EXPLORE_ROLES.find((item) => item.id === bucket.role)!;
    return {
      role,
      ownership: {
        role: bucket.role,
        paths: bucket.paths,
        questions: bucket.questions,
      },
    };
  });
}

export function ownershipOverlap(plans: readonly RolePlan[]): number {
  const pathOwners = new Map<string, number>();
  for (const plan of plans) {
    for (const pathValue of plan.ownership.paths) {
      pathOwners.set(pathValue, (pathOwners.get(pathValue) ?? 0) + 1);
    }
  }
  if (pathOwners.size === 0) return 0;
  let overlapping = 0;
  for (const count of pathOwners.values()) {
    if (count > 1) overlapping += 1;
  }
  return overlapping / pathOwners.size;
}

function rolesForLane(lane: ExploreLane): ExploreRoleId[] {
  switch (lane) {
    case "fast":
      return [];
    case "standard":
      return ["locator", "flow_analyst"];
    case "deep":
      return ["locator", "flow_analyst", "impact_test", "adversarial"];
    case "explicit_high":
      return ["locator", "flow_analyst", "impact_test", "adversarial"];
    default: {
      const _exhaustive: never = lane;
      return _exhaustive;
    }
  }
}
