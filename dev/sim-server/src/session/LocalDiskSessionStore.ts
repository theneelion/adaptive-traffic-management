import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { SessionStore } from "./SessionStore.js";
import type { SessionEvent, KpiSnapshot, FinalScore, SessionFile } from "./SessionEvent.js";

export class LocalDiskSessionStore implements SessionStore {
  constructor(private readonly baseDir: string) {
    mkdirSync(baseDir, { recursive: true });
  }

  private filePath(sessionId: string): string {
    return path.join(this.baseDir, `${sessionId}.json`);
  }

  create(sessionId: string, meta: { mapId: string; scenario: string | null }): void {
    const file: SessionFile = {
      sessionId,
      startedAt: new Date().toISOString(),
      mapId: meta.mapId,
      scenario: meta.scenario,
      participants: [],
      events: [],
      kpiSnapshots: [],
      finalScore: null
    };
    this.write(file);
  }

  writeEvent(sessionId: string, event: SessionEvent): void {
    const file = this.read(sessionId);
    file.events.push(event);
    this.write(file);
  }

  writeKpiSnapshot(sessionId: string, snapshot: KpiSnapshot): void {
    const file = this.read(sessionId);
    file.kpiSnapshots.push(snapshot);
    this.write(file);
  }

  finalize(sessionId: string, score: FinalScore): void {
    const file = this.read(sessionId);
    file.finalScore = score;
    this.write(file);
  }

  read(sessionId: string): SessionFile {
    const filePath = this.filePath(sessionId);
    if (!existsSync(filePath)) throw new Error(`No session found for ${sessionId}`);
    return JSON.parse(readFileSync(filePath, "utf-8")) as SessionFile;
  }

  private write(file: SessionFile): void {
    writeFileSync(this.filePath(file.sessionId), JSON.stringify(file, null, 2));
  }
}
