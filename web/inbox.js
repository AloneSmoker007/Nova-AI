document.addEventListener("DOMContentLoaded", async () => {
  const list = document.querySelector(".conversations");
  const search = document.querySelector(".search-input, .search-box input, input[placeholder*='Search']");
  const chat = document.querySelector(".chat");
  const empty = document.createElement("p");
  empty.className = "muted";
  let conversations = [];

  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
  const initials = (name) => String(name || "?").trim().split(/\s+/).slice(0,2).map((v)=>v[0]).join("").toUpperCase();
  const renderList = () => {
    if (!list) return;
    const q = String(search?.value || "").trim().toLowerCase();
    const rows = conversations.filter((c) => !q || String(c.display_name || "").toLowerCase().includes(q) || String(c.wa_id || "").includes(q));
    list.innerHTML = rows.length ? rows.map((c) => `<button class="conversation" data-id="${escape(c.id)}">
      <span class="contact-avatar">${escape(initials(c.display_name || c.wa_id))}</span>
      <span class="conversation-copy"><strong>${escape(c.display_name || c.wa_id)}</strong><small>${escape(c.status || "active")} · ${c.unread_count || 0} unread</small></span>
      <span class="conversation-meta"><time>${c.last_message_at ? new Date(c.last_message_at).toLocaleString() : "—"}</time>${c.unread_count ? '<i class="unread"></i>' : ""}</span>
    </button>`).join("") : '<p class="muted">No conversations found.</p>';
    list.querySelectorAll(".conversation").forEach((button) => button.addEventListener("click", () => openConversation(button.dataset.id)));
  };
  async function openConversation(id) {
    const item = conversations.find((c) => c.id === id);
    if (!item || !chat) return;
    list.querySelectorAll(".conversation").forEach((x) => x.classList.toggle("active", x.dataset.id === id));
    try {
      const result = await NovaAPI.request(`/api/conversations/${encodeURIComponent(id)}/messages?limit=100`);
      const messages = Array.isArray(result.data) ? [...result.data].reverse() : [];
      const title = chat.querySelector("h2, h3, .chat-title");
      if (title) title.textContent = item.display_name || item.wa_id;
      const body = chat.querySelector(".messages, .chat-messages, .message-list");
      if (body) body.innerHTML = messages.length ? messages.map((m) => `<div class="message ${m.direction === "outbound" ? "outbound" : "inbound"}"><p>${escape(m.text || "")}</p><small>${escape(m.status || "")} · ${new Date(m.created_at).toLocaleString()}</small></div>`).join("") : '<p class="muted">No messages yet.</p>';
      await NovaAPI.request(`/api/conversations/${encodeURIComponent(id)}/read`, { method: "POST" }).catch(() => {});
    } catch {
      if (chat) chat.setAttribute("data-load-error", "true");
    }
  }
  if (!window.NovaAPI || !list) return;
  try {
    const result = await NovaAPI.request("/api/conversations?limit=100");
    conversations = Array.isArray(result.data) ? result.data : [];
    renderList();
    if (conversations[0]) await openConversation(conversations[0].id);
  } catch {
    list.innerHTML = '<p class="muted">Live inbox unavailable. Please sign in again or check the server.</p>';
  }
  search?.addEventListener("input", renderList);
});