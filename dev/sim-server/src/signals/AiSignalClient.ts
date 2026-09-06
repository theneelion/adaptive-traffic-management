import type { SignalDecisionRequest } from "shared-contracts/generated/ts/signal-decision.schema";
import type { SignalDecisionResponse } from "shared-contracts/generated/ts/signal-decision.schema";

export class AiSignalClient {
  constructor(private readonly baseUrl: string) {}

  async decide(req: SignalDecisionRequest): Promise<SignalDecisionResponse> {
    const res = await fetch(`${this.baseUrl}/signal-decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req)
    });
    if (!res.ok) throw new Error(`signal-decision request failed: ${res.status}`);
    return (await res.json()) as SignalDecisionResponse;
  }
}
