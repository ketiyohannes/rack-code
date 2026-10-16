/** Analytics over recorded runtime observations. Missing billing data stays missing. */
import type { RunUsage } from "../../core/execution/types.js";
export interface UsageFilter { readonly projectId?: string; readonly days: number }
export interface UsageMetric {
  readonly runs: number; readonly completed: number; readonly failed: number;
  readonly inputTokens: number; readonly outputTokens: number; readonly costUsd: number;
  readonly tokenRuns: number; readonly costRuns: number;
}
export interface UsageReport {
  readonly totals: UsageMetric;
  readonly daily: readonly (UsageMetric & { readonly day: string })[];
  readonly models: readonly (UsageMetric & { readonly model: string; readonly provider: string })[];
  readonly generatedAt: string;
}
type Audit = readonly RunUsage[];
const empty = (): UsageMetric => ({ runs: 0, completed: 0, failed: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, tokenRuns: 0, costRuns: 0 });
const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
function add(a: UsageMetric, b: UsageMetric): UsageMetric {
  return Object.fromEntries(Object.keys(a).map((key) => [key, a[key as keyof UsageMetric] + b[key as keyof UsageMetric]])) as unknown as UsageMetric;
}
export class UsageService {
  constructor(private readonly read: () => Promise<Audit>, private readonly now = () => new Date()) {}
  async report(filter: UsageFilter): Promise<UsageReport> {
    const now = this.now();
    const first = new Date(now); first.setUTCHours(0, 0, 0, 0); first.setUTCDate(first.getUTCDate() - filter.days + 1);
    const daily = new Map<string, UsageMetric>();
    for (let day = new Date(first); day <= now; day.setUTCDate(day.getUTCDate() + 1)) daily.set(day.toISOString().slice(0, 10), empty());
    const models = new Map<string, UsageMetric & { model: string; provider: string }>();
    let totals = empty();
    for (const { run, usage } of await this.read()) {
      if (filter.projectId && run.projectId !== filter.projectId) continue;
      const day = run.createdAt.slice(0, 10);
      if (!daily.has(day)) continue;
      // Providers emit cumulative observations. Keep each attempt's latest known field,
      // then sum attempts; summing every notification would count the same tokens repeatedly.
      const attempts = new Map<string, { inputTokens?: number; outputTokens?: number; costUsd?: number }>();
      for (const entry of [...usage].sort((a, b) => a.sequence - b.sequence)) {
        const payload = entry.payload as Record<string, unknown>;
        const value = attempts.get(entry.attemptId) ?? {};
        for (const key of ["inputTokens", "outputTokens", "costUsd"] as const) if (valid(payload[key])) value[key] = payload[key];
        attempts.set(entry.attemptId, value);
      }
      let inputTokens = 0, outputTokens = 0, costUsd = 0, tokensKnown = false, costKnown = false;
      for (const value of attempts.values()) {
        inputTokens += value.inputTokens ?? 0; outputTokens += value.outputTokens ?? 0; costUsd += value.costUsd ?? 0;
        tokensKnown ||= value.inputTokens !== undefined || value.outputTokens !== undefined; costKnown ||= value.costUsd !== undefined;
      }
      const metric: UsageMetric = { runs: 1, completed: Number(run.status === "completed"), failed: Number(run.status === "failed"), inputTokens, outputTokens, costUsd, tokenRuns: Number(tokensKnown), costRuns: Number(costKnown) };
      totals = add(totals, metric); daily.set(day, add(daily.get(day)!, metric));
      const model = run.model ?? "Provider default", key = `${run.providerId}\0${model}`;
      models.set(key, { ...add(models.get(key) ?? empty(), metric), model, provider: run.providerId });
    }
    return { totals, daily: [...daily].map(([day, metric]) => ({ day, ...metric })), models: [...models.values()].sort((a, b) => b.runs - a.runs), generatedAt: now.toISOString() };
  }
}
