import {
  canAccessAccount,
  getUser,
  isInternal,
  type UserContext,
} from "@/lib/auth";
import {
  getAccount,
  getAccounts,
  getOrder,
  getOrders,
  getTicket,
  getTickets,
  type Account,
  type Order,
  type Ticket,
} from "@/lib/data";

export class AccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessDeniedError";
  }
}

export function requireUser(userId: string | null | undefined): UserContext {
  const user = getUser(userId);
  if (!user) {
    throw new AccessDeniedError("Unauthenticated. Choose a demo user first.");
  }
  return user;
}

export function scopedAccount(user: UserContext, accountId: string): Account {
  if (!canAccessAccount(user, accountId)) {
    throw new AccessDeniedError(
      `Access denied: ${user.user_id} cannot read account ${accountId}.`
    );
  }
  const account = getAccount(accountId);
  if (!account) {
    throw new Error(`Account ${accountId} not found.`);
  }
  return account;
}

export function scopedOrder(user: UserContext, orderId: string): Order {
  const order = getOrder(orderId);
  if (!order) {
    throw new Error(`Order ${orderId} not found.`);
  }
  if (!canAccessAccount(user, order.account_id)) {
    throw new AccessDeniedError(
      `Access denied: ${user.user_id} cannot read order ${orderId}.`
    );
  }
  return order;
}

export function scopedTicket(user: UserContext, ticketId: string): Ticket {
  const ticket = getTicket(ticketId);
  if (!ticket) {
    throw new Error(`Ticket ${ticketId} not found.`);
  }
  if (!canAccessAccount(user, ticket.account_id)) {
    throw new AccessDeniedError(
      `Access denied: ${user.user_id} cannot read ticket ${ticketId}.`
    );
  }
  return ticket;
}

export function listAccounts(user: UserContext, accountId?: string): Account[] {
  if (user.role === "customer") {
    if (accountId && accountId !== user.account_id) {
      throw new AccessDeniedError(
        `Access denied: customers cannot read account ${accountId}.`
      );
    }
    if (!user.account_id) return [];
    const account = getAccount(user.account_id);
    return account ? [account] : [];
  }
  if (accountId) return [scopedAccount(user, accountId)];
  requireInternal(user);
  return getAccounts();
}

export function listOrders(
  user: UserContext,
  opts: { accountId?: string; orderId?: string } = {}
): Order[] {
  if (opts.orderId) return [scopedOrder(user, opts.orderId)];
  const accountId =
    user.role === "customer" ? user.account_id ?? undefined : opts.accountId;
  if (accountId) {
    scopedAccount(user, accountId);
    return getOrders().filter((o) => o.account_id === accountId);
  }
  if (!isInternal(user)) {
    throw new AccessDeniedError("Customers can only list their own orders.");
  }
  return getOrders();
}

export function listTickets(
  user: UserContext,
  opts: { accountId?: string; ticketId?: string } = {}
): Ticket[] {
  if (opts.ticketId) return [scopedTicket(user, opts.ticketId)];
  const accountId =
    user.role === "customer" ? user.account_id ?? undefined : opts.accountId;
  if (accountId) {
    scopedAccount(user, accountId);
    return getTickets().filter((t) => t.account_id === accountId);
  }
  if (!isInternal(user)) {
    throw new AccessDeniedError("Customers can only list their own tickets.");
  }
  return getTickets();
}

export function requireInternal(user: UserContext): UserContext {
  if (!isInternal(user)) {
    throw new AccessDeniedError(
      "This tool is limited to authorised ParcelPilot staff."
    );
  }
  return user;
}
