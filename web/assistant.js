document.addEventListener("DOMContentLoaded", () => {
  const messages = document.querySelector("#assistant-messages");
  const form = document.querySelector("#assistant-form");
  const input = document.querySelector("#assistant-input");
  const status = document.querySelector("#nova-status");
  const activity = document.querySelector("#activity-list");
  const overlay = document.querySelector("#command-overlay");
  const commandInput = document.querySelector("#command-input");
  const results = [...document.querySelectorAll("#command-results button")];

  const addMessage = (kind, text) => {
    const el = document.createElement("div");
    el.className = kind === "user" ? "user-message" : "nova-message";
    el.innerHTML = `<span class="message-label">${kind === "user" ? "You" : "Nova"}</span><p></p><time>Now</time>`;
    el.querySelector("p").textContent = text;
    messages.appendChild(el); messages.scrollTop = messages.scrollHeight;
  };
  const setStatus = (value) => { if (status) status.textContent = value; };
  const addActivity = (text) => {
    if (!activity) return;
    activity.querySelector(".empty")?.remove();
    const el = document.createElement("div");
    el.className = "activity-item";
    el.innerHTML = '<span>✦</span><div><strong></strong><small>Just now · Live workspace</small></div>';
    el.querySelector("strong").textContent = text; activity.prepend(el);
  };

  async function answer(prompt) {
    setStatus("Thinking · Reading workspace data");
    const lower = prompt.toLowerCase();
    try {
      const [dashboard, usage, contacts, conversations] = await Promise.all([
        window.NovaAPI.request("/api/dashboard/summary"),
        NovaAPI.request("/api/usage"),
        NovaAPI.request("/api/contacts?limit=100"),
        NovaAPI.request("/api/conversations?limit=100"),
      ]);
      const d = dashboard.data || {};
      const u = usage.data || {};
      const cs = Array.isArray(contacts.data) ? contacts.data : [];
      const convs = Array.isArray(conversations.data) ? conversations.data : [];
      let reply;
      if (lower.includes("attention") || lower.includes("today") || lower.includes("brief")) {
        const unread = convs.reduce((n, c) => n + Number(c.unread_count || 0), 0);
        reply = `Live workspace briefing: ${unread} unread messages, ${Number(d.upcomingAppointments || 0)} upcoming appointments in 48h, ${Number(d.conversations || 0)} conversations and ${Number(d.messages || 0)} messages. AI usage: ${Number(u.used || u.aiMessages || 0)} used.`;
      } else if (lower.includes("customer") || lower.includes("lead")) {
        const active = cs.filter((c) => c.last_message_at).slice(0, 5).map((c) => c.display_name || c.wa_id).filter(Boolean);
        reply = active.length ? `Live customer list includes: ${active.join(", ")}.` : "There are no customer records available in the current tenant.";
      } else if (lower.includes("appointment")) {
        reply = `There are ${Number(d.upcomingAppointments || 0)} upcoming appointments in the next 48 hours.`;
      } else if (lower.includes("payment") || lower.includes("revenue")) {
        reply = `Recorded paid revenue is ${Number(d.revenueMinor || 0) / 100} in the tenant currency, based on the live dashboard aggregate.`;
      } else if (lower.includes("conversation") || lower.includes("inbox")) {
        reply = `The live inbox currently contains ${convs.length} conversations in the first 100 records.`;
      } else {
        reply = "I can answer workspace questions from live tenant data. Try asking about today's attention items, customers, inbox, appointments, payments, or revenue.";
      }
      addMessage("nova", reply); addActivity("Answered from live tenant APIs");
      setStatus("Ready · Live workspace context");
    } catch {
      addMessage("nova", "I couldn't load the live workspace data. Please sign in again or check the server connection.");
      setStatus("Live data unavailable");
    }
  }

  form?.addEventListener("submit", (e) => { e.preventDefault(); const prompt = input.value.trim(); if (!prompt) return; addMessage("user", prompt); input.value = ""; void answer(prompt); });
  document.querySelectorAll(".suggestion").forEach((b) => b.addEventListener("click", () => { input.value = b.dataset.prompt; input.focus(); }));
  const open = () => { if (overlay) { overlay.hidden = false; commandInput?.focus(); } };
  const close = () => { if (overlay) overlay.hidden = true; };
  document.querySelector("#command-button")?.addEventListener("click", open);
  document.querySelectorAll("[data-close-command]").forEach((x) => x.addEventListener("click", close));
  document.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); open(); } if (e.key === "Escape" && overlay && !overlay.hidden) close(); });
  commandInput?.addEventListener("input", () => { const q = commandInput.value.toLowerCase(); results.forEach((r) => { r.hidden = !!q && !r.dataset.command.toLowerCase().includes(q); }); });
  results.forEach((r) => r.addEventListener("click", () => { window.location.href = r.dataset.target; }));
});