export type Role = "customer" | "support" | "ops_admin";

export type UserContext = {
  user_id: string;
  email: string;
  role: Role;
  account_id: string | null;
  display_name: string;
  company: string | null;
};

export const MOCK_USERS: Record<string, UserContext> = {
  alice: {
    user_id: "alice",
    email: "alice@northstar.example",
    role: "customer",
    account_id: "ACCT-001",
    display_name: "Alice Chen",
    company: "Northstar Logistics",
  },
  bob: {
    user_id: "bob",
    email: "bob@lumenworks.example",
    role: "customer",
    account_id: "ACCT-002",
    display_name: "Bob Iyer",
    company: "LumenWorks",
  },
  priya: {
    user_id: "priya",
    email: "priya@beacon.example",
    role: "customer",
    account_id: "ACCT-003",
    display_name: "Priya Shah",
    company: "Beacon Retail",
  },
  carol: {
    user_id: "carol",
    email: "carol@parcelpilot.example",
    role: "support",
    account_id: null,
    display_name: "Carol Mendes",
    company: "ParcelPilot Support",
  },
  dave: {
    user_id: "dave",
    email: "dave@parcelpilot.example",
    role: "ops_admin",
    account_id: null,
    display_name: "Dave Okonkwo",
    company: "ParcelPilot Operations",
  },
};

export function getUser(userId: string | null | undefined): UserContext | null {
  if (!userId) return null;
  return MOCK_USERS[userId] ?? null;
}

export function isInternal(user: UserContext): boolean {
  return user.role === "support" || user.role === "ops_admin";
}

export function canAccessAccount(user: UserContext, accountId: string): boolean {
  if (isInternal(user)) return true;
  return user.account_id === accountId;
}

export function publicUsers() {
  return Object.values(MOCK_USERS).map((u) => ({
    user_id: u.user_id,
    display_name: u.display_name,
    role: u.role,
    account_id: u.account_id,
    company: u.company,
  }));
}
