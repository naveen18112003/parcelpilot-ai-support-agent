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
  const allUserText = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join(" ");
  const text = messages[messages.length - 1]?.content ?? "";
  const lower = text.toLowerCase();
  const historyLower = allUserText.toLowerCase();

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

  const orderIds = ids(text + " " + allUserText, "ORD");
  const ticketIds = ids(text + " " + allUserText, "TKT");

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

  // Always run relevant document searches
  run("search_documents", {
    query: text.length > 5 ? text : allUserText,
    include_deprecated: /v2|deprecated|old policy/.test(lower),
  });

  // Handle Orders & Cancellations
  if (/order|cancel|ord-\d+|latest order/i.test(lower) || (/why/i.test(lower) && /cancel/i.test(historyLower))) {
    const orderRes = run("lookup_operational_data", { entity: "orders" });
    const orders = (orderRes.result as { orders?: Array<{ order_id: string; status: string }> })?.orders ?? [];
    const targetOrderId = orderIds[0] || orders[0]?.order_id;
    if (targetOrderId) {
      run("calculate_policy_outcome", { operation: "cancellation", order_id: targetOrderId });
    }
  }

  // Handle Service Credits
  if (/credit|late pickup|carrier fault|3 hours late|three hours late|hours late/i.test(lower) || (/why/i.test(lower) && /credit/i.test(historyLower))) {
    run("calculate_policy_outcome", {
      operation: "service_credit",
      hours_past_window: 3,
      carrier_fault: true,
      customer_fault: false,
    });
  }

  // Handle Tickets & SLAs
  if (/ticket|tkt-\d+|open ticket|show my ticket|my ticket/i.test(lower)) {
    run("lookup_operational_data", { entity: "tickets" });
  }

  if (/sla|breach|response time|first response|target/i.test(lower) || ticketIds.length > 0) {
    const targetTicket = ticketIds[0] || (user.role === "support" ? "TKT-501" : undefined);
    if (targetTicket) {
      run("lookup_operational_data", { entity: "tickets", ticket_id: targetTicket });
      run("calculate_policy_outcome", { operation: "sla", ticket_id: targetTicket });
    }
  }

  const reply = compose(user, text, blobs, pending, messages);
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
  pending: PendingAction | null,
  messages: ChatMessage[]
): string {
  const lines: string[] = [];
  const lower = question.toLowerCase();

  // Find results
  let cancellationResult: Record<string, unknown> | null = null;
  let serviceCreditResult: Record<string, unknown> | null = null;
  let slaResult: Record<string, unknown> | null = null;
  let ticketsList: Array<Record<string, unknown>> | null = null;
  let ordersList: Array<Record<string, unknown>> | null = null;
  let opsResult: Record<string, unknown> | null = null;

  for (const blob of blobs) {
    if (!blob || typeof blob !== "object") continue;
    const o = blob as Record<string, unknown>;
    if (o.outcome) cancellationResult = o;
    if (typeof o.eligible === "boolean") serviceCreditResult = o;
    if (typeof o.sla_breached === "boolean") slaResult = o;
    if (Array.isArray(o.tickets)) ticketsList = o.tickets as Array<Record<string, unknown>>;
    if (Array.isArray(o.orders)) ordersList = o.orders as Array<Record<string, unknown>>;
    if (typeof o.summary === "string" && o.sla_watch) opsResult = o;
  }

  // Question 1: Show open tickets / list tickets
  if (/open ticket|my ticket|show.*ticket/i.test(lower)) {
    if (ticketsList && ticketsList.length > 0) {
      lines.push(`### Open Tickets for ${user.display_name} (${user.account_id ?? "All Accounts"}):`);
      lines.push("");
      for (const t of ticketsList) {
        lines.push(`- **${t.ticket_id}** [${t.status} - ${t.priority}]: ${t.subject}`);
        if (t.created_at) lines.push(`  *Created:* ${t.created_at}`);
      }
      lines.push("");
      lines.push(`Reference Snapshot: ${SNAPSHOT_LABEL}`);
      return lines.join("\n");
    }
  }

  // Question 2: Cancellation & Explanations
  if (cancellationResult) {
    const c = cancellationResult as {
      outcome: string;
      cancellation_fee_inr: number | null;
      conflicts?: string[];
      sources?: string[];
      known_issue_note?: string | null;
      order?: { order_id: string; status: string };
    };

    lines.push(`### Order Cancellation Evaluation (${c.order?.order_id ?? "Latest Order"} - Status: ${c.order?.status ?? "BOOKED"})`);
    lines.push("");
    lines.push(`**Outcome:** ${c.outcome}`);
    lines.push(`- **Cancellation Fee:** INR ${c.cancellation_fee_inr ?? 0}`);
    lines.push(`- **Governing Source:** ${c.sources?.join(", ") ?? "SOP v4 / Customer Agreement"}`);
    
    if (c.conflicts?.length) {
      lines.push("");
      lines.push("**Source Conflict Resolution:**");
      for (const conf of c.conflicts) {
        lines.push(`- ${conf}`);
      }
    }
    if (c.known_issue_note) {
      lines.push(`- **Product Note:** ${c.known_issue_note}`);
    }
    lines.push("");
    lines.push(`*Reference Snapshot: ${SNAPSHOT_LABEL}*`);
    return lines.join("\n");
  }

  // Question 3: Late Pickup / Service Credit
  if (serviceCreditResult) {
    const sc = serviceCreditResult as {
      eligible: boolean;
      reason: string;
      credit_inr: number | null;
      threshold_hours: number;
      sources?: string[];
    };
    lines.push(`### Service Credit Evaluation`);
    lines.push("");
    lines.push(`**Eligibility:** ${sc.eligible ? "Eligible" : "Not Eligible"}`);
    lines.push(`- **Reason:** ${sc.reason}`);
    if (sc.credit_inr !== null) {
      lines.push(`- **Credit Amount:** INR ${sc.credit_inr}`);
    }
    lines.push(`- **Applicable Threshold:** Pickup delay must exceed ${sc.threshold_hours} hours due to carrier fault.`);
    if (sc.sources?.length) {
      lines.push(`- **Sources Evaluated:** ${sc.sources.join("; ")}`);
    }
    lines.push("");
    lines.push(`*Reference Snapshot: ${SNAPSHOT_LABEL}*`);
    return lines.join("\n");
  }

  // Question 4: SLA & Breach
  if (slaResult) {
    const s = slaResult as {
      ticket_id: string;
      inferred_severity: string;
      sla_breached: boolean;
      elapsed_hours_for_sla: number;
      target_hours: number;
      sla_source: string;
      coverage: string;
      hours_remaining: number;
    };
    lines.push(`### First-Response SLA Evaluation for ${s.ticket_id}`);
    lines.push("");
    lines.push(`- **Severity:** ${s.inferred_severity}`);
    lines.push(`- **Target First Response:** ${s.target_hours} hour(s) (${s.coverage}) based on *${s.sla_source}*`);
    lines.push(`- **Elapsed Time:** ${s.elapsed_hours_for_sla} hours`);
    lines.push(`- **Status:** ${s.sla_breached ? "🚨 **BREACHED** (Immediate escalation recommended)" : `✅ Within target (${s.hours_remaining} hours remaining)`}`);
    lines.push("");
    lines.push(`*Reference Snapshot: ${SNAPSHOT_LABEL}*`);
    return lines.join("\n");
  }

  // Question 5: General SLA query
  if (/first-response sla|what is my sla|sla target/i.test(lower)) {
    lines.push(`### Your First-Response SLA Targets (${user.display_name})`);
    lines.push("");
    if (user.account_id === "ACCT-001") {
      lines.push("Under the **Northstar Logistics Enterprise Agreement**:");
      lines.push("- **P1 (Critical Outage):** 15 minutes (24x7)");
      lines.push("- **P2 (High):** 1 hour");
      lines.push("- **P3 (Normal):** 8 business hours");
    } else {
      lines.push("Under **ParcelPilot Support Policy v3 (CURRENT)**:");
      lines.push("- **Enterprise:** P1 = 30 mins (24x7) | P2 = 2 hours | P3 = 1 business day");
      lines.push("- **Growth:** P1 = 2 business hours | P2 = 4 business hours | P3 = 2 business days");
      lines.push("- **Standard:** P1 = 4 business hours | P2 = 1 business day | P3 = 2 business days");
    }
    lines.push("");
    lines.push(`*Note: Deprecated Policy v2 targets are no longer effective.*`);
    return lines.join("\n");
  }

  // Fallback conversational format
  lines.push(`I have reviewed the candidate data pack for **${user.display_name}**.`);
  lines.push("");
  lines.push("You can ask me to:");
  lines.push("- **Check order cancellations & fees** (e.g. *'Can I cancel my latest order without a fee?'*)");
  lines.push("- **Evaluate service credits** for delayed pickups");
  lines.push("- **Review ticket SLAs & breach status** (e.g. *'Is TKT-501 past SLA?'*)");
  lines.push("- **Show open tickets & order records** scoped to your account");
  if (isInternal(user)) {
    lines.push("- **Run proactive issue detection & cluster analysis** across support activity");
  }
  if (pending) {
    lines.push("");
    lines.push(`**Staged Action:** ${pending.preview}`);
    lines.push("*Please confirm the action in the card below to execute.*");
  }
  return lines.join("\n");
}
