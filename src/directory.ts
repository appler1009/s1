import fs from 'node:fs/promises';
import path from 'node:path';

// ─── Interface ───────────────────────────────────────────────────────────────

export interface IndexDirectory {
  list(prefix: string): Promise<string[]>;
  readJson<T>(filePath: string): Promise<T>;
  writeJson(filePath: string, data: unknown, options?: { atomic?: boolean }): Promise<void>;
  exists(filePath: string): Promise<boolean>;
  delete(filePath: string): Promise<void>;
}

// ─── Memory (testing) ────────────────────────────────────────────────────────

export class MemoryIndexDirectory implements IndexDirectory {
  private readonly store = new Map<string, unknown>();

  async list(prefix: string): Promise<string[]> {
    const results: string[] = [];
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) results.push(key);
    }
    return results;
  }

  async readJson<T>(filePath: string): Promise<T> {
    if (!this.store.has(filePath)) {
      throw new Error(`MemoryIndexDirectory: file not found: ${filePath}`);
    }
    // Deep clone to avoid mutation bugs
    return JSON.parse(JSON.stringify(this.store.get(filePath))) as T;
  }

  async writeJson(filePath: string, data: unknown): Promise<void> {
    this.store.set(filePath, JSON.parse(JSON.stringify(data)));
  }

  async exists(filePath: string): Promise<boolean> {
    return this.store.has(filePath);
  }

  async delete(filePath: string): Promise<void> {
    this.store.delete(filePath);
  }

  /** Expose raw store for test assertions. */
  dump(): Map<string, unknown> {
    return new Map(this.store);
  }
}

// ─── Filesystem ──────────────────────────────────────────────────────────────

export class FsIndexDirectory implements IndexDirectory {
  constructor(private readonly basePath: string) {}

  private resolve(filePath: string): string {
    return path.join(this.basePath, filePath);
  }

  async list(prefix: string): Promise<string[]> {
    const dir = this.resolve(prefix);
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.map(e => path.join(prefix, e.name));
    } catch {
      return [];
    }
  }

  async readJson<T>(filePath: string): Promise<T> {
    const abs = this.resolve(filePath);
    const raw = await fs.readFile(abs, 'utf-8');
    return JSON.parse(raw) as T;
  }

  async writeJson(filePath: string, data: unknown, options?: { atomic?: boolean }): Promise<void> {
    const abs = this.resolve(filePath);
    await fs.mkdir(path.dirname(abs), { recursive: true });

    const json = JSON.stringify(data, null, 2);

    if (options?.atomic) {
      const tmp = `${abs}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await fs.writeFile(tmp, json, 'utf-8');
      await fs.rename(tmp, abs);
    } else {
      await fs.writeFile(abs, json, 'utf-8');
    }
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(filePath));
      return true;
    } catch {
      return false;
    }
  }

  async delete(filePath: string): Promise<void> {
    await fs.unlink(this.resolve(filePath));
  }
}
