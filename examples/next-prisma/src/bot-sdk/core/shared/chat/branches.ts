/**
 * Walking the Message tree (ADR 0001): the Active Branch path, sibling counts for the
 * ‹ n/m › arrows, and the newest-leaf rule for switching Branch. Pure, so it works on any
 * Messages loaded for one Conversation.
 */
export type TreeNode = { id: string; parentId: string | null; createdAt: Date };

/** Oldest first; Messages created at the same moment are ordered by id (uuidv7). */
function compareAge(a: TreeNode, b: TreeNode) {
  return a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** The Messages from a root down to `leafId`, oldest first. Empty without a leaf. */
export function pathTo<T extends TreeNode>(nodes: T[], leafId: string | null): T[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const path: T[] = [];
  for (let node = leafId ? byId.get(leafId) : undefined; node;) {
    path.push(node);
    node = node.parentId ? byId.get(node.parentId) : undefined;
  }
  return path.reverse();
}

/** Where a Message sits among its siblings (same parent; the roots are siblings too). */
export type SiblingPosition = {
  /** 0-based, oldest first. */
  index: number;
  count: number;
  previousId: string | null;
  nextId: string | null;
};

export function siblingPosition(nodes: TreeNode[], node: TreeNode): SiblingPosition {
  const siblings = nodes.filter((other) => other.parentId === node.parentId).sort(compareAge);
  const index = siblings.findIndex((other) => other.id === node.id);
  return {
    index,
    count: siblings.length,
    previousId: siblings[index - 1]?.id ?? null,
    nextId: siblings[index + 1]?.id ?? null,
  };
}

/** The newest leaf in the subtree under `id` (`id` itself when it has no children). */
export function newestLeaf(nodes: TreeNode[], id: string): string {
  const children = new Map<string, TreeNode[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
  }
  let newest: TreeNode | undefined;
  const stack = nodes.filter((node) => node.id === id);
  for (let node = stack.pop(); node; node = stack.pop()) {
    const below = children.get(node.id);
    if (below) stack.push(...below);
    else if (!newest || compareAge(node, newest) > 0) newest = node;
  }
  return newest?.id ?? id;
}
