/* ============================================================
   ParcelPilot AI Support — Frontend Application
   ============================================================ */

// Auto-detect API base: use same origin when served from FastAPI, else localhost
const API = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  ? `${window.location.protocol}//${window.location.host}`
  : window.location.origin;

// ---- State ----
let currentUser = null;
let conversationHistory = [];
let pendingAction = null;

// ---- Example queries by role ----
const EXAMPLES = {
  customer: [
    'Can I cancel my latest order without a fee?',
    'What is my SLA response time guarantee?',
    'Am I eligible for a service credit on a late pickup?',
    'Show me my open support tickets',
  ],
  support: [
    'Can Northstar cancel ORD-1001 without a cancellation fee? Explain why.',
    'Is TKT-001 approaching an SLA breach?',
    'Show me all open tickets across accounts',
    'What are the current known product issues?',
  ],
  ops_admin: [
    'Show me all recurring issues across tickets',
    'Which accounts have the most open tickets?',
    'A pickup is three hours late due to carrier fault — should the customer get a service credit?',
    'Summarise operational data',
  ],
};

// ============================================================
// Bootstrap
// ============================================================
window.addEventListener('DOMContentLoaded', () => {
  loadUserList();
});

async function loadUserList() {
  try {
    const res = await fetch(`${API}/api/users`);
    const users = await res.json();
    renderUserList(users);
  } catch (e) {
    // Fallback static users if backend not running
    renderUserList([
      { user_id: 'alice', display_name: 'Alice (Northstar Logistics)', role: 'customer', account_id: 'ACC-001' },
      { user_id: 'bob',   display_name: 'Bob (LumenWorks)',            role: 'customer', account_id: 'ACC-002' },
      { user_id: 'carol', display_name: 'Carol (Support Agent)',       role: 'support',  account_id: null },
      { user_id: 'dave',  display_name: 'Dave (Ops Admin)',            role: 'ops_admin',account_id: null },
    ]);
  }
}

function renderUserList(users) {
  const el = document.getElementById('user-list');
  const icons = { customer: '👤', support: '🎧', ops_admin: '⚙️' };
  const avatarClass = { customer: 'avatar-customer', support: 'avatar-support', ops_admin: 'avatar-ops' };

  el.innerHTML = users.map(u => `
    <div class="user-card" onclick="login('${u.user_id}')">
      <div class="user-avatar ${avatarClass[u.role] || 'avatar-customer'}">${icons[u.role] || '👤'}</div>
      <div>
        <div class="user-card-name">${u.display_name}</div>
        <div class="user-card-role">${u.account_id ? `Account: ${u.account_id}` : 'Internal staff'}</div>
      </div>
      <span class="role-badge badge-${u.role}">${u.role}</span>
    </div>
  `).join('');
}

// ============================================================
// Login / Logout
// ============================================================
async function login(userId) {
  currentUser = { user_id: userId };

  try {
    const res = await fetch(`${API}/api/me`, {
      headers: { 'x-user-id': userId }
    });
    if (res.ok) currentUser = await res.json();
  } catch (e) {
    // Use fallback
    const fallback = {
      alice: { user_id: 'alice', display_name: 'Alice (Northstar Logistics)', role: 'customer', account_id: 'ACC-001', is_internal: false },
      bob:   { user_id: 'bob',   display_name: 'Bob (LumenWorks)',            role: 'customer', account_id: 'ACC-002', is_internal: false },
      carol: { user_id: 'carol', display_name: 'Carol (Support Agent)',       role: 'support',  account_id: null,      is_internal: true  },
      dave:  { user_id: 'dave',  display_name: 'Dave (Ops Admin)',            role: 'ops_admin',account_id: null,      is_internal: true  },
    };
    currentUser = fallback[userId] || fallback.alice;
  }

  conversationHistory = [];
  pendingAction = null;
  setupMainUI();
  switchScreen('main-screen');
}

function logout() {
  currentUser = null;
  conversationHistory = [];
  pendingAction = null;
  switchScreen('login-screen');
  document.getElementById('chat-messages').innerHTML = `
    <div class="welcome-msg" id="welcome-msg">
      <div class="welcome-icon">🤖</div>
      <h2 id="welcome-title">Hello! How can I help you today?</h2>
      <p id="welcome-text"></p>
      <div class="example-chips" id="example-chips"></div>
    </div>`;
}

function switchScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ============================================================
// Main UI setup after login
// ============================================================
function setupMainUI() {
  const u = currentUser;

  // User badge
  document.getElementById('user-badge').innerHTML = `
    <div class="user-badge-name">${u.display_name}</div>
    <div class="user-badge-role">${u.role}</div>
    ${u.account_id ? `<div class="user-badge-acct">Account: ${u.account_id}</div>` : ''}
  `;

  // Chat header
  const isInternal = u.is_internal;
  document.getElementById('chat-title').textContent = isInternal ? 'Internal Support Console' : 'Customer Support';
  document.getElementById('chat-subtitle').textContent = isInternal
    ? 'Investigate issues, manage tickets, and access operational data'
    : 'Ask about your shipments, policies, SLAs, and account';

  // Show analytics nav for internal users
  document.getElementById('analytics-nav').style.display = isInternal ? 'flex' : 'none';

  // Welcome message
  const roleKey = u.role === 'ops_admin' ? 'ops_admin' : u.role === 'support' ? 'support' : 'customer';
  const examples = EXAMPLES[roleKey] || EXAMPLES.customer;

  document.getElementById('welcome-title').textContent = `Hello, ${u.display_name.split(' ')[0]}!`;
  document.getElementById('welcome-text').textContent = isInternal
    ? 'I can help you investigate tickets, look up account data, check SLA status, and identify patterns across support activity.'
    : 'I can answer questions about your shipments, policies, SLAs, cancellations, and service credits.';

  document.getElementById('example-chips').innerHTML = examples.map(e =>
    `<div class="chip" onclick="useExample(this)">${e}</div>`
  ).join('');

  // Snapshot time
  fetchSnapshotTime();

  // Switch to chat view
  switchView('chat');
}

async function fetchSnapshotTime() {
  try {
    const res = await fetch(`${API}/api/snapshot-time`);
    const data = await res.json();
    document.getElementById('snapshot-badge').textContent = `Data as of: ${data.snapshot_time?.split('T')[0] || 'N/A'}`;
  } catch (e) {
    document.getElementById('snapshot-badge').textContent = 'Data snapshot';
  }
}

// ============================================================
// View switching
// ============================================================
function switchView(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`view-${view}`).classList.add('active');
  document.querySelector(`[data-view="${view}"]`)?.classList.add('active');

  if (view === 'analytics') loadAnalytics();
  if (view === 'escalations') loadEscalations();
}

