import { requireInternal } from "@/lib/access";
import type { UserContext } from "@/lib/auth";
import { getAccounts, getOrders, getTickets, snapshotDate, type Ticket } from "@/lib/data";
import { evaluateSla, inferSeverity } from "@/lib/policy";

const KEYWORDS: Record<string, string[]> = {
  outage_or_creation: ["shipment creation", "http 500", "failing"],
  bulk_upload: ["bulk upload", "csv"],
  pickup_status: ["booked", "pickup", "swiftship"],
  security: ["api key", "exposure", "credential"],
  cancellation: ["cancel", "cancellation", "fee"],
  billing_howto: ["billing contact", "how do we"],
};

export function detectIssues(user: UserContext) {
  requireInternal(user);
  const snapshot = snapshotDate();
  const tickets = getTickets();
  const orders = getOrders();
  const accounts = getAccounts();

  const sla = tickets
    .filter((t) => t.status === "open")
    .map((t) => {
      try {
        return evaluateSla(user, t.ticket_id);
      } catch {
        return null;
      }
    })
    .filter((x): x is NonNullable<typeof x> => Boolean(x))
    .sort((a, b) => Number(b.sla_breached) - Number(a.sla_breached));

  const clusters = Object.entries(KEYWORDS)
    .map(([category, words]) => {
      const matched = tickets.filter((t) =>
        words.some((w) => `${t.subject} ${t.description}`.toLowerCase().includes(w))
      );
      const accountIds = [...new Set(matched.map((t) => t.account_id))];
      return {
        category,
        count: matched.length,
        account_count: accountIds.length,
        tickets: matched.map(summariseTicket),
        multi_customer: accountIds.length >= 2,
      };
    })
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count);

  const knownIssues = [
    {
      id: "KI-208",
      title: "Bulk Upload failures on large CSVs",
      linked_tickets: tickets
        .filter((t) => /bulk upload|csv/.test(`${t.subject} ${t.description}`.toLowerCase()))
        .map((t) => t.ticket_id),
      guidance:
        "Product limit remains 5,000 rows. Current investigating issue fails above ~3,000 rows. Workaround: split files. Closed ticket TKT-451 incorrectly said Growth only supports 3,000 rows — that is historical and wrong.",
    },
    {
      id: "KI-211",
      title: "SwiftShip pickup webhook delay (up to 20 minutes)",
      linked_tickets: tickets
        .filter((t) => /swiftship|still shows booked/.test(`${t.subject} ${t.description}`.toLowerCase()))
        .map((t) => t.ticket_id),
      guidance:
        "Do not tell a customer pickup did not occur until carrier status is verified or the delay window has passed.",
    },
  ];

  const openByAccount = accounts.map((a) => ({
    account_id: a.account_id,
    account_name: a.account_name,
    plan: a.plan,
    open_tickets: tickets.filter((t) => t.account_id === a.account_id && t.status === "open")
      .length,
  }));

  const stuckBooked = orders.filter((o) => o.status === "BOOKED");
  const missedPickups = orders.filter((o) => o.carrier_fault && !o.pickup_actual_at);

  return {
    snapshot_time: snapshot.toISOString(),
    summary: `${sla.filter((s) => s.sla_breached).length} open ticket(s) already past first-response target; ${clusters.filter((c) => c.multi_customer).length} issue categories span multiple customers.`,
    sla_watch: sla,
    ticket_clusters: clusters,
    known_issue_links: knownIssues,
    open_tickets_by_account: openByAccount,
    order_watch: {
      still_booked: stuckBooked.map((o) => ({
        order_id: o.order_id,
        account_id: o.account_id,
        carrier: o.carrier,
        notes: o.notes,
      })),
      carrier_fault_no_pickup: missedPickups.map((o) => ({
        order_id: o.order_id,
        account_id: o.account_id,
        carrier: o.carrier,
      })),
    },
  };
}

function summariseTicket(t: Ticket) {
  const { severity } = inferSeverity(t);
  return {
    ticket_id: t.ticket_id,
    account_id: t.account_id,
    status: t.status,
    severity,
    subject: t.subject,
    historical_resolution: t.historical_resolution,
  };
}

export function summaryStats(user: UserContext) {
  requireInternal(user);
  const tickets = getTickets();
  const orders = getOrders();
  return {
    accounts: getAccounts().length,
    orders: orders.length,
    tickets: tickets.length,
    open_tickets: tickets.filter((t) => t.status === "open").length,
    orders_by_status: Object.fromEntries(
      [...new Set(orders.map((o) => o.status))].map((s) => [
        s,
        orders.filter((o) => o.status === s).length,
      ])
    ),
  };
}
