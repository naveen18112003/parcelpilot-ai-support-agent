import type { UserContext } from "@/lib/auth";
import { isInternal } from "@/lib/auth";
import { AccessDeniedError, listAccounts, listOrders, listTickets } from "@/lib/access";
import { searchDocuments } from "@/lib/search";
import {
  evaluateCancellation,
  evaluateServiceCredit,
  evaluateSla,
} from "@/lib/policy";
import { detectIssues, summaryStats } from "@/lib/analytics";
import { stageAction } from "@/lib/actions";
import { SNAPSHOT_LABEL } from "@/lib/data";
import type { PendingAction, SourceCite, ToolCallLog } from "@/lib/types";

export const TOOL_DECLARATIONS = [
  {
    name: "search_documents",
    description:
      "Search current policies, SOPs, product docs, and customer agreements. Deprecated policy is excluded unless include_deprecated=true. Customer agreements for other accounts are hidden from customer users.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language search query." },
        include_deprecated: {
          type: "boolean",
          description: "Include Support Policy v2. Default false.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "lookup_operational_data",
    description:
      "Look up accounts, orders, or tickets from the assessment workbook. Access is enforced server-side and scoped to the authenticated user.",
    parameters: {
      type: "object",
      properties: {
        entity: {
          type: "string",
          enum: ["account", "orders", "tickets"],
        },
        account_id: { type: "string" },
        order_id: { type: "string" },
        ticket_id: { type: "string" },
      },
      required: ["entity"],
    },
  },
  {
    name: "calculate_policy_outcome",
    description:
      "Deterministic calculation for cancellation fees, failed-pickup credits, or SLA first-response status. Do not compute these yourself.",
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["cancellation", "service_credit", "sla"],
        },
        order_id: { type: "string" },
        ticket_id: { type: "string" },
        hours_past_window: { type: "number" },
        carrier_fault: { type: "boolean" },
        customer_fault: { type: "boolean" },
      },
      required: ["operation"],
    },
  },
  {
    name: "stage_support_action",
    description:
      "Prepare a state-changing action (escalation, ticket update, follow-up). This only STAGES the action. The user must confirm in the UI before it executes.",
    parameters: {
      type: "object",
      properties: {
        action_type: {
          type: "string",
          enum: ["create_escalation", "update_ticket", "create_followup"],
        },
        ticket_id: { type: "string" },
        account_id: { type: "string" },
        reason: { type: "string" },
        priority: { type: "string" },
        notes: { type: "string" },
        title: { type: "string" },
        updates: { type: "object" },
      },
      required: ["action_type"],
    },
  },
  {
    name: "ops_issue_detection",
    description:
      "Internal only. Surface SLA risk, ticket clusters, known-issue links, and unusual order patterns.",
    parameters: { type: "object", properties: {} },
  },
];

export function toolsFor(user: UserContext) {
  if (isInternal(user)) return TOOL_DECLARATIONS;
  return TOOL_DECLARATIONS.filter((t) => t.name !== "ops_issue_detection");
}

export type ToolEvent = {
  log: ToolCallLog;
  sources: SourceCite[];
  pending?: PendingAction;
  result: unknown;
};

