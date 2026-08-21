import type { UserContext } from "@/lib/auth";
import {
  getAccount,
  hoursBetween,
  minutesBetween,
  parseIst,
  snapshotDate,
  type Account,
  type Order,
  type Ticket,
} from "@/lib/data";
import { scopedOrder, scopedTicket } from "@/lib/access";
import type { Severity } from "@/lib/types";

const BUSINESS_START = 9;
const BUSINESS_END = 18;

export function inferSeverity(ticket: Ticket): { severity: Severity; reason: string } {
  const text = `${ticket.subject} ${ticket.description}`.toLowerCase();
  if (
    /api key|credential|security|exposure|outage|all shipment creation|http 500 when creating any shipment/.test(
      text
    )
  ) {
    return {
      severity: "P1",
      reason:
        "Matches Support Policy v3 P1: complete production outage preventing shipment creation, or confirmed/suspected credential exposure.",
    };
  }
  if (/bulk upload|fails|failing|degraded|pickup webhook|still shows booked/.test(text)) {
    return {
      severity: "P2",
      reason:
        "Matches Support Policy v3 P2: major feature unavailable or materially degraded, with a workaround or core operations still possible.",
    };
  }
  return {
    severity: "P3",
    reason:
      "Matches Support Policy v3 P3: how-to, configuration, or limited operational impact.",
  };
}

export function slaTargetHours(
  account: Account,
  severity: Severity
): {
  hours: number;
  coverage: "24x7" | "business_hours";
  source: string;
  note: string;
} {
  if (account.account_id === "ACCT-001") {
    const map = { P1: 0.25, P2: 1, P3: 8 };
    return {
      hours: map[severity],
      coverage: severity === "P1" ? "24x7" : "business_hours",
      source: "Northstar Logistics Enterprise Agreement",
      note: "Contract targets replace Support Policy v3 defaults for this account.",
    };
  }
  if (account.account_id === "ACCT-002") {
    const map = { P1: 2, P2: 4, P3: 16 };
    return {
      hours: map[severity],
      coverage: "business_hours",
      source: "LumenWorks Service Agreement",
      note: "No weekend or after-hours coverage. P3 is 2 business days (counted as 16 business hours).",
    };
  }
  if (account.plan === "Enterprise") {
    const map = { P1: 0.5, P2: 2, P3: 8 };
    return {
      hours: map[severity],
      coverage: severity === "P1" ? "24x7" : "business_hours",
      source: "Support Policy v3",
      note: "Default Enterprise first-response targets.",
    };
  }
  if (account.plan === "Growth") {
    const map = { P1: 2, P2: 4, P3: 16 };
    return {
      hours: map[severity],
      coverage: "business_hours",
      source: "Support Policy v3",
      note: "Default Growth first-response targets. P3 is 2 business days.",
    };
  }
  const map = { P1: 4, P2: 8, P3: 16 };
  return {
    hours: map[severity],
    coverage: "business_hours",
    source: "Support Policy v3",
    note: "Default Standard first-response targets.",
  };
}

function isWeekend(d: Date): boolean {
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
  }).format(d);
  return day === "Sat" || day === "Sun";
}

function hourInIst(d: Date): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(d)
  );
}

export function businessHoursBetween(from: Date, to: Date): number {
  if (to <= from) return 0;
  let hours = 0;
  const cursor = new Date(from.getTime());
  const stepMs = 15 * 60 * 1000;
  while (cursor < to) {
    const next = new Date(Math.min(cursor.getTime() + stepMs, to.getTime()));
    if (!isWeekend(cursor)) {
      const h = hourInIst(cursor);
      if (h >= BUSINESS_START && h < BUSINESS_END) {
        hours += (next.getTime() - cursor.getTime()) / 3_600_000;
      }
    }
    cursor.setTime(next.getTime());
  }
  return hours;
}

