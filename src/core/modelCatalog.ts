/**
 * Model catalog validation (round-15 follow-up to P-REAL-007).
 *
 * Failure mode being fixed: an orchestrator passes a wrong or dead model id
 * (typo, missing `opencode/` prefix, a config-imported provider with no
 * balance), the vendor returns a confusing error, and the orchestrator
 * concludes "the models are broken". Fix: validate against the vendor's own
 * catalog BEFORE spawning (zero quota cost), fail fast with the closest
 * alternatives, and classify vendor quota errors separately from model
 * rejections so "no balance" is never reported as "model broken".
 */

import { executeCommand } from "./executor.js";

export interface CatalogValidation {
  ok: boolean;
  /** Present when ok=false: catalog ids sharing any token with the request. */
  suggestions?: string[];
  /** Present when ok=false and the catalog could not be consulted. */
  catalogUnavailable?: string;
}

interface CatalogCacheEntry {
  ids: string[];
  fetchedAtMs: number;
}

const CATALOG_TTL_MS = 10 * 60_000;
const catalogCache = new Map<string, CatalogCacheEntry>();

export const FREE_POOL_HINT =
  "Known-working free pool: opencode/mimo-v2.5-free, opencode/hy3-free, " +
  "opencode/nemotron-3.5-lightning-free, opencode/nemotron-3-ultra-free, " +
  "opencode/muse-spark-1.2-contributor-free, opencode/ling-3.0-flash-fin-free.";

/** Parses `opencode models` output: one `provider/model` id per line. */
export function parseModelCatalog(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][^\s]*$/i.test(line));
}

/**
 * Fetches the vendor catalog with a TTL cache. Best-effort: any failure
 * resolves to undefined and callers skip validation (never block a dispatch
 * on the checker itself).
 */
export async function fetchModelCatalog(
  bin: string,
  cwd: string,
  env?: Record<string, string>,
): Promise<string[] | undefined> {
  const cached = catalogCache.get(bin);
  if (cached && Date.now() - cached.fetchedAtMs < CATALOG_TTL_MS) return cached.ids;
  try {
    const res = await executeCommand(bin, ["models"], { cwd, env });
    if (res.exitCode !== 0) return undefined;
    const ids = parseModelCatalog(res.stdout);
    if (ids.length === 0) return undefined;
    catalogCache.set(bin, { ids, fetchedAtMs: Date.now() });
    return ids;
  } catch {
    return undefined;
  }
}

/** Token-overlap suggestions: ids sharing any alphanumeric run with the request. */
export function suggestModels(requested: string, catalog: string[]): string[] {
  const tokens = requested
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .filter((token) => token.length >= 3);
  if (tokens.length === 0) return catalog.slice(0, 5);
  const scored = catalog
    .map((id) => {
      const lower = id.toLowerCase();
      const hits = tokens.filter((token) => lower.includes(token)).length;
      return { id, hits };
    })
    .filter((entry) => entry.hits > 0)
    .sort((a, b) => b.hits - a.hits);
  return scored.slice(0, 5).map((entry) => entry.id);
}

/** Full validate-with-suggestions helper used by the runner preflight. */
export async function validateModelAgainstCatalog(
  bin: string,
  cwd: string,
  requested: string,
  env?: Record<string, string>,
): Promise<CatalogValidation> {
  const catalog = await fetchModelCatalog(bin, cwd, env);
  if (!catalog) {
    return {
      ok: true,
      catalogUnavailable: "model catalog could not be fetched; skipped validation",
    };
  }
  if (catalog.includes(requested)) return { ok: true };
  return { ok: false, suggestions: suggestModels(requested, catalog) };
}
