import { randomUUID } from "node:crypto";

export const createId = (): string => randomUUID();
export const nowEpoch = (): number => Math.floor(Date.now() / 1000);
