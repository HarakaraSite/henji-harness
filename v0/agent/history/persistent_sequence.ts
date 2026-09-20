import { createHash } from 'node:crypto';

export type PersistentSequenceRoot = string | null;

export interface PersistentSequenceRevision {
  readonly root: PersistentSequenceRoot;
  /** Lineage only. Materialization never follows this reference. */
  readonly parentRoot: PersistentSequenceRoot;
  readonly itemCount: number;
}

export type PersistentSequenceNode = SequenceLeaf | SequenceBranch;
type SequenceNode = PersistentSequenceNode;
export interface SequenceLeaf {
  readonly kind: 'leaf';
  readonly digest: string;
  readonly height: 1;
  readonly count: 1;
  readonly value: string;
}
export interface SequenceBranch {
  readonly kind: 'branch';
  readonly digest: string;
  readonly height: number;
  readonly count: number;
  readonly left: string;
  readonly right: string;
}

export interface PersistentSequenceNodeSummary {
  readonly height: number;
  readonly count: number;
}

const hash = (value: string): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;

export const validatePersistentSequenceNode = (
  node: PersistentSequenceNode,
  resolveChild: (digest: string) => PersistentSequenceNodeSummary | undefined,
): void => {
  if (node.kind === 'leaf') {
    if (
      node.height !== 1 || node.count !== 1 ||
      hash(`leaf\0${node.value.length}\0${node.value}`) !== node.digest
    ) throw new TypeError('invalid persistent sequence leaf');
    return;
  }
  const left = resolveChild(node.left);
  const right = resolveChild(node.right);
  if (
    left === undefined || right === undefined ||
    !Number.isSafeInteger(node.height) || node.height < 2 ||
    !Number.isSafeInteger(node.count) || node.count < 2 ||
    hash(`branch\0${node.left}\0${node.right}\0${node.count}\0${node.height}`) !==
      node.digest ||
    node.height !== Math.max(left.height, right.height) + 1 ||
    node.count !== left.count + right.count ||
    Math.abs(left.height - right.height) > 1
  ) throw new TypeError('invalid persistent sequence branch');
};

/** Content-addressed immutable AVL rope. Edits path-copy nodes from the current root. */
export class PersistentSequenceStore {
  readonly #nodes = new Map<string, SequenceNode>();

  get nodeCount(): number {
    return this.#nodes.size;
  }

  count(root: PersistentSequenceRoot): number {
    return root === null ? 0 : this.#node(root).count;
  }

  height(root: PersistentSequenceRoot): number {
    return root === null ? 0 : this.#node(root).height;
  }

  fromValues(values: readonly string[]): PersistentSequenceRoot {
    if (values.length === 0) return null;
    const build = (start: number, end: number): string => {
      if (end - start === 1) return this.#leaf(values[start]);
      const middle = start + Math.floor((end - start) / 2);
      return this.#branch(build(start, middle), build(middle, end));
    };
    return build(0, values.length);
  }

  splice(
    base: PersistentSequenceRoot,
    start: number,
    deleteCount: number,
    insertions: readonly string[],
  ): PersistentSequenceRevision {
    const count = this.count(base);
    if (
      !Number.isSafeInteger(start) || !Number.isSafeInteger(deleteCount) ||
      start < 0 || deleteCount < 0 || start > count || start + deleteCount > count ||
      insertions.some((value) => value.length === 0 || value.includes('\0'))
    ) throw new TypeError('invalid persistent sequence splice');
    const [prefix, tail] = this.#split(base, start);
    const [, suffix] = this.#split(tail, deleteCount);
    const inserted = this.fromValues(insertions);
    const root = this.#concat(this.#concat(prefix, inserted), suffix);
    return { root, parentRoot: base, itemCount: this.count(root) };
  }

  materialize(root: PersistentSequenceRoot): readonly string[] {
    const values: string[] = [];
    const visit = (ref: PersistentSequenceRoot): void => {
      if (ref === null) return;
      const node = this.#node(ref);
      if (node.kind === 'leaf') values.push(node.value);
      else {
        visit(node.left);
        visit(node.right);
      }
    };
    visit(root);
    return values;
  }

  exportNodes(root: PersistentSequenceRoot): readonly PersistentSequenceNode[] {
    const nodes: PersistentSequenceNode[] = [];
    const visited = new Set<string>();
    const visit = (ref: PersistentSequenceRoot): void => {
      if (ref === null || visited.has(ref)) return;
      visited.add(ref);
      const node = this.#node(ref);
      if (node.kind === 'branch') {
        visit(node.left);
        visit(node.right);
      }
      nodes.push(structuredClone(node));
    };
    visit(root);
    return nodes;
  }

