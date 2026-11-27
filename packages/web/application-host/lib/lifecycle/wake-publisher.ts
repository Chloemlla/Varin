export interface WakePublication {
  /** Monotonic revision from the original owner, not wall time. */
  revision: number;
  nextWakeAtMs: number | null;
}
/** Acknowledgement follows durable registration of the original Host deadline. */
export interface WakePublisher {
  currentWake(): Promise<WakePublication | null>;
  publishWake(publication: WakePublication): Promise<{ revision: number }>;
}
