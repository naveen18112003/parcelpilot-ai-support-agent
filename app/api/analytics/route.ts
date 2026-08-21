import { NextResponse } from "next/server";
import { AccessDeniedError, requireUser } from "@/lib/access";
import { detectIssues, summaryStats } from "@/lib/analytics";

export async function GET(req: Request) {
  try {
    const user = requireUser(req.headers.get("x-user-id"));
    return NextResponse.json({
      ...detectIssues(user),
      stats: summaryStats(user),
    });
  } catch (err) {
    const status = err instanceof AccessDeniedError ? 403 : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Analytics failed" },
      { status }
    );
  }
}
