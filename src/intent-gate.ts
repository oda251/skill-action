import { readFileSync } from "node:fs";
import { ok, err, type Result } from "neverthrow";
import type { Citation, EvidencedInput, InputEntry } from "./types.js";

export interface VerificationResult {
  key: string;
  citation: Citation;
  ok: boolean;
  detail?: string;
}

export type EvidenceVerifier = (
  inputs: Record<string, { entry: EvidencedInput; key: string }>,
  transcriptPath?: string,
) => Promise<VerificationResult[]>;

export function createDefaultVerifier(): EvidenceVerifier {
  return async (inputs, transcriptPath) => {
    const results: VerificationResult[] = [];

    for (const { key, entry } of Object.values(inputs)) {
      for (const citation of entry.citations) {
        if (!citation.excerpt) continue;
        results.push(await verifyCitation(key, citation, transcriptPath));
      }
    }

    return results;
  };
}

/**
 * Intent Gate: verify all evidenced inputs before task creation.
 * Returns Ok(undefined) if all pass, Err(message) if any fail.
 */
export async function runIntentGate(
  inputs: Record<string, InputEntry>,
  verifier: EvidenceVerifier,
  transcriptPath?: string,
): Promise<Result<undefined, string>> {
  const evidenced: Record<string, { entry: EvidencedInput; key: string }> = {};
  for (const [k, entry] of Object.entries(inputs)) {
    if (entry.type === "evidenced") evidenced[k] = { entry, key: k };
  }

  if (Object.keys(evidenced).length === 0) return ok(undefined);

  const results = await verifier(evidenced, transcriptPath);
  const failed = results.filter((r): r is typeof r & { detail: string } => !r.ok && !!r.detail);

  if (failed.length > 0) {
    return err(`Intent Gate failed: ${failed.map((r) => `${r.key}: ${r.detail}`).join("; ")}`);
  }

  return ok(undefined);
}

async function verifyCitation(
  key: string,
  citation: Citation,
  transcriptPath?: string,
): Promise<VerificationResult> {
  if (citation.type === "transcript") {
    return verifyTextFile(key, citation, transcriptPath);
  }

  if (citation.type === "command") {
    return { key, citation, ok: true };
  }

  if (isFilePath(citation.source)) {
    if (!isTextFile(citation.source)) {
      return { key, citation, ok: true };
    }
    return verifyTextFile(key, citation, citation.source);
  }

  return verifyUri(key, citation);
}

function verifyTextFile(
  key: string,
  citation: Citation,
  path?: string,
): VerificationResult {
  if (!path) {
    return { key, citation, ok: false, detail: "source path not available" };
  }

  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return { key, citation, ok: false, detail: `cannot read: ${path}` };
  }

  const found = content.includes(citation.excerpt);
  return { key, citation, ok: found, detail: found ? undefined : `excerpt not found in ${path}` };
}

async function verifyUri(
  key: string,
  citation: Citation & { type: "uri" },
): Promise<VerificationResult> {
  try {
    const res = await fetch(citation.source, { method: "HEAD" });
    if (res.ok) return { key, citation, ok: true };
    return { key, citation, ok: false, detail: `${citation.source} returned ${res.status}` };
  } catch {
    return { key, citation, ok: false, detail: `cannot reach: ${citation.source}` };
  }
}

function isFilePath(source: string): boolean {
  return !source.startsWith("http://") && !source.startsWith("https://");
}

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".jsonl", ".yaml", ".yml", ".toml",
  ".html", ".htm", ".css", ".scss",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".scala",
  ".c", ".cpp", ".h", ".hpp", ".cs",
  ".sh", ".bash", ".zsh", ".fish",
  ".sql", ".graphql", ".gql",
  ".xml", ".svg", ".csv", ".tsv",
  ".env", ".ini", ".cfg", ".conf",
  ".lock", ".log",
  ".vue", ".svelte", ".astro",
]);

function isTextFile(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return TEXT_EXTENSIONS.has(path.slice(dot).toLowerCase());
}
