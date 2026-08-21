import operational from "@/data/operational.json";

export const SNAPSHOT_TIME = operational.snapshot_time;
export const SNAPSHOT_LABEL = operational.snapshot_label;

export type Account = (typeof operational.accounts)[number];
export type Order = (typeof operational.orders)[number];
export type Ticket = (typeof operational.tickets)[number];

export function getAccounts(): Account[] {
  return operational.accounts;
}

export function getOrders(): Order[] {
  return operational.orders;
}

export function getTickets(): Ticket[] {
  return operational.tickets;
}

export function getAccount(accountId: string): Account | undefined {
  return operational.accounts.find((a) => a.account_id === accountId);
}

export function getOrder(orderId: string): Order | undefined {
  return operational.orders.find((o) => o.order_id === orderId);
}

export function getTicket(ticketId: string): Ticket | undefined {
  return operational.tickets.find((t) => t.ticket_id === ticketId);
}

/** Parse dataset datetimes as Asia/Kolkata (IST, UTC+5:30). */
export function parseIst(value: string | null | undefined): Date | null {
  if (!value) return null;
  const iso = value.includes("T")
    ? value
    : value.replace(" ", "T") + "+05:30";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function snapshotDate(): Date {
  return new Date(SNAPSHOT_TIME);
}

export function hoursBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 3_600_000;
}

export function minutesBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 60_000;
}
