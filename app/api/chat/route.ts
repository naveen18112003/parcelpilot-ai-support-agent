import { NextResponse } from "next/server";
import { AccessDeniedError, requireUser } from "@/lib/access";
import { runAgent } from "@/lib/agent";
import type { ChatMessage } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const user = requireUser(req.headers.get("x-user-id"));
    const body = (await req.json()) as { messages?: ChatMessage[] };
    const messages = (body.messages ?? []).filter(
      (m) => m && (m.role === "user" || m.role === "assistant") && m.content
    );
    if (!messages.length || messages[messages.length - 1].role !== "user") {
      return NextResponse.json({ error: "Send a user message." }, { status: 400 });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const emit = (event: Record<string, unknown>) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        };
        try {
          await runAgent(user, messages, emit);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Agent failed";
          emit({ type: "error", message });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
      },
    });
  } catch (err) {
    const status = err instanceof AccessDeniedError ? 401 : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Chat failed" },
      { status }
    );
  }
}
