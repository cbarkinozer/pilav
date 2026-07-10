import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REGISTRY_PATH = join(homedir(), ".pilav", "projects.json");

export class ProjectRegistry {
  private projects: Record<string, string>;

  constructor() {
    mkdirSync(join(homedir(), ".pilav"), { recursive: true });
    this.projects = this.load();
  }

  private load(): Record<string, string> {
    try {
      if (existsSync(REGISTRY_PATH)) {
        return JSON.parse(readFileSync(REGISTRY_PATH, "utf-8")) as Record<string, string>;
      }
    } catch {}
    return {};
  }

  private save(): void {
    writeFileSync(REGISTRY_PATH, JSON.stringify(this.projects, null, 2), "utf-8");
  }

  set(name: string, path: string): void {
    this.projects[name.toLowerCase()] = path;
    this.save();
  }

  get(name: string): string | undefined {
    return this.projects[name.toLowerCase()];
  }

  list(): Array<{ name: string; path: string }> {
    return Object.entries(this.projects).map(([name, path]) => ({ name, path }));
  }

  remove(name: string): boolean {
    const key = name.toLowerCase();
    if (!(key in this.projects)) return false;
    delete this.projects[key];
    this.save();
    return true;
  }
}