export function evaluateSla(user: UserContext, ticketId: string) {
  const ticket = scopedTicket(user, ticketId);
  const account = getAccount(ticket.account_id);
  if (!account) throw new Error(`Account ${ticket.account_id} not found`);
  const { severity, reason } = inferSeverity(ticket);
  const target = slaTargetHours(account, severity);
  const created = parseIst(ticket.created_at);
  const snapshot = snapshotDate();
  const closed = ticket.status === "closed";
  const elapsedCalendar = created ? hoursBetween(created, snapshot) : null;
  const elapsedBusiness = created ? businessHoursBetween(created, snapshot) : null;
  const elapsed =
    target.coverage === "24x7" ? elapsedCalendar : elapsedBusiness;
  const breached =
    !closed && elapsed !== null && elapsed > target.hours;
  const remaining =
    elapsed === null ? null : Math.round((target.hours - elapsed) * 100) / 100;

  return {
    ticket_id: ticket.ticket_id,
    account_id: ticket.account_id,
    account_name: account.account_name,
    plan: account.plan,
    ticket_status: ticket.status,
    subject: ticket.subject,
    inferred_severity: severity,
    severity_reason: reason,
    sla_source: target.source,
    sla_note: target.note,
    coverage: target.coverage,
    target_hours: target.hours,
    created_at: ticket.created_at,
    snapshot_time: snapshot.toISOString(),
    elapsed_calendar_hours: elapsedCalendar !== null ? round(elapsedCalendar) : null,
    elapsed_business_hours: elapsedBusiness !== null ? round(elapsedBusiness) : null,
    elapsed_hours_for_sla: elapsed !== null ? round(elapsed) : null,
    hours_remaining: remaining,
    sla_breached: breached,
    trust: {
      policy_v2: "Deprecated — do not use for current SLA targets.",
      historical_resolutions: "Context only; may be incorrect.",
    },
  };
}

export function evaluateCancellation(user: UserContext, orderId: string) {
  const order = scopedOrder(user, orderId);
  const account = getAccount(order.account_id);
  if (!account) throw new Error(`Account ${order.account_id} not found`);

  const booked = parseIst(order.booked_at);
  const requested = parseIst(order.cancellation_requested_at) ?? snapshotDate();
  const minutesSinceBooking =
    booked ? minutesBetween(booked, requested) : null;

  const conflicts: string[] = [];
  let cancelable = false;
  let feeInr: number | null = null;
  let outcome = "";
  const sources: string[] = ["Cancellation & Service Credit SOP v4"];

  if (order.status === "DRAFT") {
    cancelable = true;
    feeInr = 0;
    outcome = "DRAFT shipments may be cancelled with no fee.";
  } else if (order.status === "DELIVERED") {
    cancelable = false;
    feeInr = null;
    outcome = "DELIVERED shipments cannot be cancelled.";
  } else if (order.status === "PICKED_UP") {
    cancelable = false;
    feeInr = null;
    outcome =
      "Do not cancel a PICKED_UP shipment. Use the return-to-origin workflow if the customer wants the parcel returned.";
  } else if (order.status === "BOOKED") {
    cancelable = true;
    const northstarWaiver = account.account_id === "ACCT-001";
    if (northstarWaiver) {
      feeInr = 0;
      sources.push("Northstar Logistics Enterprise Agreement §2");
      outcome =
        "Northstar may cancel any BOOKED shipment before pickup with no cancellation fee, regardless of how long ago it was booked.";
      conflicts.push(
        "Closed ticket TKT-450 historically told Northstar that an INR 250 fee applied after 30 minutes. That guidance is incorrect under the current signed agreement. Historical tickets are context only."
      );
    } else {
      sources.push(
        account.account_id === "ACCT-002"
          ? "LumenWorks Service Agreement §2 (no fee waiver; use SOP)"
          : "Support Policy / SOP defaults (no customer fee waiver on file)"
      );
      if (minutesSinceBooking !== null && minutesSinceBooking <= 30) {
        feeInr = 0;
        outcome = `BOOKED and not picked up. Cancellation requested about ${Math.round(
          minutesSinceBooking
        )} minutes after booking, within the 30-minute free window. Fee: INR 0.`;
      } else {
        feeInr = 250;
        outcome = `BOOKED and not picked up. Cancellation is after the 30-minute window${
          minutesSinceBooking !== null
            ? ` (~${Math.round(minutesSinceBooking)} minutes after booking)`
            : ""
        }. Default fee: INR 250. No signed waiver applies.`;
      }
    }
  } else {
    outcome = `Unrecognised status ${order.status}. Escalate before acting.`;
  }

  return {
    order,
    account: {
      account_id: account.account_id,
      account_name: account.account_name,
      plan: account.plan,
    },
    minutes_since_booking: minutesSinceBooking !== null ? round(minutesSinceBooking) : null,
    cancelable,
    cancellation_fee_inr: feeInr,
    outcome,
    sources,
    conflicts,
    known_issue_note:
      order.carrier === "SwiftShip" && order.status === "BOOKED"
        ? "KI-211: SwiftShip pickup webhooks can arrive up to 20 minutes late. A parcel may already be collected while status is still BOOKED. Verify carrier status before treating the shipment as not picked up."
        : null,
  };
}

