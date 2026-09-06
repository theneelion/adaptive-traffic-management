import { describe, it, expect, vi, afterEach } from "vitest";
import { AiSignalClient } from "../../src/signals/AiSignalClient";

describe("AiSignalClient", () => {
  afterEach(() => vi.restoreAllMocks());

  it("posts the request and returns the parsed decision", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ phaseId: "EW_through", controller: "rule_based" })
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new AiSignalClient("http://localhost:8000");
    const result = await client.decide({
      intersectionId: "int_1",
      currentPhaseId: "NS_through",
      timeInPhaseMs: 5000,
      phaseCandidates: [{ phaseId: "NS_through", queueLength: 0, waitS: 0 }]
    });

    expect(result.phaseId).toBe("EW_through");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8000/signal-decision",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("throws when the response is not ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const client = new AiSignalClient("http://localhost:8000");
    await expect(
      client.decide({ intersectionId: "int_1", currentPhaseId: "NS_through", timeInPhaseMs: 0, phaseCandidates: [] })
    ).rejects.toThrow();
  });
});
