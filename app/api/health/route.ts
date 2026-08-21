import { NextResponse } from "next/server";
import { SNAPSHOT_LABEL, getAccounts, getOrders, getTickets } from "@/lib/data";
import documents from "@/data/documents.json";

export async function GET() {
  return NextResponse.json({
    ok: true,
    snapshot: SNAPSHOT_LABEL,
    gemini_configured: Boolean(process.env.GEMINI_API_KEY),
    accounts: getAccounts().length,
    orders: getOrders().length,
    tickets: getTickets().length,
    document_chunks: documents.chunks.length,
  });
}
