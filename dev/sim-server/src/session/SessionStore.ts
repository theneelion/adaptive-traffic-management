import type { SessionEvent, KpiSnapshot, FinalScore, SessionFile } from "./SessionEvent.js";

export interface SessionStore {
  create(sessionId: string, meta: { mapId: string; scenario: string | null }): void;
  writeEvent(sessionId: string, event: SessionEvent): void;
  writeKpiSnapshot(sessionId: string, snapshot: KpiSnapshot): void;
  finalize(sessionId: string, score: FinalScore): void;
  read(sessionId: string): SessionFile;
}
