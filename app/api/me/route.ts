import { NextResponse } from "next/server";
import { isInternal } from "@/lib/auth";
import { AccessDeniedError, requireUser } from "@/lib/access";
import { SNAPSHOT_LABEL } from "@/lib/data";

export async function GET(req: Request) {
  try {
    const user = requireUser(req.headers.get("x-user-id"));
    return NextResponse.json({
      ...user,
      is_internal: isInternal(user),
      snapshot: SNAPSHOT_LABEL,
    });
  } catch (err) {
    const status = err instanceof AccessDeniedError ? 401 : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status }
    );
  }
}
