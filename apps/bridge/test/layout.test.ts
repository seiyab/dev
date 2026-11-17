import assert from "node:assert/strict";
import { test } from "node:test";
import { paneIds, parseLayout, type PaneNode } from "@workbench/protocol";
import {
  neighbor,
  placements,
  replace,
  resizePane,
} from "../../web/src/layout.js";

const tree: PaneNode = {
  type: "split",
  id: "outer",
  axis: "x",
  ratio: 0.5,
  first: { type: "terminal", id: "left" },
  second: {
    type: "split",
    id: "inner",
    axis: "y",
    ratio: 0.5,
    first: { type: "terminal", id: "top" },
    second: { type: "terminal", id: "bottom" },
  },
};

test("nested layout navigation, removal and boundary limits preserve the other panes", () => {
  assert.equal(neighbor(tree, "left", "h"), undefined);
  assert.equal(neighbor(tree, "left", "j"), undefined);
  assert.equal(neighbor(tree, "left", "k"), undefined);
  assert.equal(neighbor(tree, "top", "j"), "bottom");
  assert.equal(neighbor(tree, "bottom", "k"), "top");
  assert.equal(neighbor(tree, "bottom", "h"), "left");
  const resized = resizePane(tree, "bottom", "k")!;
  assert.equal(
    placements(resized).find((p) => p.node.id === "left")!.rect.width,
    0.5,
  );
  assert.equal(
    placements(resized).find((p) => p.node.id === "top")!.rect.height,
    0.45,
  );
  const removed = replace(resized, "bottom", null)!;
  assert.deepEqual(paneIds(removed), ["left", "top"]);
  assert.equal(
    placements(removed).find((p) => p.node.id === "top")!.rect.height,
    1,
  );
  let limited: PaneNode | null = tree;
  for (let i = 0; i < 30; i++) limited = resizePane(limited, "bottom", "j");
  assert.equal(
    placements(limited).find((p) => p.node.id === "top")!.rect.height,
    0.85,
  );
});

test("layout validation rejects dangling focus, invalid zoom and unknown terminal references", () => {
  const terminals = paneIds(tree).map((id) => ({
    id,
    title: id,
    started: false,
  }));
  const layout = { root: tree, activeId: "top", zoomedId: null };
  assert.ok(parseLayout(layout, terminals));
  assert.equal(
    parseLayout({ ...layout, activeId: "missing" }, terminals),
    null,
  );
  assert.equal(parseLayout({ ...layout, zoomedId: "bottom" }, terminals), null);
  assert.equal(parseLayout(layout, terminals.slice(1)), null);
  assert.deepEqual(
    parseLayout({ root: null, activeId: null, zoomedId: null }, []),
    { root: null, activeId: null, zoomedId: null },
  );
});
