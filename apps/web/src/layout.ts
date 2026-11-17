import { paneIds, type PaneNode, type Direction } from "@workbench/protocol";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Placement {
  node: PaneNode;
  rect: Rect;
}
export function placements(
  node: PaneNode | null,
  rect: Rect = { x: 0, y: 0, width: 1, height: 1 },
): Placement[] {
  if (!node) return [];
  const result = [{ node, rect }];
  if (node.type === "terminal") return result;
  const [a, b] =
    node.axis === "x"
      ? [
          { ...rect, width: rect.width * node.ratio },
          {
            ...rect,
            x: rect.x + rect.width * node.ratio,
            width: rect.width * (1 - node.ratio),
          },
        ]
      : [
          { ...rect, height: rect.height * node.ratio },
          {
            ...rect,
            y: rect.y + rect.height * node.ratio,
            height: rect.height * (1 - node.ratio),
          },
        ];
  return [
    ...result,
    ...placements(node.first, a),
    ...placements(node.second, b),
  ];
}
export function replace(
  node: PaneNode | null,
  id: string,
  replacement: PaneNode | null,
): PaneNode | null {
  if (!node || node.id === id) return replacement;
  if (node.type === "terminal") return node;
  const first = replace(node.first, id, replacement),
    second = replace(node.second, id, replacement);
  return first && second ? { ...node, first, second } : (first ?? second);
}
export function split(
  root: PaneNode | null,
  target: string | null,
  id: string,
  axis: "x" | "y",
): PaneNode {
  const leaf: PaneNode = { type: "terminal", id };
  if (!root || !target) return leaf;
  return replace(root, target, {
    type: "split",
    id: crypto.randomUUID(),
    axis,
    ratio: 0.5,
    first: { type: "terminal", id: target },
    second: leaf,
  })!;
}
export function neighbor(
  root: PaneNode | null,
  id: string,
  direction: Direction,
): string | undefined {
  const panes = placements(root).filter((p) => p.node.type === "terminal");
  const source = panes.find((p) => p.node.id === id)?.rect;
  if (!source) return;
  const vertical = direction === "j" || direction === "k";
  const sign = direction === "h" || direction === "k" ? -1 : 1;
  const center = (r: Rect) =>
    vertical ? r.y + r.height / 2 : r.x + r.width / 2;
  const cross = (r: Rect) =>
    vertical ? r.x + r.width / 2 : r.y + r.height / 2;
  return panes
    .filter(({ rect }) => {
      const start = vertical ? rect.y : rect.x;
      const end = start + (vertical ? rect.height : rect.width);
      const sourceStart = vertical ? source.y : source.x;
      const sourceEnd = sourceStart + (vertical ? source.height : source.width);
      const crossStart = vertical ? rect.x : rect.y;
      const crossEnd = crossStart + (vertical ? rect.width : rect.height);
      const sourceCross = vertical ? source.x : source.y;
      const sourceCrossEnd =
        sourceCross + (vertical ? source.width : source.height);
      return (
        (sign < 0 ? end <= sourceStart + 0.001 : start >= sourceEnd - 0.001) &&
        Math.min(crossEnd, sourceCrossEnd) - Math.max(crossStart, sourceCross) >
          0.001
      );
    })
    .sort((a, b) => {
      const score = (r: Rect) =>
        Math.abs(center(r) - center(source)) +
        Math.abs(cross(r) - cross(source)) * 2;
      return score(a.rect) - score(b.rect);
    })[0]?.node.id;
}
export function resizePane(
  root: PaneNode | null,
  id: string,
  direction: Direction,
): PaneNode | null {
  const axis = direction === "h" || direction === "l" ? "x" : "y";
  function boundary(
    node: PaneNode | null,
  ): Extract<PaneNode, { type: "split" }> | null {
    if (!node || node.type === "terminal") return null;
    const first = paneIds(node.first).includes(id),
      second = paneIds(node.second).includes(id);
    if (!first && !second) return null;
    return (
      boundary(first ? node.first : node.second) ??
      (node.axis === axis ? node : null)
    );
  }
  const target = boundary(root);
  if (!target) return root;
  const delta = direction === "h" || direction === "k" ? -0.05 : 0.05;
  const ratio = Math.min(
    0.85,
    Math.max(0.15, Math.round((target.ratio + delta) * 100) / 100),
  );
  return ratio === target.ratio
    ? root
    : replace(root, target.id, { ...target, ratio });
}
