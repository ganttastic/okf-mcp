import { App } from "@modelcontextprotocol/ext-apps";
import { badge, el, parseResult, root, showError } from "./shared.js";

interface BundleRow {
  name: string;
  kind: string;
  okf_version?: string;
  title?: string;
  description?: string;
  categories?: { path: string; answers?: string }[];
  syncedAt?: string;
  stale: boolean;
  resolved: boolean;
}

function render(bundles: BundleRow[]): void {
  const r = root();
  r.replaceChildren();
  if (bundles.length === 0) {
    showError("No bundles registered.");
    return;
  }
  for (const bundle of bundles) {
    const card = el("div", "card");

    const head = el("div", "card-head");
    head.append(el("div", "card-title", bundle.title ?? bundle.name));
    const badges = el("div", "badges");
    badges.append(badge(bundle.kind, "kind"));
    if (bundle.okf_version) badges.append(badge(`OKF ${bundle.okf_version}`, "version"));
    if (bundle.stale) badges.append(badge("stale", "warn"));
    head.append(badges);
    card.append(head);

    if (bundle.description) card.append(el("div", "card-desc", bundle.description));

    if (bundle.categories?.length) {
      const grid = el("div", "cat-grid");
      for (const category of bundle.categories) {
        const chip = el("div", "cat");
        chip.append(el("div", "cat-path", category.path + "/"));
        if (category.answers) chip.append(el("div", "cat-answers", category.answers));
        grid.append(chip);
      }
      card.append(grid);
    }

    const foot = el("div", "card-foot");
    foot.append(
      el(
        "span",
        undefined,
        bundle.resolved
          ? bundle.syncedAt
            ? `synced ${bundle.syncedAt.replace("T", " ").replace(/:\d\d(\.\d+)?Z$/, " UTC")}`
            : "resolved"
          : "not yet synced — resolves on first read",
      ),
    );
    card.append(foot);
    r.append(card);
  }
}

const app = new App({ name: "OKF Bundles", version: "0.1.0" });
app.ontoolresult = (result) => {
  const bundles = parseResult<BundleRow[]>(result);
  if (bundles) render(bundles);
  else showError("Could not read the bundle list.");
};
app.connect();
