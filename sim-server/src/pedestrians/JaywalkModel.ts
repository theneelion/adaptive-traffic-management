export function jaywalkProbability(waitS: number, patienceS: number): number {
  if (waitS <= patienceS) return 0;
  const excess = waitS - patienceS;
  return Math.min(0.95, 1 - Math.exp(-excess / patienceS));
}
