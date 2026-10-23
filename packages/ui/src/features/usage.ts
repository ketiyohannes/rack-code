/** Usage page: UTC daily activity and provider-reported token/cost coverage. */
import type { UsageReport } from "@rack/features/usage";
import type { Controller } from "../controller.js";
import type { HostClient } from "@rack/client/host-client";
import type { Store } from "../store.js";
import { h, replace, statCard } from "../dom.js";
import { icon } from "../icons.js";
import { createDropdown } from "../components/dropdown.js";

export function mountUsage(root: HTMLElement, store: Store, controller: Controller, host: HostClient): void {
  let days = 30, projectId = "", generation = 0, loading = false;
  const content = h("div", { class: "usage-content" });
  const error = h("p", { class: "error-line", role: "alert" });
  const project = createDropdown<string>({ ariaLabel: "Usage project", variant: "pill", onChange: (value) => { projectId = value; void load(); } });
  const range = createDropdown<string>({ ariaLabel: "Usage period", variant: "pill", onChange: (value) => { days = Number(value); void load(); } });
  range.setOptions([7, 30, 90, 365].map((value) => ({ value: String(value), label: `Last ${value} days` })), "30");
  const refresh = h("button", { class: "icon-button", title: "Refresh usage", aria: { label: "Refresh usage" }, onClick: () => void load() }, icon("arrow-clockwise"));
  root.append(h("header", { class: "page-heading" }, h("div", {}, h("span", { class: "label" }, "Activity & consumption"), h("h1", {}, "Usage")),
    h("div", { class: "page-actions" }, project.element, range.element, refresh,
      h("button", { class: "icon-button", title: "Back to session", aria: { label: "Back to session" }, onClick: () => controller.openPage("chat") }, icon("x")))), error, content);
  async function load(): Promise<void> {
    const current = ++generation;
    loading = true; refresh.disabled = true; error.textContent = "";
    content.setAttribute("aria-busy", "true");
    try {
      const report = await host.call("usage.report", { days, ...(projectId ? { projectId } : {}) });
      if (current !== generation) return;
      render(report);
    } catch (reason) { if (current === generation) error.textContent = reason instanceof Error ? reason.message : String(reason); }
    finally { if (current === generation) { loading = false; refresh.disabled = false; content.setAttribute("aria-busy", "false"); } }
  }
  function render(report: UsageReport): void {
    const t = report.totals, count = (value: number) => value.toLocaleString();
    const maximum = Math.max(1, ...report.daily.map((day) => day.runs));
    const chart = h("div", { class: "usage-chart", role: "img", aria: { label: `Daily runs in UTC. ${t.runs} runs across ${days} days.` } });
    for (const day of report.daily) {
      const bar = h("div", { class: "usage-bar", title: `${day.day} UTC: ${day.runs} runs · ${count(day.inputTokens + day.outputTokens)} reported tokens` });
      bar.style.setProperty("--activity", `${100 * day.runs / maximum}%`); chart.append(bar);
    }
    const table = h("table", { class: "usage-table" }, h("thead", {}, h("tr", {}, ...["Model / provider", "Runs", "Input", "Output", "Reported cost"].map((text) => h("th", {}, text)))),
      h("tbody", {}, ...report.models.map((model) => h("tr", {}, h("td", {}, h("strong", {}, model.model), h("span", { class: "note" }, model.provider)),
        h("td", {}, count(model.runs)), h("td", {}, model.tokenRuns ? count(model.inputTokens) : "—"), h("td", {}, model.tokenRuns ? count(model.outputTokens) : "—"), h("td", {}, model.costRuns ? `$${model.costUsd.toFixed(4)}` : "—")))));
    replace(content,
      h("div", { class: "usage-metrics" }, statCard("Runs", count(t.runs), { caption: `${t.completed} completed · ${t.failed} failed` }),
        statCard("Input tokens", t.tokenRuns ? count(t.inputTokens) : "—", { caption: `${t.tokenRuns} runs with token data` }),
        statCard("Output tokens", t.tokenRuns ? count(t.outputTokens) : "—"),
        statCard("Reported cost", t.costRuns ? `$${t.costUsd.toFixed(4)}` : "—", { caption: `${t.costRuns} of ${t.runs} runs report cost` })),
      h("section", { class: "usage-section" }, h("div", { class: "usage-section-heading" }, h("h2", {}, "Daily activity"), h("span", { class: "note" }, `${report.daily[0]?.day} — ${report.daily.at(-1)?.day} · UTC`)), chart),
      h("section", { class: "usage-section" }, h("h2", {}, "By model"), t.runs ? table : h("p", { class: "page-empty" }, "No recorded runs in this period. Activity will appear after your first run.")),
      h("p", { class: "note" }, "Recorded runtime usage only. Missing values are unavailable; reported cost is not a subscription bill. Imported conversations have no usage until a run is recorded in Rack."));
  }
  store.watch((state) => [state.page, state.projects], (_slice, state) => {
    root.hidden = state.page !== "usage";
    project.setOptions([{ value: "", label: "All projects" }, ...state.projects.map((item) => ({ value: item.id, label: item.path.split("/").pop() ?? item.path }))], projectId);
    if (!root.hidden) void load();
  });
  window.setInterval(() => { if (!root.hidden && !loading && !document.hidden) void load(); }, 30_000);
}
