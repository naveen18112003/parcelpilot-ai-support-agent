import { createHmac, timingSafeEqual } from "crypto";
import type { UserContext } from "@/lib/auth";
import type { PendingAction } from "@/lib/types";
import { canAccessAccount, isInternal } from "@/lib/auth";

type ActionType = PendingAction["action_type"];

type Payload = {
  action_type: ActionType;
  params: Record<string, unknown>;
  user_id: string;
  exp: number;
};

function secret(): string {
  return process.env.ACTION_SECRET || process.env.GEMINI_API_KEY || "parcelpilot-demo-secret";
}

function sign(payload: Payload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function verify(token: string, user: UserContext): Payload {
  const [body, mac] = token.split(".");
  if (!body || !mac) throw new Error("Invalid action token.");
  const expected = createHmac("sha256", secret()).update(body).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("Action token signature mismatch.");
  }
  const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as Payload;
  if (payload.exp < Date.now()) throw new Error("Action token expired. Ask the assistant to stage it again.");
  if (payload.user_id !== user.user_id) {
    throw new Error("This confirmation belongs to a different user.");
  }
  return payload;
}

function preview(actionType: ActionType, params: Record<string, unknown>): string {
  if (actionType === "create_escalation") {
    return `Create escalation ${params.ticket_id ? `for ${params.ticket_id}` : ""} (account ${params.account_id ?? "n/a"}) — ${params.reason ?? "no reason given"} [${params.priority ?? "priority unset"}].`;
  }
  if (actionType === "update_ticket") {
    return `Update ticket ${params.ticket_id ?? ""}: ${JSON.stringify(params.updates ?? params)}`;
  }
  return `Create follow-up "${params.title ?? "Follow-up"}" for account ${params.account_id ?? "n/a"}.`;
}

export function stageAction(
  user: UserContext,
  actionType: ActionType,
  params: Record<string, unknown>
): PendingAction {
  const accountId = typeof params.account_id === "string" ? params.account_id : user.account_id;
  if (accountId && !canAccessAccount(user, accountId) && !isInternal(user)) {
    throw new Error("Cannot stage an action for another account.");
  }
  const payload: Payload = {
    action_type: actionType,
    params,
    user_id: user.user_id,
    exp: Date.now() + 15 * 60 * 1000,
  };
  return {
    token: sign(payload),
    action_type: actionType,
    preview: preview(actionType, params),
    params,
  };
}

export function executeAction(user: UserContext, token: string) {
  const payload = verify(token, user);
  const id = Math.random().toString(36).slice(2, 8).toUpperCase();
  const created_at = new Date().toISOString();

  if (payload.action_type === "create_escalation") {
    const record = {
      escalation_id: `ESC-${id}`,
      ...payload.params,
      created_by: user.user_id,
      created_at,
      status: "open",
    };
    return {
      success: true,
      message: `Escalation ${record.escalation_id} created (mocked local action).`,
      result: record,
    };
  }
  if (payload.action_type === "update_ticket") {
    const record = {
      update_id: `UPD-${id}`,
      ticket_id: payload.params.ticket_id,
      updates: payload.params.updates ?? payload.params,
      updated_by: user.user_id,
      updated_at: created_at,
    };
    return {
      success: true,
      message: `Ticket ${payload.params.ticket_id ?? ""} updated (mocked).`,
      result: record,
    };
  }
  const record = {
    task_id: `TASK-${id}`,
    ...payload.params,
    created_by: user.user_id,
    created_at,
    status: "open",
  };
  return {
    success: true,
    message: `Follow-up ${record.task_id} created (mocked).`,
    result: record,
  };
}
