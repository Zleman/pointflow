/**
 * OPFS persistent tile cache.
 *
 * Stores compressed tile bytes in the Origin Private File System so they
 * survive page reloads.  Gracefully degrades to a no-op in environments
 * where OPFS is unavailable (SSR, jsdom, older browsers).
 */

export interface OpfsCacheOptions {
  /** Maximum cache size in megabytes. Default: 2048. */
  maxMb?: number;
}

interface CacheEntry {
  key: string;
  size: number;
}

export class OpfsCache {
  private readonly _namespace: string;
  private readonly _maxBytes: number;
  private readonly _available: boolean;
  private _dir: FileSystemDirectoryHandle | null = null;
  private _entries: CacheEntry[] = [];
  private _totalBytes: number = 0;

  private constructor(
    namespace: string,
    maxMb: number,
    available: boolean,
    dir: FileSystemDirectoryHandle | null,
    entries: CacheEntry[],
    totalBytes: number,
  ) {
    this._namespace  = namespace;
    this._maxBytes   = maxMb * 1024 * 1024;
    this._available  = available;
    this._dir        = dir;
    this._entries    = entries;
    this._totalBytes = totalBytes;
  }

  // ── Factory ──────────────────────────────────────────────────────────────

  static async open(namespace: string, opts?: OpfsCacheOptions): Promise<OpfsCache> {
    const maxMb = opts?.maxMb ?? 2048;

    // Check OPFS availability.
    if (
      typeof navigator === "undefined" ||
      typeof (navigator as Navigator & { storage?: StorageManager }).storage?.getDirectory !== "function"
    ) {
      return new OpfsCache(namespace, maxMb, false, null, [], 0);
    }

    try {
      const root      = await navigator.storage.getDirectory();
      const nsDir     = await root.getDirectoryHandle(namespace, { create: true });
      const entries: CacheEntry[] = [];
      let totalBytes = 0;

      // Scan existing files to rebuild size tracking.
      for await (const [name, handle] of (nsDir as FileSystemDirectoryHandle & AsyncIterable<[string, FileSystemHandle]>)) {
        if (handle.kind === "file" && name.endsWith(".bin")) {
          const fileHandle = handle as FileSystemFileHandle;
          const file = await fileHandle.getFile();
          const key = name.slice(0, -4); // strip ".bin"
          entries.push({ key, size: file.size });
          totalBytes += file.size;
        }
      }

      return new OpfsCache(namespace, maxMb, true, nsDir, entries, totalBytes);
    } catch {
      return new OpfsCache(namespace, maxMb, false, null, [], 0);
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────

  get isAvailable(): boolean { return this._available; }
  get totalBytes(): number   { return this._totalBytes; }

  async has(key: string): Promise<boolean> {
    if (!this._available || !this._dir) return false;
    try {
      await this._dir.getFileHandle(this._fileName(key));
      return true;
    } catch {
      return false;
    }
  }

  async get(key: string): Promise<ArrayBuffer | null> {
    if (!this._available || !this._dir) return null;
    try {
      const fh   = await this._dir.getFileHandle(this._fileName(key));
      const file = await fh.getFile();
      return file.arrayBuffer();
    } catch {
      return null;
    }
  }

  async set(key: string, data: ArrayBuffer): Promise<void> {
    if (!this._available || !this._dir) return;
    try {
      await this._evictIfNeeded(data.byteLength);

      const fh     = await this._dir.getFileHandle(this._fileName(key), { create: true });
      const writable = await (fh as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
      await writable.write(data);
      await writable.close();

      // Update entry list.
      const existing = this._entries.findIndex(e => e.key === key);
      if (existing >= 0) {
        this._totalBytes -= this._entries[existing].size;
        this._entries.splice(existing, 1);
      }
      this._entries.push({ key, size: data.byteLength });
      this._totalBytes += data.byteLength;
    } catch {
      // OPFS write failures are non-fatal.
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _fileName(key: string): string {
    // Replace characters that are invalid in file names.
    return key.replace(/[^a-zA-Z0-9._-]/g, "_") + ".bin";
  }

  private async _evictIfNeeded(incoming: number): Promise<void> {
    if (!this._dir) return;
    // Evict oldest entries (front of list) until we have room.
    while (
      this._entries.length > 0 &&
      this._totalBytes + incoming > this._maxBytes
    ) {
      const oldest = this._entries.shift()!;
      this._totalBytes -= oldest.size;
      try {
        await this._dir.removeEntry(this._fileName(oldest.key));
      } catch {
        // Ignore removal errors.
      }
    }
  }
}
