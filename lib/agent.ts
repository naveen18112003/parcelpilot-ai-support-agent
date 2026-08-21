import { GoogleGenerativeAI, type Content, type Part } from "@google/generative-ai";
import type { UserContext } from "@/lib/auth";
import { executeTool, toolsFor } from "@/lib/tools";
import { systemPrompt } from "@/lib/prompts";
import type { AgentResult, ChatMessage, PendingAction, SourceCite, ToolCallLog } from "@/lib/types";
import { heuristicReply } from "@/lib/heuristic";

type Emit = (event: Record<string, unknown>) => void;

function asArgs(args: unknown): Record<string, unknown> {
  if (!args) return {};
  if (typeof args === "string") {
    try {
      return JSON.parse(args) as Record<string, unknown>;
    } catch {
      return { query: args };
    }
  }
  return args as Record<string, unknown>;
}

function mergeSources(into: SourceCite[], extra: SourceCite[]) {
  for (const s of extra) {
    if (!into.some((x) => x.source === s.source)) into.push(s);
  }
}

export async function runAgent(
  user: UserContext,
  messages: ChatMessage[],
  emit?: Emit
): Promise<AgentResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const result = heuristicReply(user, messages);
    emit?.({ type: "final", ...result });
    return result;
  }

  const modelName = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const genAI = new GoogleGenerativeAI(apiKey);
  const toolDecls = toolsFor(user);

  const model = genAI.getGenerativeModel({
    model: modelName,
    systemInstruction: systemPrompt(user),
    tools: [
      {
        functionDeclarations: toolDecls.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters as never,
        })),
      },
    ],
  });

  const history: Content[] = [];
  const prior = messages.slice(0, -1);
  for (const m of prior) {
    history.push({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    });
  }

  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") {
    return {
      reply: "Send a user message to continue.",
      tool_calls: [],
      sources: [],
      pending_action: null,
      mode: "gemini",
    };
  }

  const chat = model.startChat({ history });
  let response = await chat.sendMessage(last.content);

  const tool_calls: ToolCallLog[] = [];
  const sources: SourceCite[] = [];
  let pending: PendingAction | null = null;

  for (let i = 0; i < 8; i++) {
    const calls = response.response.functionCalls();
    if (!calls?.length) {
      const reply = response.response.text() || "I could not produce an answer from the available sources.";
      const result: AgentResult = {
        reply,
        tool_calls,
        sources,
        pending_action: pending,
        mode: "gemini",
      };
      emit?.({ type: "final", ...result });
      return result;
    }

    const fnParts: Part[] = [];
    for (const call of calls) {
      emit?.({ type: "tool_start", tool: call.name, args: call.args });
      const event = executeTool(user, call.name, asArgs(call.args));
      tool_calls.push(event.log);
      mergeSources(sources, event.sources);
      if (event.pending) pending = event.pending;
      emit?.({
        type: "tool_result",
        tool: call.name,
        result_summary: event.log.result_summary,
        pending_action: event.pending ?? null,
      });
      fnParts.push({
        functionResponse: {
          name: call.name,
          response: event.result as object,
        },
      });
    }

    if (pending) {
      const confirm = await chat.sendMessage(fnParts);
      const reply =
        confirm.response.text() ||
        `I staged this action and need your confirmation before it runs:\n${pending.preview}`;
      const result: AgentResult = {
        reply,
        tool_calls,
        sources,
        pending_action: pending,
        mode: "gemini",
      };
      emit?.({ type: "final", ...result });
      return result;
    }

    response = await chat.sendMessage(fnParts);
  }

  const result: AgentResult = {
    reply:
      "I gathered several sources but hit the step limit. Ask a narrower question, or confirm if you want this escalated.",
    tool_calls,
    sources,
    pending_action: pending,
    mode: "gemini",
  };
  emit?.({ type: "final", ...result });
  return result;
}
