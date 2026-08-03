import { App } from "@modelcontextprotocol/ext-apps";
import { el, parseResult, root, showError } from "./shared.js";

interface Issue {
  path: string;
  severity: "error" | "warning";
  message: string;
}

interface Report {
  conformant: boolean;
  errors: Issue[];
  warnings: Issue[];
  checkedFiles: number;
}

function render(report: Report): void {
  const r = root();
  r.replaceChildren();
  const card = el("div", "card");

  const head = el("div", `verdict ${report.conformant ? "verdict-ok" : "verdict-bad"}`);
  head.append(el("span", "verdict-mark", report.conformant ? "✓" : "✕"));
  const summary = el("div");
  summary.append(
    el("div", "card-title", report.conformant ? "Conformant" : "Not conformant"),
    el(
      "div",
      "card-sub",
      `${report.checkedFiles} file${report.checkedFiles === 1 ? "" : "s"} checked · ` +
        `${report.errors.length} error${report.errors.length === 1 ? "" : "s"} · ` +
        `${report.warnings.length} warning${report.warnings.length === 1 ? "" : "s"}`,
    ),
  );
  head.append(summary);
  card.append(head);

  const issues = [...report.errors, ...report.warnings];
  if (issues.length) {
    const list = el("div", "issues");
    for (const issue of issues) {
      const line = el("div", `issue issue-${issue.severity}`);
      line.append(
        el("span", "issue-sev", issue.severity),
        el("span", "issue-path", issue.path),
        el("span", "issue-msg", issue.message),
      );
      list.append(line);
    }
    card.append(list);
  }

  r.append(card);
}

const app = new App({ name: "OKF Validation", version: "0.1.0" });
app.ontoolresult = (result) => {
  const report = parseResult<Report>(result);
  if (report) render(report);
  else showError("Could not read the validation report.");
};
app.connect();
