/** Tiny DOM helpers shared by the card apps. All content flows through
 * textContent — tool results are data, never markup. */

export function el(
  tag: string,
  className?: string,
  text?: string,
): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function badge(text: string, kind: string): HTMLElement {
  return el("span", `badge badge-${kind}`, text);
}

export function root(): HTMLElement {
  return document.getElementById("root")!;
}

/** First text content block of a tool result, parsed as JSON. */
export function parseResult<T>(result: {
  content?: { type: string; text?: string }[];
}): T | undefined {
  const text = result.content?.find((c) => c.type === "text")?.text;
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

export function showError(message: string): void {
  const r = root();
  r.replaceChildren(el("div", "empty", message));
}
