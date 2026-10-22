import { readFile } from "node:fs/promises";

/**
 * Accept either the saved review response or its nested token to bind a later
 * mutation to the reviewed state. The daemon validates token shape and currency;
 * this reader throws for malformed JSON or a non-object token and treats omission as a no-op.
 */
export async function readExpectedSeatReview(file: string | undefined): Promise<Record<string, unknown> | undefined> {
  if (!file) return undefined;
  const value: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a seat review JSON object.");
  const token = (value as Record<string, unknown>).review ?? value;
  if (!token || typeof token !== "object" || Array.isArray(token)) throw new Error("Review file has no seat review token.");
  return token as Record<string, unknown>;
}
