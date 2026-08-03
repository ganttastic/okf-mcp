import { App } from "@modelcontextprotocol/ext-apps";
import { badge, el, parseResult, root, showError } from "./shared.js";

interface Signals {
  type?: string;
  title: string;
  description?: string;
  status: string;
  trust_tier: "unverified" | "machine-confirmed" | "human-reviewed";
  verified: { by: string; at?: string }[];
  generated_by?: string;
  generated_at?: string;
  stale: boolean;
  stale_after?: string;
  tags?: unknown[];
}

const TIER_LABEL: Record<Signals["trust_tier"], string> = {
  "human-reviewed": "Human-reviewed",
  "machine-confirmed": "Machine-confirmed",
  unverified: "Unverified",
};

function render(signals: Signals): void {
  const r = root();
  r.replaceChildren();
  const card = el("div", "card");

  const head = el("div", "card-head");
  const titleWrap = el("div");
  titleWrap.append(el("div", "card-title", signals.title));
  if (signals.type) titleWrap.append(el("div", "card-sub", signals.type));
  head.append(titleWrap);
  const badges = el("div", "badges");
  badges.append(badge(TIER_LABEL[signals.trust_tier], `tier-${signals.trust_tier}`));
  if (signals.status !== "stable") badges.append(badge(signals.status, "warn"));
  if (signals.stale) badges.append(badge("stale", "warn"));
  head.append(badges);
  card.append(head);

  if (signals.description) card.append(el("div", "card-desc", signals.description));

  const rows = el("div", "rows");
  const row = (label: string, value: string) => {
    const line = el("div", "row");
    line.append(el("span", "row-label", label), el("span", "row-value", value));
    rows.append(line);
  };
  if (signals.generated_by || signals.generated_at) {
    row("Generated", [signals.generated_by, signals.generated_at].filter(Boolean).join(" · "));
  }
  for (const v of signals.verified) {
    row("Verified", [v.by, v.at].filter(Boolean).join(" · "));
  }
  if (signals.stale_after) {
    row(signals.stale ? "Stale since" : "Fresh until", signals.stale_after);
  }
  if (rows.childElementCount) card.append(rows);

  if (Array.isArray(signals.tags) && signals.tags.length) {
    const tags = el("div", "tags");
    for (const tag of signals.tags) tags.append(el("span", "tag", String(tag)));
    card.append(tags);
  }

  r.append(card);
}

const app = new App({ name: "OKF Concept Status", version: "0.1.0" });
app.ontoolresult = (result) => {
  const signals = parseResult<Signals>(result);
  if (signals) render(signals);
  else showError("Could not read the concept signals.");
};
app.connect();
