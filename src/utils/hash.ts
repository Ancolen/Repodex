import { createHash } from "node:crypto";

/**
 * Stable hash of a chunk's content (embedding cache key).
 * SHA-256 hex; collision probability is practically zero.
 */
export function hashContent(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