export function evaluateServiceCredit(
  user: UserContext,
  args: {
    order_id?: string;
    hours_past_window?: number;
    carrier_fault?: boolean;
    customer_fault?: boolean;
  }
) {
  const order = args.order_id ? scopedOrder(user, args.order_id) : null;
  const accountId =
    order?.account_id ??
    (user.role === "customer" ? user.account_id : undefined);
  const account = accountId ? getAccount(accountId) : null;

  const snapshot = snapshotDate();
  let hoursPast: number | null = args.hours_past_window ?? null;
  if (hoursPast === null && order?.pickup_window_end) {
    const end = parseIst(order.pickup_window_end);
    if (end) hoursPast = Math.max(0, hoursBetween(end, snapshot));
  }

  const carrierFault =
    args.carrier_fault ?? (order ? order.carrier_fault : null);
  const customerFault =
    args.customer_fault ?? (order ? order.customer_fault : null);

  const lumen = account?.account_id === "ACCT-002";
  const thresholdHours = lumen ? 4 : 2;
  const sources = ["Cancellation & Service Credit SOP v4"];
  if (lumen) sources.push("LumenWorks Service Agreement §3 (replaces SOP amount and threshold)");
  if (account?.account_id === "ACCT-001") {
    sources.push("Northstar agreement: SOP applies unless stated otherwise; monthly credits capped at INR 5,000");
  }

  const unknown =
    carrierFault === null || customerFault === null || hoursPast === null;

  let eligible = false;
  let credit: number | null = null;
  let reason = "";

  if (unknown) {
    reason =
      "Do not promise a credit when carrier fault, pickup timing, or customer fault is unknown. Verify first.";
  } else if (customerFault) {
    reason = "Not eligible: customer-caused issue is present.";
  } else if (!carrierFault) {
    reason = "Not eligible: carrier is not at fault.";
  } else if ((hoursPast as number) <= thresholdHours) {
    reason = `Not eligible yet: ${round(hoursPast as number)} hour(s) past window end, but the applicable threshold is more than ${thresholdHours} hours (${lumen ? "LumenWorks contract" : "SOP default"}).`;
  } else {
    eligible = true;
    if (lumen) {
      credit = 300;
      reason = `Eligible under LumenWorks contract: pickup more than 4 hours late, carrier at fault, customer not at fault. Fixed credit INR 300.`;
    } else {
      const fee = order?.shipment_fee_inr ?? null;
      credit = fee === null ? null : Math.min(500, Math.round(fee * 0.1));
      reason =
        credit === null
          ? `Eligible under SOP (more than 2 hours late, carrier at fault, no customer fault). Credit is the lower of INR 500 or 10% of the shipment fee. Provide an order to compute the exact amount.`
          : `Eligible under SOP. Credit is the lower of INR 500 or 10% of shipment fee INR ${fee} = INR ${credit}.`;
    }
  }

  if (eligible && credit !== null && credit > 1000) {
    reason += " Individual credits above INR 1,000 require manager approval.";
  }

  return {
    hypothetical: !order,
    order,
    account: account
      ? {
          account_id: account.account_id,
          account_name: account.account_name,
          plan: account.plan,
        }
      : user.role === "customer"
        ? { account_id: user.account_id }
        : null,
    hours_past_window: hoursPast !== null ? round(hoursPast) : null,
    threshold_hours: thresholdHours,
    carrier_fault: carrierFault,
    customer_fault: customerFault,
    eligible,
    credit_inr: credit,
    reason,
    sources,
    approval_required: credit !== null && credit > 1000,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
