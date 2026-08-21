import documents from "@/data/documents.json";
import type { DocumentChunk, SourceCite } from "@/lib/types";
import type { UserContext } from "@/lib/auth";
import { isInternal } from "@/lib/auth";

const CHUNKS = documents.chunks as DocumentChunk[];

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9+\-/%]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

export function searchDocuments(opts: {
  query: string;
  user: UserContext;
  topK?: number;
  includeDeprecated?: boolean;
}): { results: Array<DocumentChunk & { score: number }>; sources: SourceCite[] } {
  const topK = opts.topK ?? 6;
  const queryTokens = tokenize(opts.query);
  const includeDeprecated = opts.includeDeprecated ?? false;

  const scored = CHUNKS.filter((chunk) => {
    if (!includeDeprecated && chunk.tier === "deprecated") return false;
    if (
      chunk.doc_type === "customer_agreement" &&
      chunk.account_id &&
      !isInternal(opts.user) &&
      opts.user.account_id !== chunk.account_id
    ) {
      return false;
    }
    return true;
  }).map((chunk) => {
    const hay = tokenize(
      `${chunk.source_short_name} ${chunk.doc_type} ${chunk.account_id ?? ""} ${chunk.text}`
    );
    const counts = new Map<string, number>();
    for (const t of hay) counts.set(t, (counts.get(t) ?? 0) + 1);

    let score = 0;
    for (const t of queryTokens) {
      const tf = counts.get(t) ?? 0;
      if (tf > 0) score += 1 + Math.log(1 + tf);
    }

    if (chunk.tier === "authoritative") score *= 1.25;
    if (chunk.tier === "deprecated") score *= 0.35;
    if (chunk.doc_type === "customer_agreement") {
      const mentionsAccount =
        (chunk.account_id && opts.query.toUpperCase().includes(chunk.account_id)) ||
        opts.query.toLowerCase().includes((chunk.source_short_name || "").split(" ")[0].toLowerCase());
      const ownAgreement = opts.user.account_id === chunk.account_id;
      if (mentionsAccount || ownAgreement) score *= 1.6;
    }
    return { ...chunk, score };
  });

  const results = scored
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  const sources: SourceCite[] = [];
  for (const r of results) {
    if (!sources.some((s) => s.source === r.source_short_name)) {
      sources.push({
        source: r.source_short_name,
        tier: r.tier,
        trust_note: r.trust_note,
        page: r.page_number,
      });
    }
  }

  return { results, sources };
}
