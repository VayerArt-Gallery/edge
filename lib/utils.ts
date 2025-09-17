/** JSON response helper with no-store to avoid caching at edges. */
export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

/** Extract trailing numeric ID from a Shopify GID string. */
export function extractNumericId(gid: string) {
  const m = gid?.match(/(\d+)$/);
  return m ? Number(m[1]) : null;
}

/** Split an array into fixed-size chunks. */
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** URL-safe slug; for IDs and not user-facing names. */
export function toSlug(input: string) {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Small deterministic hash for list item keys. */
export function stableKeyFrom(str: string) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return `k${Math.abs(h)}`;
}

/** Deterministic 14-digit numeric ID for compact document IDs. */
export function numericId14FromString(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let hash = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x00000100000001b3n;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= BigInt(bytes[i]!);
    hash = (hash * FNV_PRIME) & 0xffffffffffffffffn;
  }
  const MASKED = hash & 0xffffffffffffffffn;
  const MOD = 99_999_999_999_999n;
  const num = (MASKED % MOD) + 1n;
  return num.toString().padStart(14, "0");
}

/** Constant-time compare for short secrets. */
export function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let res = 0;
  for (let i = 0; i < a.length; i++) res |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return res === 0;
}

/** Run promise-returning tasks with a fixed concurrency. */
export async function runWithConcurrency(
  tasks: Array<() => Promise<unknown>>,
  limit: number,
) {
  if (tasks.length === 0) return;
  let i = 0;
  const workers: Promise<void>[] = [];
  const run = async () => {
    for (;;) {
      const idx = i++;
      if (idx >= tasks.length) break;
      const task = tasks[idx]!;
      try {
        await task();
      } catch {
        // handled by caller
      }
    }
  };
  const n = Math.min(Math.max(1, limit), tasks.length);
  for (let k = 0; k < n; k++) workers.push(run());
  await Promise.all(workers);
}

