import { NextResponse } from "next/server";
import { AccessDeniedError, requireUser } from "@/lib/access";
import { executeAction } from "@/lib/actions";

export async function POST(req: Request) {
  try {
    const user = requireUser(req.headers.get("x-user-id"));
    const { token } = (await req.json()) as { token?: string };
    if (!token) return NextResponse.json({ error: "Missing token" }, { status: 400 });
    const result = executeAction(user, token);
    return NextResponse.json(result);
  } catch (err) {
    const status = err instanceof AccessDeniedError ? 401 : 400;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Confirm failed" },
      { status }
    );
  }
}
