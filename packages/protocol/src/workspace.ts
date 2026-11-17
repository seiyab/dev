export const MAX_PANES = 16;
export const MAX_TERMINALS = 64;
export type Direction = "h" | "j" | "k" | "l";
export type PaneNode =
  | { type: "terminal"; id: string }
  | {
      type: "split";
      id: string;
      axis: "x" | "y";
      ratio: number;
      first: PaneNode;
      second: PaneNode;
    };
export interface Layout {
  root: PaneNode | null;
  activeId: string | null;
  zoomedId: string | null;
}
export interface TerminalResource {
  id: string;
  title: string;
  started: boolean;
}
export interface WorkspaceState {
  version: 1;
  revision: number;
  terminals: TerminalResource[];
  layout: Layout;
}
export const validId = (id: unknown): id is string =>
  typeof id === "string" && /^[a-z0-9-]{1,64}$/.test(id);

export function paneIds(node: PaneNode | null): string[] {
  if (!node) return [];
  return node.type === "terminal"
    ? [node.id]
    : [...paneIds(node.first), ...paneIds(node.second)];
}

export function parseLayout(
  value: unknown,
  terminals: TerminalResource[],
): Layout | null {
  if (!value || typeof value !== "object") return null;
  const layout = value as Layout;
  const ids = new Set<string>();
  let count = 0;
  function node(value: unknown, depth: number): PaneNode | null {
    if (!value || typeof value !== "object" || depth > 8) return null;
    const n = value as PaneNode;
    if (!validId(n.id) || ids.has(n.id)) return null;
    ids.add(n.id);
    if (n.type === "terminal") {
      if (++count > MAX_PANES || !terminals.some((t) => t.id === n.id))
        return null;
      return { type: "terminal", id: n.id };
    }
    if (
      n.type !== "split" ||
      (n.axis !== "x" && n.axis !== "y") ||
      !Number.isFinite(n.ratio) ||
      n.ratio < 0.15 ||
      n.ratio > 0.85
    )
      return null;
    const first = node(n.first, depth + 1),
      second = node(n.second, depth + 1);
    return first && second
      ? { type: "split", id: n.id, axis: n.axis, ratio: n.ratio, first, second }
      : null;
  }
  const root = layout.root === null ? null : node(layout.root, 0);
  if (layout.root !== null && !root) return null;
  const leaves = paneIds(root);
  if (root ? !leaves.includes(layout.activeId!) : layout.activeId !== null)
    return null;
  if (
    layout.zoomedId !== null &&
    (layout.zoomedId !== layout.activeId || !leaves.includes(layout.zoomedId!))
  )
    return null;
  return { root, activeId: layout.activeId, zoomedId: layout.zoomedId };
}