// ============================================================
// Chat
// ============================================================
function useExample(el) {
  document.getElementById('chat-input').value = el.textContent;
  sendMessage();
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

async function sendMessage() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text || !currentUser) return;

  // Clear input
  input.value = '';
  input.style.height = 'auto';

  // Hide welcome
  const welcome = document.getElementById('welcome-msg');
  if (welcome) welcome.remove();

  // Disable send
  const sendBtn = document.getElementById('send-btn');
  sendBtn.disabled = true;

  // Add user message
  appendMessage('user', text);
  conversationHistory.push({ role: 'user', content: text });

  // Show typing indicator
  const typingId = showTyping();

  try {
    const res = await fetch(`${API}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': currentUser.user_id,
      },
      body: JSON.stringify({ messages: conversationHistory }),
    });

    removeTyping(typingId);

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Unknown error' }));
      appendErrorMessage(err.detail || 'API error');
      sendBtn.disabled = false;
      return;
    }

    const data = await res.json();

    // Append bot reply
    appendBotMessage(data);

    // Save to history
    conversationHistory.push({ role: 'assistant', content: data.reply });

    // Handle pending action (confirmation dialog)
    if (data.pending_action) {
      pendingAction = data.pending_action;
      showConfirmDialog(data.pending_action);
    }

  } catch (e) {
    removeTyping(typingId);
    appendErrorMessage('Could not reach the API. Is the backend running?');
  }

  sendBtn.disabled = false;
}

// ---- Message rendering ----
function appendMessage(role, content) {
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  const avatar = role === 'user'
    ? `<div class="msg-avatar avatar-user">👤</div>`
    : `<div class="msg-avatar avatar-bot">🤖</div>`;
  div.innerHTML = `${avatar}<div class="msg-body"><div class="msg-bubble">${escapeHtml(content)}</div></div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}

function appendBotMessage(data) {
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'msg bot';

  const toolCallsHtml = data.tool_calls?.length ? renderToolCalls(data.tool_calls) : '';
  const sourcesHtml = data.sources?.length ? renderSources(data.sources) : '';
  const replyHtml = markdownToHtml(data.reply || '');

  div.innerHTML = `
    <div class="msg-avatar avatar-bot">🤖</div>
    <div class="msg-body">
      ${toolCallsHtml}
      <div class="msg-bubble">${replyHtml}</div>
      ${sourcesHtml}
    </div>`;

  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function appendErrorMessage(text) {
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'error-banner';
  div.textContent = `⚠️ ${text}`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function renderToolCalls(toolCalls) {
  const id = 'tc-' + Date.now();
  const items = toolCalls.map(tc => {
    const icon = { document_search: '🔍', data_lookup: '📊', action: '⚡', analytics: '📈' }[tc.tool] || '🔧';
    const argsStr = Object.entries(tc.args || {})
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(', ');
    return `
      <div class="tool-call-item">
        <span class="tool-icon">${icon}</span>
        <div>
          <div><span class="tool-name">${tc.tool}</span></div>
          ${argsStr ? `<div class="tool-args">${escapeHtml(argsStr)}</div>` : ''}
          ${tc.result_summary ? `<div class="tool-result">→ ${escapeHtml(tc.result_summary)}</div>` : ''}
        </div>
      </div>`;
  }).join('');

  return `
    <div class="tool-calls">
      <div class="tool-calls-header" onclick="toggleToolCalls('${id}')">
        <span>⚙️</span>
        <span class="tool-calls-label">Tools used</span>
        <span class="tool-calls-count">${toolCalls.length} call${toolCalls.length > 1 ? 's' : ''}</span>
        <span class="tool-calls-toggle" id="toggle-${id}">▾</span>
      </div>
      <div class="tool-call-list" id="${id}">${items}</div>
    </div>`;
}

function toggleToolCalls(id) {
  const list = document.getElementById(id);
  const toggle = document.getElementById(`toggle-${id}`);
  const hidden = list.style.display === 'none';
  list.style.display = hidden ? 'block' : 'none';
  toggle.classList.toggle('open', hidden);
}

function renderSources(sources) {
  const chips = sources.map(s => {
    const cls = {
      authoritative: 'source-authoritative',
      deprecated: 'source-deprecated',
      historical_context: 'source-historical',
    }[s.tier] || 'source-authoritative';
    const dot = { authoritative: '●', deprecated: '⚠', historical_context: '○' }[s.tier] || '●';
    return `<span class="source-chip ${cls}" title="${escapeHtml(s.trust_note || '')}">${dot} ${escapeHtml(s.source)}</span>`;
  }).join('');
  return `<div class="sources-panel">${chips}</div>`;
}

// ---- Typing indicator ----
function showTyping() {
  const id = 'typing-' + Date.now();
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.id = id;
  div.className = 'msg bot';
  div.innerHTML = `
    <div class="msg-avatar avatar-bot">🤖</div>
    <div class="msg-body">
      <div class="msg-bubble">
        <div class="typing-indicator">
          <div class="dot"></div><div class="dot"></div><div class="dot"></div>
        </div>
      </div>
    </div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return id;
}

function removeTyping(id) {
  document.getElementById(id)?.remove();
}

// ============================================================
// Confirmation dialog
// ============================================================
function showConfirmDialog(action) {
  document.getElementById('confirm-preview').textContent = action.preview || 'Please confirm this action.';
  document.getElementById('confirm-dialog').classList.remove('hidden');
}

async function confirmAction() {
  if (!pendingAction) return;
  document.getElementById('confirm-dialog').classList.add('hidden');

  try {
    const res = await fetch(`${API}/api/confirm-action`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': currentUser.user_id,
      },
      body: JSON.stringify({
        action_type: pendingAction.action_type,
        params: pendingAction.params,
      }),
    });
    const data = await res.json();
    const msg = data.message || (data.success ? 'Action completed successfully.' : 'Action failed.');
    conversationHistory.push({ role: 'user', content: '[User confirmed the action]' });
    conversationHistory.push({ role: 'assistant', content: msg });
    appendBotMessage({ reply: `✅ ${msg}`, tool_calls: [], sources: [] });
  } catch (e) {
    appendErrorMessage('Could not execute action — backend unavailable.');
  }

  pendingAction = null;
}

function cancelAction() {
  document.getElementById('confirm-dialog').classList.add('hidden');
  appendBotMessage({ reply: 'Action cancelled. No changes were made.', tool_calls: [], sources: [] });
  pendingAction = null;
}

// ============================================================
// Analytics
// ============================================================
async function loadAnalytics() {
  const el = document.getElementById('analytics-content');
  el.innerHTML = '<div class="loading-spinner full-width"><div class="dot"></div><div class="dot"></div><div class="dot"></div> Loading...</div>';

  try {
    const res = await fetch(`${API}/api/analytics`, {
      headers: { 'x-user-id': currentUser.user_id }
    });

    if (!res.ok) {
      el.innerHTML = `<div class="error-banner full-width">⚠️ ${(await res.json()).detail}</div>`;
      return;
    }

    const data = await res.json();
    renderAnalytics(el, data);
  } catch (e) {
    el.innerHTML = '<div class="error-banner full-width">⚠️ Could not load analytics. Is the backend running?</div>';
  }
}

function renderAnalytics(el, data) {
  let html = '';

  // SLA at risk
  const slaRisk = data.sla_at_risk || [];
  html += `
    <div class="analytics-card">
      <div class="analytics-card-header">
        <span>🚨</span>
        <span class="analytics-card-title">SLA At Risk / Breached</span>
        <span class="analytics-card-count">${slaRisk.length}</span>
      </div>
      <div class="analytics-card-body">
        ${slaRisk.length === 0 ? '<div class="empty-state">No SLA issues detected ✓</div>' :
          slaRisk.map(t => `
            <div class="issue-row">
              <div class="issue-label">
                <strong>${t.ticket_id}</strong> — ${escapeHtml((t.subject || '').substring(0, 60))}
                <div style="color:var(--text3);font-size:11px;margin-top:2px">
                  ${t.priority} | ${t.elapsed_hours}h elapsed of ${t.sla_hours}h SLA (${t.pct_sla_used}%)
                </div>
              </div>
              <span class="issue-badge ${t.breached ? 'badge-danger' : t.pct_sla_used >= 90 ? 'badge-warn' : 'badge-info'}">
                ${t.breached ? 'BREACHED' : t.pct_sla_used >= 90 ? 'CRITICAL' : 'WARNING'}
              </span>
            </div>`).join('')
        }
      </div>
    </div>`;

  // Ticket clusters
  const clusters = data.ticket_clusters || [];
  html += `
    <div class="analytics-card">
      <div class="analytics-card-header">
        <span>🗂️</span>
        <span class="analytics-card-title">Issue Clusters</span>
        <span class="analytics-card-count">${clusters.length}</span>
      </div>
      <div class="analytics-card-body">
        ${clusters.length === 0 ? '<div class="empty-state">No clusters found</div>' :
          clusters.map(c => `
            <div class="issue-row">
              <div class="issue-label">${escapeHtml(c.category.replace(/_/g, ' '))}</div>
              <span class="issue-badge badge-info">${c.count} ticket${c.count > 1 ? 's' : ''}</span>
            </div>`).join('')
        }
      </div>
    </div>`;

  // Multi-customer issues
  const multi = data.multi_customer_issues || [];
  html += `
    <div class="analytics-card">
      <div class="analytics-card-header">
        <span>🌐</span>
        <span class="analytics-card-title">Multi-Customer Issues</span>
        <span class="analytics-card-count">${multi.length}</span>
      </div>
      <div class="analytics-card-body">
        ${multi.length === 0 ? '<div class="empty-state">No multi-customer issues detected ✓</div>' :
          multi.map(m => `
            <div class="issue-row">
              <div class="issue-label">
                <strong>${escapeHtml(m.issue_category.replace(/_/g, ' '))}</strong>
                <div style="color:var(--text3);font-size:11px;margin-top:2px">
                  Affects: ${escapeHtml(m.affected_accounts.join(', '))}
                </div>
              </div>
              <span class="issue-badge badge-warn">${m.account_count} accounts</span>
            </div>`).join('')
        }
      </div>
    </div>`;

  // High-volume accounts
  const highVol = data.high_volume_accounts || [];
  html += `
    <div class="analytics-card">
      <div class="analytics-card-header">
        <span>📬</span>
        <span class="analytics-card-title">High-Volume Accounts</span>
        <span class="analytics-card-count">${highVol.length}</span>
      </div>
      <div class="analytics-card-body">
        ${highVol.length === 0 ? '<div class="empty-state">No unusual activity detected ✓</div>' :
          highVol.map(a => `
            <div class="issue-row">
              <div class="issue-label">${escapeHtml(a.account_id)}</div>
              <span class="issue-badge badge-warn">${a.open_tickets} open tickets</span>
            </div>`).join('')
        }
      </div>
    </div>`;

  // Order anomalies
  const anomalies = data.order_anomalies || [];
  html += `
    <div class="analytics-card">
      <div class="analytics-card-header">
        <span>📦</span>
        <span class="analytics-card-title">Order Anomalies</span>
        <span class="analytics-card-count">${anomalies.length}</span>
      </div>
      <div class="analytics-card-body">
        ${anomalies.length === 0 ? '<div class="empty-state">No order anomalies detected ✓</div>' :
          anomalies.map(a => `
            <div class="issue-row">
              <div class="issue-label">${escapeHtml(a.note)}</div>
              <span class="issue-badge badge-warn">${a.rate_pct}%</span>
            </div>`).join('')
        }
      </div>
    </div>`;

  // Summary card
  if (data.summary) {
    html = `
      <div class="analytics-card full-width">
        <div class="analytics-card-header">
          <span>📋</span>
          <span class="analytics-card-title">Summary</span>
          <span class="analytics-card-count">as of ${data.snapshot_time?.split('T')[0] || ''}</span>
        </div>
        <div class="analytics-card-body">
          <pre style="font-size:12px;color:var(--text2);white-space:pre-wrap;font-family:inherit">${escapeHtml(data.summary)}</pre>
        </div>
      </div>` + html;
  }

  el.innerHTML = html;
}

// ============================================================
// Escalations
// ============================================================
async function loadEscalations() {
  const el = document.getElementById('escalations-content');
  el.innerHTML = '<div class="loading-spinner"><div class="dot"></div><div class="dot"></div><div class="dot"></div> Loading...</div>';

  try {
    const [escRes, taskRes] = await Promise.all([
      fetch(`${API}/api/escalations`, { headers: { 'x-user-id': currentUser.user_id } }),
      fetch(`${API}/api/followup-tasks`, { headers: { 'x-user-id': currentUser.user_id } }),
    ]);

    const { escalations } = await escRes.json();
    const { tasks } = await taskRes.json();

    let html = '';

    html += `<h2 style="font-size:15px;font-weight:600;margin-bottom:12px;color:var(--text2)">Escalations (${escalations.length})</h2>`;
    if (escalations.length === 0) {
      html += '<div class="empty-state" style="margin-bottom:24px">No escalations yet. Create one via chat.</div>';
    } else {
      html += escalations.map(e => `
        <div class="escalation-card">
          <div class="escalation-id">${e.escalation_id}</div>
          <div class="escalation-title">${escapeHtml(e.reason || 'No reason provided')}</div>
          <div class="escalation-meta">
            <span>Ticket: ${e.ticket_id || 'N/A'}</span>
            <span>Account: ${e.account_id || 'N/A'}</span>
            <span>Priority: ${e.priority}</span>
            <span>By: ${e.created_by}</span>
            <span>${e.created_at?.split('T')[0] || ''}</span>
          </div>
        </div>`).join('');
    }

    html += `<h2 style="font-size:15px;font-weight:600;margin:20px 0 12px;color:var(--text2)">Follow-up Tasks (${tasks.length})</h2>`;
    if (tasks.length === 0) {
      html += '<div class="empty-state">No follow-up tasks yet.</div>';
    } else {
      html += tasks.map(t => `
        <div class="escalation-card">
          <div class="escalation-id">${t.task_id}</div>
          <div class="escalation-title">${escapeHtml(t.title)}</div>
          <div class="escalation-meta">
            <span>Account: ${t.account_id || 'N/A'}</span>
            <span>Assignee: ${t.assignee}</span>
            <span>By: ${t.created_by}</span>
            <span>${t.created_at?.split('T')[0] || ''}</span>
          </div>
        </div>`).join('');
    }

    el.innerHTML = html;
  } catch (e) {
    el.innerHTML = '<div class="error-banner">⚠️ Could not load escalations. Is the backend running?</div>';
  }
}

// ============================================================
// Utilities
// ============================================================
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function markdownToHtml(text) {
  // Minimal markdown: bold, code, bullet lists, line breaks
  let html = escapeHtml(text);

  // Bold **text**
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Inline code `code`
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bullet lists (lines starting with - or *)
  html = html.replace(/^[*-] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>(\n|$))+/g, '<ul>$&</ul>');

  // Numbered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

  // Paragraphs (double newline)
  html = html.replace(/\n\n+/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  html = `<p>${html}</p>`;

  // Clean up empty paragraphs
  html = html.replace(/<p>\s*<\/p>/g, '');

  return html;
}