  /** Returns only path-copied nodes not already durable; known subtrees are not traversed. */
  exportUnseenNodes(
    root: PersistentSequenceRoot,
    knownDigests: ReadonlySet<string>,
  ): readonly PersistentSequenceNode[] {
    const nodes: PersistentSequenceNode[] = [];
    const visited = new Set<string>();
    const visit = (ref: PersistentSequenceRoot): void => {
      if (ref === null || knownDigests.has(ref) || visited.has(ref)) return;
      visited.add(ref);
      const node = this.#node(ref);
      if (node.kind === 'branch') {
        visit(node.left);
        visit(node.right);
      }
      nodes.push(structuredClone(node));
    };
    visit(root);
    return nodes;
  }

  importNodes(nodes: readonly PersistentSequenceNode[]): void {
    for (const node of nodes) {
      const existing = this.#nodes.get(node.digest);
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(node)) {
        throw new Error('persistent sequence digest collision');
      }
      this.#nodes.set(node.digest, structuredClone(node));
    }
    for (const node of nodes) {
      validatePersistentSequenceNode(node, (digest) => this.#nodes.get(digest));
    }
  }

  #node(ref: string): SequenceNode {
    const node = this.#nodes.get(ref);
    if (node === undefined) throw new Error(`unknown persistent sequence node: ${ref}`);
    return node;
  }

  #leaf(value: string): string {
    if (!value || value.includes('\0')) throw new TypeError('invalid persistent sequence value');
    const digest = hash(`leaf\0${value.length}\0${value}`);
    if (!this.#nodes.has(digest)) {
      this.#nodes.set(digest, { kind: 'leaf', digest, height: 1, count: 1, value });
    }
    return digest;
  }

  #branch(left: string, right: string): string {
    const leftNode = this.#node(left);
    const rightNode = this.#node(right);
    const height = Math.max(leftNode.height, rightNode.height) + 1;
    const count = leftNode.count + rightNode.count;
    const digest = hash(`branch\0${left}\0${right}\0${count}\0${height}`);
    if (!this.#nodes.has(digest)) {
      this.#nodes.set(digest, { kind: 'branch', digest, height, count, left, right });
    }
    return digest;
  }

  #split(
    root: PersistentSequenceRoot,
    index: number,
  ): [PersistentSequenceRoot, PersistentSequenceRoot] {
    if (root === null) return [null, null];
    const node = this.#node(root);
    if (node.kind === 'leaf') return index === 0 ? [null, root] : [root, null];
    const leftCount = this.#node(node.left).count;
    if (index < leftCount) {
      const [prefix, leftTail] = this.#split(node.left, index);
      return [prefix, this.#concat(leftTail, node.right)];
    }
    if (index === leftCount) return [node.left, node.right];
    const [rightPrefix, suffix] = this.#split(node.right, index - leftCount);
    return [this.#concat(node.left, rightPrefix), suffix];
  }

  #concat(left: PersistentSequenceRoot, right: PersistentSequenceRoot): PersistentSequenceRoot {
    if (left === null) return right;
    if (right === null) return left;
    const leftNode = this.#node(left);
    const rightNode = this.#node(right);
    if (leftNode.height > rightNode.height + 1) {
      if (leftNode.kind !== 'branch') throw new Error('invalid persistent sequence balance');
      return this.#balance(this.#branch(leftNode.left, this.#concat(leftNode.right, right)!));
    }
    if (rightNode.height > leftNode.height + 1) {
      if (rightNode.kind !== 'branch') throw new Error('invalid persistent sequence balance');
      return this.#balance(this.#branch(this.#concat(left, rightNode.left)!, rightNode.right));
    }
    return this.#branch(left, right);
  }

  #balance(root: string): string {
    const node = this.#node(root);
    if (node.kind !== 'branch') return root;
    const left = this.#node(node.left);
    const right = this.#node(node.right);
    if (left.height > right.height + 1) {
      if (left.kind !== 'branch') throw new Error('invalid persistent sequence left branch');
      const ll = this.#node(left.left);
      const lr = this.#node(left.right);
      if (ll.height >= lr.height) {
        return this.#branch(left.left, this.#branch(left.right, node.right));
      }
      if (lr.kind !== 'branch') throw new Error('invalid persistent sequence left rotation');
      return this.#branch(
        this.#branch(left.left, lr.left),
        this.#branch(lr.right, node.right),
      );
    }
    if (right.height > left.height + 1) {
      if (right.kind !== 'branch') throw new Error('invalid persistent sequence right branch');
      const rl = this.#node(right.left);
      const rr = this.#node(right.right);
      if (rr.height >= rl.height) {
        return this.#branch(this.#branch(node.left, right.left), right.right);
      }
      if (rl.kind !== 'branch') throw new Error('invalid persistent sequence right rotation');
      return this.#branch(
        this.#branch(node.left, rl.left),
        this.#branch(rl.right, right.right),
      );
    }
    return root;
  }
}
