document.addEventListener("DOMContentLoaded", async () => {
  const list = document.querySelector(".customer-list");
  if (!window.NovaAPI || !list) return;
  const search = list.querySelector("input");
  let contacts = [];
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
  const initials = (name) => String(name || "?").trim().split(/\s+/).slice(0,2).map((v)=>v[0]).join("").toUpperCase();

  async function showContact(contact) {
    document.querySelectorAll(".customer-row").forEach((x) => x.classList.toggle("active", x.dataset.id === contact.id));
    const brain = document.querySelector(".brain");
    if (!brain) return;
    try {
      const result = await window.NovaAPI.request(`/api/contacts/${encodeURIComponent(contact.id)}/ai-memory`);
      const memories = Array.isArray(result.data) ? result.data : [];
      const section = brain.querySelector(".memory-section");
      if (section) {
        section.innerHTML = `<div class="section-title"><strong>Nova Memory</strong></div>${memories.length ? memories.map((m) => `<div class="memory-card"><span>🧠</span><div><strong>${escape(m.memory_key)}</strong><p>${escape(m.memory_value)}</p></div></div>`).join("") : '<p class="muted">No durable memory recorded yet.</p>'}`;
      }
      const profile = brain.querySelector(".profile");
      const heading = profile?.querySelector("h2");
      if (heading) heading.textContent = contact.display_name || contact.wa_id;
      const phone = profile?.querySelector("p");
      if (phone) phone.textContent = contact.wa_id || "—";
    } catch {
      const section = brain.querySelector(".memory-section");
      if (section) section.insertAdjacentHTML("beforeend", '<p class="muted">Memory unavailable.</p>');
    }
  }
  function render() {
    const q = String(search?.value || "").trim().toLowerCase();
    const filtered = contacts.filter((c) => !q || String(c.display_name || "").toLowerCase().includes(q) || String(c.wa_id || "").includes(q));
    const header = list.querySelector(".list-head");
    list.innerHTML = "";
    if (header) list.appendChild(header);
    const count = header?.querySelector("strong");
    if (count) count.textContent = `${filtered.length} customers`;
    filtered.forEach((contact) => {
      const row = document.createElement("button");
      row.type = "button"; row.className = "customer-row"; row.dataset.id = contact.id;
      row.innerHTML = `<span class="avatar-lg">${escape(initials(contact.display_name || contact.wa_id))}</span><div><strong>${escape(contact.display_name || "Unknown")}</strong><small>${escape(contact.wa_id || "No number")} · ${contact.conversation_count || 0} conversations</small></div><span class="row-tag">${contact.last_message_at ? "Active" : "New"}</span>`;
      row.addEventListener("click", () => showContact(contact));
      list.appendChild(row);
    });
    if (filtered[0]) showContact(filtered[0]);
  }
  try {
    const result = await NovaAPI.request("/api/contacts?limit=100");
    contacts = Array.isArray(result.data) ? result.data : [];
    render();
  } catch {
    const body = document.createElement("p"); body.className = "muted"; body.textContent = "Live customer data unavailable.";
    list.appendChild(body);
  }
  search?.addEventListener("input", render);
});