import { NextResponse } from "next/server";
import { isInternal } from "@/lib/auth";
import { AccessDeniedError, requireUser } from "@/lib/access";
import { SNAPSHOT_LABEL } from "@/lib/data";

export async function GET(req: Request) {
  try {
    const user = requireUser(req.headers.get("x-user-id"));
    const apiKey = process.env.GEMINI_API_KEY;
    return NextResponse.json({
      ...user,
      is_internal: isInternal(user),
      snapshot: SNAPSHOT_LABEL,
      llm_active: Boolean(apiKey && apiKey.length > 5),
      llm_model: process.env.GEMINI_MODEL || "gemini-2.0-flash",
    });
  } catch (err) {
    const status = err instanceof AccessDeniedError ? 401 : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status }
    );
  }
}
