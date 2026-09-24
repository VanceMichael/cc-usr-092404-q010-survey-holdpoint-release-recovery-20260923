import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export class DomainError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string) => new DomainError(400, code, message);
export const notFound = (code: string, message: string) => new DomainError(404, code, message);
export const conflict = (code: string, message: string) => new DomainError(409, code, message);
export const forbidden = (code: string, message: string) => new DomainError(403, code, message);

export type Role = "SURVEY_REVIEWER" | "SUPERVISOR";

export interface ControlPoint {
  code: string;
  x: number;
  y: number;
  z: number;
}

export interface ObservationInput {
  pointCode: string;
  sequenceNo?: number | null;
  x?: number | null;
  y?: number | null;
  z?: number | null;
  displacementMm?: number | null;
  settlementMm?: number | null;
}

export type Row = Record<string, any>;

export const newId = (): string => randomUUID();

export type Db = DatabaseSync;

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function recordEvent(
  db: Db,
  eventType: string,
  stepId: string | null,
  payload: unknown,
  atIso: string,
): void {
  db.prepare(
    `INSERT INTO domain_events (id, event_type, step_id, payload, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(newId(), eventType, stepId, JSON.stringify(payload ?? {}), atIso);
}

/** 把行解析成对象数组字段 */
export function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed : [];
}

export function parseControlPoints(value: string): ControlPoint[] {
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed : [];
}
