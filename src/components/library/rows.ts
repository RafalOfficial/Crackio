/**
 * The Library's grid: justified rows, like a contact sheet. Every take keeps its own shape, all
 * takes in a row share one height, and a full row fills the width exactly, so a 21:9 clip gets the
 * width it needs and a 9:16 one the height. Rows aim for the height at which a 16:9 take fits
 * `perRow` times across: that's what the size buttons pick.
 */

export type Density = "s" | "m" | "l";

/** How wide (px) one 16:9 take is meant to be at each size; the count per row follows from the width. */
const UNIT: Record<Density, number> = { s: 300, m: 500, l: 760 };
const MIN_PER_ROW: Record<Density, number> = { s: 2, m: 1, l: 1 };

/** Takes per page at each size: a few screens of each, so a page stays light. */
export const PER_PAGE: Record<Density, number> = { s: 60, m: 40, l: 24 };

export const GAP = 8;

/** Very wide or very tall takes are framed a little tighter so they don't swallow a row. */
const clampRatio = (r: number) => Math.min(2.6, Math.max(0.5, r || 1));

/** The row height for this width and size. */
export function targetHeight(width: number, density: Density) {
  const perRow = Math.max(MIN_PER_ROW[density], Math.round(width / UNIT[density]));
  return (width - GAP * (perRow - 1)) / perRow / (16 / 9);
}

export type Row<T> = {
  items: { item: T; ratio: number }[];
  height: number;
  /** False for a short last row: it keeps the target height and sits to the left. */
  full: boolean;
};

/**
 * Splits `items` into rows. Each row grows until it would be shorter than the target, then keeps
 * whichever break lands closer to it.
 */
export function justify<T>(items: T[], ratioOf: (item: T) => number, width: number, target: number): Row<T>[] {
  const rows: Row<T>[] = [];
  if (width <= 0) return rows;
  const ratios = items.map((t) => clampRatio(ratioOf(t)));
  let i = 0;
  while (i < items.length) {
    let sum = 0;
    let before = Infinity;
    let end = -1;
    let height = target;
    for (let j = i; j < items.length; j++) {
      sum += ratios[j];
      const h = (width - GAP * (j - i)) / sum;
      if (h <= target) {
        // Without this take the row is `before` tall, with it `h`: keep the one nearer the target.
        const without = j > i && Math.log(before / target) < Math.log(target / h);
        end = without ? j : j + 1;
        height = without ? before : h;
        break;
      }
      before = h;
    }
    if (end < 0) {
      // What's left can't fill a row at the target height. Close to it, stretch; otherwise leave it short.
      const h = before;
      const stretch = h <= target * 1.25;
      rows.push(row(items, ratios, i, items.length, stretch ? h : target, stretch));
      break;
    }
    rows.push(row(items, ratios, i, end, height, true));
    i = end;
  }
  return rows;
}

function row<T>(items: T[], ratios: number[], from: number, to: number, height: number, full: boolean): Row<T> {
  return { items: items.slice(from, to).map((item, k) => ({ item, ratio: ratios[from + k] })), height, full };
}

/** A local calendar day, as a sortable key ("2026-10-22"). */
export function dayKey(ms: number) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "Today", "Yesterday", a weekday this week, else the date. */
export function dayLabel(ms: number, now = Date.now()) {
  const d = new Date(ms);
  const start = (t: number) => {
    const x = new Date(t);
    x.setHours(0, 0, 0, 0);
    return x.getTime();
  };
  const days = Math.round((start(now) - start(ms)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days > 1 && days < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

/** Consecutive runs of items from the same day, in the order given. */
export function byDay<T>(items: T[], timeOf: (item: T) => number) {
  const groups: { day: string; at: number; items: T[] }[] = [];
  for (const item of items) {
    const at = timeOf(item);
    const day = dayKey(at);
    const last = groups[groups.length - 1];
    if (last?.day === day) last.items.push(item);
    else groups.push({ day, at, items: [item] });
  }
  return groups;
}