export function executeTool(
  user: UserContext,
  name: string,
  rawArgs: Record<string, unknown>
): ToolEvent {
  const args = rawArgs ?? {};
  try {
    if (name === "search_documents") {
      const { results, sources } = searchDocuments({
        query: String(args.query ?? ""),
        user,
        includeDeprecated: Boolean(args.include_deprecated),
      });
      const slim = results.map((r) => ({
        source: r.source_short_name,
        tier: r.tier,
        trust_note: r.trust_note,
        status: r.status,
        account_id: r.account_id,
        page: r.page_number,
        excerpt: r.text.replace(/\s+/g, " ").slice(0, 900),
      }));
      return {
        log: {
          tool: name,
          args,
          result_summary: `${slim.length} chunks from ${sources.length} source(s)`,
        },
        sources,
        result: {
          snapshot: SNAPSHOT_LABEL,
          hierarchy:
            "Signed customer agreement > current support policy / SOP / product guide > deprecated policy > historical tickets.",
          results: slim,
        },
      };
    }

    if (name === "lookup_operational_data") {
      const entity = String(args.entity ?? "");
      const account_id = args.account_id ? String(args.account_id) : undefined;
      const order_id = args.order_id ? String(args.order_id) : undefined;
      const ticket_id = args.ticket_id ? String(args.ticket_id) : undefined;
      if (entity === "account") {
        const accounts = listAccounts(user, account_id);
        return {
          log: { tool: name, args, result_summary: `${accounts.length} account(s)` },
          sources: [],
          result: { accounts },
        };
      }
      if (entity === "orders") {
        const orders = listOrders(user, { accountId: account_id, orderId: order_id });
        return {
          log: { tool: name, args, result_summary: `${orders.length} order(s)` },
          sources: [],
          result: {
            orders,
            note: "Historical ticket resolutions are not order truth. Treat KI-211 for SwiftShip BOOKED status.",
          },
        };
      }
      if (entity === "tickets") {
        const tickets = listTickets(user, { accountId: account_id, ticketId: ticket_id });
        return {
          log: { tool: name, args, result_summary: `${tickets.length} ticket(s)` },
          sources: [],
          result: {
            tickets: tickets.map((t) => ({
              ...t,
              historical_resolution_trust:
                t.historical_resolution
                  ? "Context only. May be incorrect. Do not treat as policy."
                  : null,
            })),
          },
        };
      }
      return {
        log: { tool: name, args, result_summary: "Unknown entity" },
        sources: [],
        result: { error: "entity must be account, orders, or tickets" },
      };
    }

    if (name === "calculate_policy_outcome") {
      const op = String(args.operation ?? "");
      if (op === "cancellation") {
        if (!args.order_id) {
          return {
            log: { tool: name, args, result_summary: "Missing order_id" },
            sources: [],
            result: { error: "order_id is required" },
          };
        }
        const result = evaluateCancellation(user, String(args.order_id));
        return {
          log: {
            tool: name,
            args,
            result_summary: `Fee INR ${result.cancellation_fee_inr ?? "n/a"}`,
          },
          sources: [],
          result,
        };
      }
      if (op === "service_credit") {
        const result = evaluateServiceCredit(user, {
          order_id: args.order_id ? String(args.order_id) : undefined,
          hours_past_window:
            typeof args.hours_past_window === "number" ? args.hours_past_window : undefined,
          carrier_fault:
            typeof args.carrier_fault === "boolean" ? args.carrier_fault : undefined,
          customer_fault:
            typeof args.customer_fault === "boolean" ? args.customer_fault : undefined,
        });
        return {
          log: {
            tool: name,
            args,
            result_summary: result.eligible ? `Credit INR ${result.credit_inr}` : "Not eligible",
          },
          sources: [],
          result,
        };
      }
      if (op === "sla") {
        if (!args.ticket_id) {
          return {
            log: { tool: name, args, result_summary: "Missing ticket_id" },
            sources: [],
            result: { error: "ticket_id is required" },
          };
        }
        const result = evaluateSla(user, String(args.ticket_id));
        return {
          log: {
            tool: name,
            args,
            result_summary: result.sla_breached ? "SLA BREACHED" : "SLA within target",
          },
          sources: [],
          result,
        };
      }
      return {
        log: { tool: name, args, result_summary: "Unknown operation" },
        sources: [],
        result: { error: "Unknown operation" },
      };
    }

    if (name === "stage_support_action") {
      const actionType = args.action_type as PendingAction["action_type"];
      const pending = stageAction(user, actionType, args);
      return {
        log: {
          tool: name,
          args: { action_type: actionType },
          result_summary: "Staged — waiting for user confirmation",
        },
        sources: [],
        pending,
        result: {
          staged: true,
          preview: pending.preview,
          instruction:
            "Tell the user what will happen and ask them to confirm. Do not claim the action is already done.",
        },
      };
    }

    if (name === "ops_issue_detection") {
      const result = detectIssues(user);
      return {
        log: { tool: name, args, result_summary: result.summary },
        sources: [],
        result: { ...result, stats: summaryStats(user) },
      };
    }

    return {
      log: { tool: name, args, result_summary: "Unknown tool" },
      sources: [],
      result: { error: `Unknown tool ${name}` },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Tool failed";
    const denied = err instanceof AccessDeniedError;
    return {
      log: { tool: name, args, result_summary: denied ? "Access denied" : message },
      sources: [],
      result: { error: message, access_denied: denied },
    };
  }
}
