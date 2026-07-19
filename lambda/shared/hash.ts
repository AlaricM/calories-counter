import { createHash } from "node:crypto";

/**
 * Stable, unsalted SHA-256 (hex) of an API key. Salting is unnecessary because
 * the key itself is high-entropy random (24 bytes / 192 bits), so there is no
 * dictionary/rainbow-table risk. Shared by the Lambda (auth) and the admin CLI
 * (user creation) so both sides hash identically.
 */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key.trim()).digest("hex");
}
