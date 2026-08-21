export type Severity = "P1" | "P2" | "P3";
export type SourceTier = "authoritative" | "deprecated" | "historical_context";

export type DocumentChunk = {
  chunk_id: string;
  source_filename: string;
  source_short_name: string;
  tier: SourceTier;
  trust_note: string;
  doc_type: string;
  account_id: string | null;
  status: string;
  page_number: number;
  text: string;
};

export type ToolCallLog = {
  tool: string;
  args: Record<string, unknown>;
  result_summary: string;
};

export type PendingAction = {
  token: string;
  action_type: "create_escalation" | "update_ticket" | "create_followup";
  preview: string;
  params: Record<string, unknown>;
};

export type SourceCite = {
  source: string;
  tier: SourceTier;
  trust_note: string;
  page?: number;
};

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type AgentResult = {
  reply: string;
  tool_calls: ToolCallLog[];
  sources: SourceCite[];
  pending_action: PendingAction | null;
  mode: "gemini" | "heuristic";
};
