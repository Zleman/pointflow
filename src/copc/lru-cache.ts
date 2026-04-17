/**
 * Doubly-linked-list LRU cache with O(1) get, set, has, and delete.
 * Evicts the least-recently-used entry when capacity is exceeded.
 */

interface Node<K, V> {
  key: K;
  value: V;
  prev: Node<K, V> | null;
  next: Node<K, V> | null;
}

export class LruCache<K, V> {
  private readonly _max: number;
  private readonly _map: Map<K, Node<K, V>>;
  // Sentinel nodes (dummy head/tail) simplify list manipulation.
  private readonly _head: Node<K, V>;
  private readonly _tail: Node<K, V>;

  constructor(maxEntries: number) {
    if (maxEntries < 1) throw new RangeError("LruCache maxEntries must be >= 1");
    this._max  = maxEntries;
    this._map  = new Map();
    this._head = { key: null as unknown as K, value: null as unknown as V, prev: null, next: null };
    this._tail = { key: null as unknown as K, value: null as unknown as V, prev: null, next: null };
    this._head.next = this._tail;
    this._tail.prev = this._head;
  }

  get size(): number {
    return this._map.size;
  }

  has(key: K): boolean {
    return this._map.has(key);
  }

  get(key: K): V | undefined {
    const node = this._map.get(key);
    if (!node) return undefined;
    this._moveToFront(node);
    return node.value;
  }

  set(key: K, value: V): void {
    const existing = this._map.get(key);
    if (existing) {
      existing.value = value;
      this._moveToFront(existing);
      return;
    }

    const node: Node<K, V> = { key, value, prev: null, next: null };
    this._map.set(key, node);
    this._insertFront(node);

    if (this._map.size > this._max) {
      this._evictLru();
    }
  }

  delete(key: K): void {
    const node = this._map.get(key);
    if (!node) return;
    this._map.delete(key);
    this._unlink(node);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _unlink(node: Node<K, V>): void {
    node.prev!.next = node.next;
    node.next!.prev = node.prev;
    node.prev = null;
    node.next = null;
  }

  private _insertFront(node: Node<K, V>): void {
    node.next = this._head.next;
    node.prev = this._head;
    this._head.next!.prev = node;
    this._head.next = node;
  }

  private _moveToFront(node: Node<K, V>): void {
    this._unlink(node);
    this._insertFront(node);
  }

  private _evictLru(): void {
    const lru = this._tail.prev!;
    if (lru === this._head) return; // empty
    this._map.delete(lru.key);
    this._unlink(lru);
  }
}
