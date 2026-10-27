// Plugin themes omit the app's surface3 (user message bubble); surface2 mixed 9% toward
// foreground lands within a few levels of it in the light and dark themes.
export function mixHex(a: string, b: string, t: number): string {
  const rgb = (h: string) => (/^#[0-9a-f]{6}$/i.test(h) ? [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) : null);
  const x = rgb(a);
  const y = rgb(b);
  if (!x || !y) return a;
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("")}`;
}
