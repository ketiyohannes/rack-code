/**
 * The plan catalogue.
 *
 * Plans are code, not data: the limits they carry are enforced by
 * provisioning, so changing one is a deliberate change with a diff and a
 * review rather than a row edited in production. Prices are integer minor
 * units; floating-point money is a recurring source of rounding bugs.
 */

export interface Plan {
  readonly id: string;
  readonly name: string;
  readonly priceCents: number;
  readonly currency: "usd";
  /** Machines the account may hold at once, enforced on provisioning. */
  readonly machineLimit: number;
  /** Snapshots kept per machine, enforced when a safe shot is taken. */
  readonly snapshotLimit: number;
  readonly description: string;
}

export const PLANS: readonly Plan[] = [
  {
    id: "free",
    name: "Free",
    priceCents: 0,
    currency: "usd",
    machineLimit: 1,
    snapshotLimit: 3,
    description: "One machine for trying hosted projects.",
  },
  {
    id: "pro",
    name: "Pro",
    priceCents: 2_900,
    currency: "usd",
    machineLimit: 5,
    snapshotLimit: 20,
    description: "Several project machines with room for safe shots.",
  },
  {
    id: "team",
    name: "Team",
    priceCents: 9_900,
    currency: "usd",
    machineLimit: 25,
    snapshotLimit: 50,
    description: "Shared machines for a team of agents and people.",
  },
];

export const DEFAULT_PLAN_ID = "free";

export function findPlan(planId: string): Plan | undefined {
  return PLANS.find((plan) => plan.id === planId);
}
