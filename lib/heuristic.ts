import type { UserContext } from "@/lib/auth";
import { isInternal } from "@/lib/auth";
import { executeTool } from "@/lib/tools";
import { SNAPSHOT_LABEL } from "@/lib/data";
import type { AgentResult, ChatMessage, PendingAction, SourceCite, ToolCallLog } from "@/lib/types";

function ids(text: string, prefix: string): string[] {
  const re = new RegExp(`${prefix}-\\d+`, "gi");
  return [...new Set((text.match(re) || []).map((x) => x.toUpperCase()))];
}

export function heuristicReply(user: UserContext, messages: ChatMessage[]): AgentResult {
  const text = messages[messages.length - 1]?.content ?? "";
  const lower = text.toLowerCase();
  const tool_calls: ToolCallLog[] = [];
  const sources: SourceCite[] = [];
  let pending: PendingAction | null = null;
  const blobs: unknown[] = [];

  const run = (name: string, args: Record<string, unknown>) => {
    const event = executeTool(user, name, args);
    tool_calls.push(event.log);
    for (const s of event.sources) {
      if (!sources.some((x) => x.source === s.source)) sources.push(s);
    }
    if (event.pending) pending = event.pending;
    blobs.push(event.result);
    return event;
  };

  const orderIds = ids(text, "ORD");
  const ticketIds = ids(text, "TKT");

  if (/escalat|follow-?up|update ticket|create a task/.test(lower)) {
    run("stage_support_action", {
      action_type: /follow-?up|task/.test(lower)
        ? "create_followup"
        : /update/.test(lower)
          ? "update_ticket"
          : "create_escalation",
      ticket_id: ticketIds[0],
      account_id: user.account_id,
      reason: text.slice(0, 240),
      priority: /p1|critical|security|outage/.test(lower) ? "P1" : "P2",
      title: "Follow-up from chat",
    });
  }

  if (/recurring|unusual|dashboard|across tickets|issue detection|what deserves attention/.test(lower) && isInternal(user)) {
    run("ops_issue_detection", {});
  }

  const searchQuery = text;
  run("search_documents", {
    query: searchQuery,
    include_deprecated: /v2|deprecated|old policy/.test(lower),
  });

  if (orderIds.length) {
    for (const order_id of orderIds) {
      run("lookup_operational_data", { entity: "orders", order_id });
      if (/cancel/.test(lower)) run("calculate_policy_outcome", { operation: "cancellation", order_id });
      if (/credit|late pickup|carrier fault/.test(lower)) {
        run("calculate_policy_outcome", { operation: "service_credit", order_id });
      }
    }
  } else if (/cancel|order|shipment|pickup|credit/.test(lower)) {
    run("lookup_operational_data", { entity: "orders" });
  }

  if (ticketIds.length) {
    for (const ticket_id of ticketIds) {
      run("lookup_operational_data", { entity: "tickets", ticket_id });
      if (/sla|breach|response/.test(lower)) {
        run("calculate_policy_outcome", { operation: "sla", ticket_id });
      }
    }
  } else if (/ticket|sla/.test(lower)) {
    run("lookup_operational_data", { entity: "tickets" });
  }

  if (/three hours late|3 hours late|pickup is three/.test(lower) && /credit|carrier/.test(lower)) {
    run("calculate_policy_outcome", {
      operation: "service_credit",
      hours_past_window: 3,
      carrier_fault: true,
      customer_fault: false,
    });
  }

  const reply = compose(user, text, blobs, pending);
  return {
    reply,
    tool_calls,
    sources,
    pending_action: pending,
    mode: "heuristic",
  };
}

function compose(
  user: UserContext,
  question: string,
  blobs: unknown[],
  pending: PendingAction | null
): string {
  const lines: string[] = [];
  lines.push(`Reference time: **${SNAPSHOT_LABEL}**.`);
  lines.push("");

  for (const blob of blobs) {
    if (!blob || typeof blob !== "object") continue;
    const o = blob as Record<string, unknown>;
    if (o.access_denied) {
      lines.push(`**Access denied:** ${o.error}`);
      continue;
    }
    if (Array.isArray(o.results)) {
      lines.push("**Documents retrieved** (authoritative sources ranked above deprecated ones):");
      for (const r of o.results.slice(0, 4) as Array<Record<string, string>>) {
        lines.push(`- ${r.source} [${r.tier}]: ${r.excerpt.slice(0, 280)}`);
      }
      lines.push("");
    }
    if (o.outcome) {
      const c = o as {
        outcome: string;
        cancellation_fee_inr: number | null;
        conflicts?: string[];
        sources?: string[];
        known_issue_note?: string | null;
        order?: { order_id: string; status: string };
      };
      lines.push(`**Cancellation:** ${c.outcome}`);
      if (c.cancellation_fee_inr !== null) lines.push(`Fee: **INR ${c.cancellation_fee_inr}**.`);
      if (c.sources?.length) lines.push(`Sources: ${c.sources.join("; ")}.`);
      for (const conflict of c.conflicts ?? []) lines.push(`Conflict: ${conflict}`);
      if (c.known_issue_note) lines.push(`Product note: ${c.known_issue_note}`);
      lines.push("");
    }
    if (typeof o.eligible === "boolean") {
      const c = o as {
        eligible: boolean;
        reason: string;
        credit_inr: number | null;
        threshold_hours: number;
        sources?: string[];
      };
      lines.push(`**Service credit:** ${c.eligible ? "Eligible" : "Not eligible"}. ${c.reason}`);
      if (c.credit_inr !== null) lines.push(`Amount: **INR ${c.credit_inr}**.`);
      if (c.sources?.length) lines.push(`Sources: ${c.sources.join("; ")}.`);
      lines.push("");
    }
    if (typeof o.sla_breached === "boolean") {
      const c = o as {
        ticket_id: string;
        inferred_severity: string;
        sla_breached: boolean;
        elapsed_hours_for_sla: number;
        target_hours: number;
        sla_source: string;
        coverage: string;
        hours_remaining: number;
      };
      lines.push(
        `**SLA (${c.ticket_id}):** inferred ${c.inferred_severity}. Target ${c.target_hours}h (${c.coverage}) from ${c.sla_source}. Elapsed ${c.elapsed_hours_for_sla}h. ${c.sla_breached ? "**BREACHED** — recommend escalation." : `Within target (${c.hours_remaining}h remaining).`}`
      );
      lines.push("");
    }
    if (typeof o.summary === "string" && o.sla_watch) {
      lines.push(`**Ops detection:** ${o.summary}`);
      lines.push("");
    }
  }

  if (pending) {
    lines.push(`I staged a **${pending.action_type.replace(/_/g, " ")}** and have **not** executed it.`);
    lines.push(pending.preview);
    lines.push("Confirm in the card below if you want it created.");
  }

  if (lines.length < 3) {
    lines.push(
      `I searched the data pack as ${user.display_name}. Ask about a specific order, ticket, SLA, cancellation, or credit and I will use the tools again.`
    );
  }

  lines.push("");
  lines.push(`_Deterministic tool path (no GEMINI_API_KEY on the server). Question: "${question.slice(0, 180)}"_`);
  return lines.join("\n");
}
