"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentResult, PendingAction, SourceCite, ToolCallLog } from "@/lib/types";

type PublicUser = {
  user_id: string;
  display_name: string;
  role: string;
  account_id: string | null;
  company: string | null;
};

type Msg = {
  role: "user" | "assistant";
  content: string;
  tools?: ToolCallLog[];
  sources?: SourceCite[];
};

const EXAMPLES: Record<string, string[]> = {
  customer: [
    "Can I cancel my latest order without a fee?",
    "A pickup is three hours late because of carrier fault. Should I get a service credit?",
    "What is my first-response SLA?",
    "Show my open tickets",
  ],
  support: [
    "Can Northstar cancel ORD-1001 without a cancellation fee? Explain why.",
    "A pickup is three hours late because of carrier fault. Should LumenWorks get a service credit?",
    "Is TKT-501 approaching or past SLA? Escalate if needed.",
    "Why does ORD-1002 still look cancellable?",
  ],
  ops_admin: [
    "What deserves attention across support right now?",
    "Cluster tickets against known issues KI-208 and KI-211.",
    "Has TKT-505 breached first response?",
    "Should Axis Labs receive a credit on a 3-hour late pickup with carrier fault?",
  ],
};

async function readSse(res: Response, onEvent: (e: Record<string, unknown>) => void) {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      onEvent(JSON.parse(line.slice(6)));
    }
  }
}

export default function App() {
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [userId, setUserId] = useState<string | null>(null);
  const [me, setMe] = useState<PublicUser & { is_internal?: boolean; snapshot?: string } | null>(null);
  const [tab, setTab] = useState<"chat" | "ops">("chat");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [liveTools, setLiveTools] = useState<string[]>([]);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [ops, setOps] = useState<Record<string, unknown> | null>(null);
  const [opsError, setOpsError] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/users")
      .then((r) => r.json())
      .then((d) => setUsers(d.users ?? []));
  }, []);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [messages, liveTools, pending]);

  async function login(id: string) {
    setUserId(id);
    setMessages([]);
    setPending(null);
    setTab("chat");
    const meRes = await fetch("/api/me", { headers: { "x-user-id": id } });
    setMe(await meRes.json());
  }

  async function loadOps() {
    if (!userId) return;
    setOpsError(null);
    const res = await fetch("/api/analytics", { headers: { "x-user-id": userId } });
    const data = await res.json();
    if (!res.ok) setOpsError(data.error ?? "Cannot load ops");
    else setOps(data);
  }

  async function send(text: string) {
    if (!userId || !text.trim() || busy) return;
    const next = [...messages, { role: "user" as const, content: text.trim() }];
    setMessages(next);
    setInput("");
    setBusy(true);
    setLiveTools([]);
    setPending(null);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-id": userId },
        body: JSON.stringify({
          messages: next.map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      let final: AgentResult | null = null;
      await readSse(res, (event) => {
        if (event.type === "tool_start") {
          setLiveTools((t) => [...t, String(event.tool)]);
        }
        if (event.type === "final") {
          final = event as unknown as AgentResult;
        }
        if (event.type === "error") {
          final = {
            reply: String(event.message),
            tool_calls: [],
            sources: [],
            pending_action: null,
            mode: "heuristic",
          };
        }
      });
      if (final) {
        const f = final as AgentResult;
        setMessages((m) => [
          ...m,
          {
            role: "assistant",
            content: f.reply,
            tools: f.tool_calls,
            sources: f.sources,
          },
        ]);
        setPending(f.pending_action);
      }
    } catch (err) {
      setMessages((m) => [
        ...m,
        { role: "assistant", content: err instanceof Error ? err.message : "Request failed" },
      ]);
    } finally {
      setBusy(false);
      setLiveTools([]);
    }
  }

  async function confirm(ok: boolean) {
    if (!pending || !userId) return;
    if (!ok) {
      setPending(null);
      setMessages((m) => [...m, { role: "assistant", content: "Cancelled. Nothing was changed." }]);
      return;
    }
    const res = await fetch("/api/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-id": userId },
      body: JSON.stringify({ token: pending.token }),
    });
    const data = await res.json();
    setPending(null);
    setMessages((m) => [
      ...m,
      {
        role: "assistant",
        content: res.ok ? data.message : data.error,
      },
    ]);
  }

  const examples = useMemo(() => {
    if (!me) return [];
    return EXAMPLES[me.role] ?? EXAMPLES.customer;
  }, [me]);

  if (!userId || !me) {
    return (
      <div className="app-shell">
        <header className="brand">
          <div>
            <h1>ParcelPilot</h1>
            <p>
              Support agent with document retrieval, scoped operational lookup, and confirm-before-action
              escalations. Policies, contracts, and tickets are not treated as equal sources.
            </p>
          </div>
          <div className="meta-pill">Snapshot 16 Aug 2026 11:00 IST</div>
        </header>
        <div className="user-grid">
          {users.map((u) => (
            <button key={u.user_id} className="user-card" onClick={() => login(u.user_id)}>
              <div className="name">{u.display_name}</div>
              <div className="sub">{u.company ?? "ParcelPilot"} · {u.account_id ?? "internal"}</div>
              <span className={`badge ${u.role === "customer" ? "" : "internal"}`}>{u.role}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="brand">
        <div>
          <h1>ParcelPilot</h1>
          <p>Answers from the candidate data pack only. Actions stay staged until you confirm.</p>
        </div>
        <div className="meta-pill">{me.snapshot ?? "dataset snapshot"}</div>
      </header>
      <div className="workspace">
        <aside className="side">
          <div className="who">
            <strong>{me.display_name}</strong>
            {me.role} {me.account_id ? `· ${me.account_id}` : ""}
          </div>
          <button className="ghost" onClick={() => { setUserId(null); setMe(null); }}>
            Switch user
          </button>
          <p className="who" style={{ marginTop: 18 }}>Try</p>
          {examples.map((ex) => (
            <button key={ex} className="example" onClick={() => send(ex)}>
              {ex}
            </button>
          ))}
        </aside>
        <section className="main">
          <div className="tabs">
            <button className={`tab ${tab === "chat" ? "on" : ""}`} onClick={() => setTab("chat")}>
              Chat
            </button>
            {me.is_internal && (
              <button
                className={`tab ${tab === "ops" ? "on" : ""}`}
                onClick={() => {
                  setTab("ops");
                  void loadOps();
                }}
              >
                Issue detection
              </button>
            )}
          </div>
          {tab === "chat" ? (
            <>
              <div className="thread" ref={threadRef}>
                {messages.length === 0 && (
                  <div className="msg bot">
                    Ask about cancellations, credits, SLAs, known issues, or a specific ORD / TKT id.
                    I will search documents and scoped data, then stop before any write.
                  </div>
                )}
                {messages.map((m, i) => (
                  <div key={i} className={`msg ${m.role === "user" ? "user" : "bot"}`}>
                    {m.content}
                    {!!m.tools?.length && (
                      <div className="tools">
                        {m.tools.map((t, j) => (
                          <span className="chip" key={j}>
                            {t.tool}: {t.result_summary}
                          </span>
                        ))}
                      </div>
                    )}
                    {!!m.sources?.length && (
                      <div className="sources">
                        {m.sources.map((s) => (
                          <div key={s.source}>
                            {s.source} · {s.tier}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                {busy && (
                  <div className="running">
                    {liveTools.length ? `Using ${liveTools[liveTools.length - 1]}…` : "Thinking…"}
                  </div>
                )}
              </div>
              {pending && (
                <div className="action-card">
                  <strong>Confirmation required</strong>
                  <p>{pending.preview}</p>
                  <button className="confirm" onClick={() => confirm(true)}>Confirm action</button>
                  <button className="deny" onClick={() => confirm(false)}>Cancel</button>
                </div>
              )}
              <form
                className="composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  void send(input);
                }}
              >
                <textarea
                  value={input}
                  placeholder="Ask in natural language"
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void send(input);
                    }
                  }}
                />
                <button className="send" disabled={busy} type="submit">
                  Send
                </button>
              </form>
            </>
          ) : (
            <OpsPanel data={ops} error={opsError} />
          )}
        </section>
      </div>
    </div>
  );
}

function OpsPanel({ data, error }: { data: Record<string, unknown> | null; error: string | null }) {
  if (error) return <div className="ops">{error}</div>;
  if (!data) return <div className="ops">Loading ops signals…</div>;
  const sla = (data.sla_watch as Array<Record<string, unknown>>) ?? [];
  const clusters = (data.ticket_clusters as Array<Record<string, unknown>>) ?? [];
  const known = (data.known_issue_links as Array<Record<string, unknown>>) ?? [];
  return (
    <div className="ops">
      <p>{String(data.summary ?? "")}</p>
      <div className="card">
        <h3>SLA watch</h3>
        {sla.map((s) => (
          <div className="row" key={String(s.ticket_id)}>
            <span>{String(s.ticket_id)} · {String(s.inferred_severity)} · {String(s.account_name)}</span>
            <span className={s.sla_breached ? "bad" : "ok"}>
              {s.sla_breached ? "breached" : "within target"} ({String(s.elapsed_hours_for_sla)}h / {String(s.target_hours)}h)
            </span>
          </div>
        ))}
      </div>
      <div className="card">
        <h3>Clusters</h3>
        {clusters.map((c) => (
          <div className="row" key={String(c.category)}>
            <span>{String(c.category)}</span>
            <span>
              {String(c.count)} tickets · {String(c.account_count)} accounts
              {c.multi_customer ? " · multi-customer" : ""}
            </span>
          </div>
        ))}
      </div>
      <div className="card">
        <h3>Known issues linked to live tickets</h3>
        {known.map((k) => (
          <div key={String(k.id)} style={{ marginBottom: 10 }}>
            <strong>{String(k.id)}</strong> {String(k.title)}
            <div className="sources">{String(k.guidance)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
