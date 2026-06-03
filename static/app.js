/* Velosify.ai CRM — frontend logic */
(() => {
  const state = {
    view: "dashboard",
    meta: { services: [], stages: [] },
    contacts: [],
    companies: [],
    deals: [],
    activities: [],
    users: [],
    projects: [],
    currentProjectId: null,
    search: "",
    contactList: "",  // active contact-list filter; "" = all
    selectedContacts: new Set(),  // contact IDs currently selected for bulk actions
    selectedCompanies: new Set(),  // company IDs currently selected for bulk actions
    customFields: [],  // user-defined custom columns (loaded per project)
    leadgenMode: "free",  // "free" (OSM) or "pro" (Google) — set by sidebar sub-nav
    settingsMode: "profile", // "profile" | "team" | "api-keys" | "billing" — set by sidebar sub-nav
    gameMode: "runner",  // "runner" | "whack" | "sniper" — set by sidebar sub-nav
    scriptMode: "web-design", // which industry script is active

    sort: {
      contacts:   { column: "ref_id",     direction: "asc",  type: "number" },
      companies:  { column: "name",       direction: "asc",  type: "string" },
      activities: { column: "due_date",   direction: "desc", type: "date" },
      users:      { column: "created_at", direction: "desc", type: "date" },
    },
  };

  // ------- Sort helpers -------
  function getSortValue(row, column) {
    if (column === "name") {
      return `${row.first_name || ""} ${row.last_name || ""}`.trim().toLowerCase();
    }
    const v = row[column];
    return v == null ? "" : v;
  }

  function compareValues(a, b, type) {
    // Empty values always sort last.
    const aEmpty = a === "" || a == null;
    const bEmpty = b === "" || b == null;
    if (aEmpty && bEmpty) return 0;
    if (aEmpty) return 1;
    if (bEmpty) return -1;
    if (type === "number") return Number(a) - Number(b);
    if (type === "date") return String(a).localeCompare(String(b));
    return String(a).toLowerCase().localeCompare(String(b).toLowerCase());
  }

  function sortRows(rows, entity) {
    const cfg = state.sort[entity];
    if (!cfg) return rows;
    const sorted = [...rows].sort((a, b) => {
      const cmp = compareValues(getSortValue(a, cfg.column), getSortValue(b, cfg.column), cfg.type);
      return cfg.direction === "desc" ? -cmp : cmp;
    });
    return sorted;
  }

  function applySortIndicators() {
    $$(".data-table.sortable").forEach(table => {
      const entity = table.dataset.entity;
      const cfg = state.sort[entity];
      $$("th[data-sort]", table).forEach(th => {
        th.classList.remove("sort-asc", "sort-desc");
        if (cfg && th.dataset.sort === cfg.column) {
          th.classList.add(cfg.direction === "asc" ? "sort-asc" : "sort-desc");
        }
      });
    });
  }

  // ------- API helpers -------
  const api = {
    get: (path) => fetch(path).then(r => r.json()),
    post: (path, body) => fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(r => r.json()),
    put: (path, body) => fetch(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(r => r.json()),
    del: (path) => fetch(path, { method: "DELETE" }).then(r => r.json()),
  };

  // ------- Utilities -------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const fmtMoney = (n) => {
    n = Number(n || 0);
    return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  };
  const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
  // Escape any user-provided text, then bold the "📞 Power Dial" marker so
  // every call session line pops in the Contacts notes column. Backend
  // prepends the marker (and the rest of the header line) so newest call
  // is always at the start — the highlighter lights it up visually.
  // Safe: 📞, P, o, w, e, r, ·, space — none of those are HTML-special, so
  // the literal-string replace can't introduce XSS even though the body
  // text it sits next to is fully escaped first.
  const highlightPowerDial = (s) => {
    const esc = escapeHtml(s);
    return esc
      .replace(
        /\u{1F4DE} Power Dial/gu,
        '<strong class="notes-power-dial">\u{1F4DE} Power Dial</strong>',
      )
      // Dim the separator rule between note blocks
      .replace(/──────────/g, '<span class="notes-divider">──────────</span>');
  };
  /**
   * Return only the most recent note block — the text up to the first
   * "──────────" divider that _append_call_note_to_contact inserts
   * between sessions. Older blocks stay in c.notes so they show up in
   * the contact-edit modal's textarea, but the row only displays the
   * latest. Keeps row heights uniform and the table readable.
   */
  const latestNoteBlock = (raw) => {
    const s = (raw || "").trim();
    if (!s) return "";
    const sepIdx = s.indexOf("──────────");
    if (sepIdx === -1) return s;
    return s.slice(0, sepIdx).trim();
  };
  // Format raw phone digits for display.
  //   - "+1 408-996-3376" or "+595 991 802076" → preserved as-is
  //     (international format already includes country code spacing).
  //   - 10 digits → "(123) 456-7890" (US/CA local style).
  //   - 11 digits starting with 1 → "+1 (234) 567-8901".
  //   - Anything else falls through unchanged so we don't mangle
  //     unusual numbers.
  const formatPhone = (raw) => {
    if (!raw) return "";
    const s = String(raw);
    // International number — Google's international_phone_number field
    // arrives as "+CC XXX XXX XXXX" with the country code separated by
    // a space. Preserve that exactly; the local-style US formatter
    // below would corrupt it.
    if (s.startsWith("+")) return s;
    const digits = s.replace(/\D+/g, "");
    if (digits.length === 10) {
      return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    }
    if (digits.length === 11 && digits.startsWith("1")) {
      return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
    }
    return s;
  };
  const toast = (msg, kind = "success") => {
    const el = $("#toast");
    el.className = `toast ${kind}`;
    el.textContent = msg;
    el.classList.remove("hidden");
    setTimeout(() => el.classList.add("hidden"), 2200);
  };
  const serviceColor = (s) => {
    const map = {
      "Web Design": "cyan",
      "Graphic Design": "purple",
      "Marketing": "orange",
      "Calendar Integration": "",
      "CRM Buildout": "green",
      "AI Voice": "purple",
    };
    return map[s] ?? "";
  };

  // ------- Loading data -------

  // Lightweight contacts-only refresh — used by features that mutate
  // contact data out-of-band (e.g. Power Dialer appending notes during
  // a session). Exposed on window so other modules can call it without
  // reaching into this IIFE's closure scope.
  async function refreshContactsOnly() {
    try {
      const contacts = await api.get("/api/contacts");
      state.contacts = contacts;
      // Only re-render if the contacts table is currently the visible
      // view. Otherwise the next switchView('contacts') will pick up the
      // fresh state.contacts on its own.
      if (state.view === "contacts" && typeof renderContacts === "function") {
        renderContacts();
      }
    } catch (err) {
      // Non-blocking — if refresh fails, the user can still hit reload
      // or change views and the next visit will fetch fresh data.
    }
  }
  window.refreshContactsOnly = refreshContactsOnly;

  async function loadAll() {
    const [meta, contacts, companies, deals, activities, who, projectsResp, customFields] = await Promise.all([
      api.get("/api/meta"),
      api.get("/api/contacts"),
      api.get("/api/companies"),
      api.get("/api/deals"),
      api.get("/api/activities"),
      api.get("/api/whoami").catch(() => ({ username: "local" })),
      api.get("/api/projects").catch(() => ({ projects: [], current_id: null })),
      api.get("/api/custom-fields").catch(() => []),
    ]);
    state.meta = meta;
    state.contacts = contacts;
    state.companies = companies;
    state.deals = deals;
    state.activities = activities;
    state.projects = projectsResp.projects || [];
    state.currentProjectId = projectsResp.current_id ?? who?.project_id ?? null;
    state.customFields = Array.isArray(customFields) ? customFields : [];
    // Load the per-project column layout (order + widths) BEFORE rendering.
    loadColumnLayout();
    const nameEl = $("#user-name");
    if (nameEl) nameEl.textContent = who?.username || "local";
    // Show the admin-only nav items (Lead Generator, Users) only to the admin.
    state._isAdmin = !!who?.is_admin;
    $$(".admin-only").forEach(el => {
      if (state._isAdmin) el.removeAttribute("hidden");
      else el.setAttribute("hidden", "");
    });
    // Superadmin-only items (Admin Panel) — restricted to the founder
    // username so other admins can't see the platform-wide controls.
    state._isSuperAdmin = (who?.username === "nolan201");
    $$(".superadmin-only").forEach(el => {
      if (state._isSuperAdmin) el.removeAttribute("hidden");
      else el.setAttribute("hidden", "");
    });
    renderBillingBanner(who?.subscription || null);
    renderProjectSwitcher();
    render();
  }

  // ------- Billing banner -------
  function renderBillingBanner(sub) {
    const chip = document.getElementById("billing-chip");
    const banner = document.getElementById("billing-banner");
    if (!chip || !banner) return;
    if (!sub || !sub.billing_enabled) {
      chip.setAttribute("hidden", "");
      banner.setAttribute("hidden", "");
      return;
    }
    // Grandfathered "founder's plan" customers get a celebratory banner +
    // a sidebar chip — never any of the trial / past-due nags below.
    // The hide_founder_banner flag (set per-user on the backend) keeps
    // the grandfather *access* but suppresses the founder UI for users
    // who shouldn't be surfacing that label inside the app.
    if (sub.grandfathered) {
      if (!sub.hide_founder_banner) {
        chip.textContent = "Founder · Free forever";
        chip.className = "billing-chip founder";
        chip.removeAttribute("hidden");
        banner.innerHTML = `<span>You're on the founder's plan. Free, forever — thanks for being an early customer.</span><button type="button" class="billing-banner-close" aria-label="Hide founder badges">×</button>`;
        banner.className = "billing-banner founder";
        banner.removeAttribute("hidden");
        const closeBtn = banner.querySelector(".billing-banner-close");
        if (closeBtn) {
          closeBtn.title = "Hide both founder badges permanently (you'll keep free access)";
          closeBtn.addEventListener("click", async () => {
            // Optimistic UI: hide immediately so it feels instant.
            banner.setAttribute("hidden", "");
            chip.setAttribute("hidden", "");
            try {
              await fetch("/api/me/hide-founder-banner", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ hide: true }),
              });
            } catch (err) {
              // Network error — badges stay hidden for this session but
              // would come back on next reload. User can dismiss again.
              console.warn("Couldn't persist founder badge hide:", err);
            }
          });
        }
      } else {
        // Persisted opt-out — keep grandfather access but no UI.
        chip.setAttribute("hidden", "");
        banner.setAttribute("hidden", "");
      }
      return;
    }
    let chipText = "";
    let chipClass = "billing-chip";
    let bannerText = "";
    let bannerClass = "billing-banner";
    if (sub.status === "trialing") {
      const d = sub.days_remaining;
      const hasCard = !!sub.card_verified;
      const label = d == null ? "Trial active" : (d <= 1 ? "Trial ends today" : `${d} days left in trial`);
      chipClass += " trial";
      if (hasCard) {
        // Card is already on file — keep the banner but switch to an
        // informational message so the user isn't told to "add a card"
        // they've already added.
        chipText = label;
        if (d != null) {
          const when = d <= 1 ? "today" : `in ${d} days`;
          bannerText = `${d <= 1 ? "Trial ends today" : d + " days left in your free trial"} — your $49/month subscription will start automatically ${when}. Manage your card from <a href="/settings">Settings → Billing</a>.`;
        } else {
          bannerText = `Free trial active — your $49/month subscription will start automatically when it ends. Manage your card from <a href="/settings">Settings → Billing</a>.`;
        }
      } else {
        chipText = `${label} · Add card →`;
        if (d != null) {
          if (d <= 2) {
            bannerText = `Your free trial ends in ${d <= 1 ? "less than a day" : d + " days"} — <a href="/billing">add a card</a> to keep your CRM running at $49/month.`;
            bannerClass += " warn";
          } else {
            bannerText = `${d} days left in your free trial. <a href="/billing">Add a card</a> any time to continue at $49/month after the trial ends.`;
          }
        }
      }
    } else if (sub.status === "active") {
      chipText = "Subscription · $49/mo";
      chipClass += " active";
    } else if (sub.status === "past_due") {
      chipText = "Payment failed · Update card";
      chipClass += " warn";
      bannerText = `Your last payment didn't go through — <a href="/billing">update your card</a> to keep your CRM running.`;
      bannerClass += " warn";
    } else if (sub.status === "canceled" || sub.status === "none") {
      chipText = "Subscribe — $49/mo";
      chipClass += " warn";
      bannerText = `Your subscription is inactive. <a href="/billing">Subscribe now</a> to restore access.`;
      bannerClass += " warn";
    }
    if (chipText) {
      chip.textContent = chipText;
      chip.className = chipClass;
      chip.removeAttribute("hidden");
    } else {
      chip.setAttribute("hidden", "");
    }
    if (bannerText) {
      banner.innerHTML = `<span>${bannerText}</span><button type="button" class="billing-banner-close" aria-label="Dismiss">×</button>`;
      banner.className = bannerClass;
      banner.removeAttribute("hidden");
      const closeBtn = banner.querySelector(".billing-banner-close");
      if (closeBtn) closeBtn.addEventListener("click", () => banner.setAttribute("hidden", ""));
    } else {
      banner.setAttribute("hidden", "");
    }
  }

  // ------- Projects -------
  function currentProject() {
    return state.projects.find(p => p.id === state.currentProjectId) || state.projects[0] || null;
  }

  function renderProjectSwitcher() {
    const cur = currentProject();
    const nameEl = $("#current-project-name");
    if (nameEl) nameEl.textContent = cur ? cur.name : "Default";
    const menu = $("#project-switcher-menu");
    if (!menu) return;
    menu.innerHTML = "";
    state.projects.forEach(p => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = state.currentProjectId === p.id ? "active" : "";
      btn.innerHTML = `<span>${escapeHtml(p.name)}</span>${state.currentProjectId === p.id ? '<span class="check">✓</span>' : ""}`;
      btn.addEventListener("click", async () => {
        await switchProject(p.id);
        menu.setAttribute("hidden", "");
      });
      menu.appendChild(btn);
    });
    const divider = document.createElement("div");
    divider.className = "menu-divider";
    menu.appendChild(divider);
    const newBtn = document.createElement("button");
    newBtn.type = "button";
    newBtn.className = "menu-action";
    newBtn.innerHTML = "+ New project";
    newBtn.addEventListener("click", async () => {
      menu.setAttribute("hidden", "");
      await promptCreateProject();
    });
    menu.appendChild(newBtn);
    const manageBtn = document.createElement("button");
    manageBtn.type = "button";
    manageBtn.className = "menu-action";
    manageBtn.innerHTML = "Manage projects →";
    manageBtn.addEventListener("click", () => {
      menu.setAttribute("hidden", "");
      switchView("projects");
      closeSidebar();
    });
    menu.appendChild(manageBtn);
  }

  async function switchProject(projectId) {
    try {
      const res = await fetch(`/api/projects/${projectId}/switch`, { method: "POST" });
      if (!res.ok) throw new Error((await res.json()).error || "Could not switch.");
      state.currentProjectId = projectId;
      state.contactList = "";  // reset list filter
      await loadAll();
      const cur = currentProject();
      toast(`Switched to ${cur ? cur.name : "project"}`);
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function promptCreateProject() {
    const name = window.prompt("New project name (e.g. \"Velosify\", \"Other Business\")");
    if (!name?.trim()) return;
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Create failed.");
      toast(`Project "${body.name}" created`);
      // Switch to the brand-new project so the user lands inside an empty workspace.
      await switchProject(body.id);
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function renameProject(p) {
    const name = window.prompt("Rename project", p.name);
    if (!name?.trim() || name.trim() === p.name) return;
    try {
      const res = await fetch(`/api/projects/${p.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Rename failed.");
      toast("Renamed");
      await loadAll();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function deleteProject(p) {
    if (!confirm(`Delete project "${p.name}" and ALL of its contacts, companies, deals, and activities? This can't be undone.`)) return;
    try {
      const res = await fetch(`/api/projects/${p.id}`, { method: "DELETE" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Delete failed.");
      toast("Project deleted");
      await loadAll();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function setProjectDefault(p) {
    try {
      const res = await fetch(`/api/projects/${p.id}/default`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed.");
      toast(`"${p.name}" is now your default project`);
      await loadAll();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  function renderProjectsView() {
    const ownedGrid  = document.getElementById("projects-grid-owned");
    const sharedGrid = document.getElementById("projects-grid-shared");
    if (!ownedGrid || !sharedGrid) return;
    ownedGrid.innerHTML = "";
    sharedGrid.innerHTML = "";
    renderPendingSharesBanner();

    const renderCard = (p, grid) => {
      const isActive = state.currentProjectId === p.id;
      const isShared = !!p.is_shared;  // shared TO me (I don't own it)
      const activeCount  = p.share_active_count  || 0;
      const pendingCount = p.share_pending_count || 0;
      const isOwnedAndShared = !isShared && (activeCount + pendingCount > 0);
      const ownerName = isShared
        ? (((p.owner_first_name || "") + " " + (p.owner_last_name || "")).trim()
            || p.owner_username || p.owner_email || "owner")
        : "";
      // Owner-side collab pill — "Shared with N" or "1 pending invite"
      let collabPill = "";
      if (isOwnedAndShared) {
        const titleParts = [];
        if (activeCount)  titleParts.push(`${activeCount} accepted`);
        if (pendingCount) titleParts.push(`${pendingCount} pending`);
        const title = titleParts.join(" · ");
        const label = activeCount > 0
          ? `Shared with ${activeCount}`
          : `${pendingCount} pending invite${pendingCount === 1 ? "" : "s"}`;
        collabPill = `<span class="project-card-shared-pill" title="${escapeHtml(title)}">${escapeHtml(label)}</span>`;
      }
      const card = document.createElement("div");
      card.className = "project-card"
        + (isActive ? " active" : "")
        + (isShared || isOwnedAndShared ? " shared" : "");
      card.innerHTML = `
        <div class="project-card-header">
          <div class="project-card-name">
            ${escapeHtml(p.name)}
            ${isActive ? '<span class="project-card-active-pill">● Active</span>' : ""}
            ${isShared ? `<span class="project-card-shared-pill" title="Shared by ${escapeHtml(ownerName)}">Shared by ${escapeHtml(ownerName)}</span>` : ""}
            ${collabPill}
          </div>
          ${p.is_default ? '<span class="project-card-default-pill">Default</span>' : ""}
        </div>
        <div class="project-card-stats">
          <span><strong>${p.company_count}</strong> co</span>
          <span><strong>${p.contact_count}</strong> contacts</span>
          <span><strong>${p.deal_count}</strong> deals</span>
        </div>
        <div class="project-card-actions">
          ${isActive ? "" : `<button class="btn btn-primary" data-action="switch">Switch to</button>`}
          ${!isShared ? `<button class="btn" data-action="share">Share</button>` : ""}
          ${!isShared ? `<button class="btn" data-action="rename">Rename</button>` : ""}
          ${!p.is_default ? `<button class="btn" data-action="default">Make default</button>` : ""}
          ${!isShared && !p.is_default ? `<button class="btn btn-danger" data-action="delete">Delete</button>` : ""}
        </div>
      `;
      $$("button[data-action]", card).forEach(btn => {
        btn.addEventListener("click", () => {
          const action = btn.dataset.action;
          if (action === "switch") switchProject(p.id);
          else if (action === "rename") renameProject(p);
          else if (action === "delete") deleteProject(p);
          else if (action === "default") setProjectDefault(p);
          else if (action === "share") openShareModal(p);
        });
      });
      grid.appendChild(card);
    };

    state.projects.forEach(p => {
      // Shared section = projects shared TO me, AND projects I own
      // that have any active or pending shares (collaborative workspaces).
      const hasShares = (p.share_active_count || 0) + (p.share_pending_count || 0) > 0;
      if (p.is_shared || hasShares) renderCard(p, sharedGrid);
      else                          renderCard(p, ownedGrid);
    });

    // "+ New project" card in My Projects section.
    const create = document.createElement("button");
    create.className = "project-card-create";
    create.type = "button";
    create.innerHTML = "+ New project";
    create.addEventListener("click", promptCreateProject);
    ownedGrid.appendChild(create);

    // "+ Create shared project" card in Shared Projects section.
    const createShared = document.createElement("button");
    createShared.className = "project-card-create project-card-create-shared";
    createShared.type = "button";
    createShared.innerHTML = "+ Create shared project";
    createShared.addEventListener("click", openCreateSharedModal);
    sharedGrid.appendChild(createShared);
  }

  // -------- "+ Create shared project" modal --------
  function openCreateSharedModal() {
    closeShareModal();
    const overlay = document.createElement("div");
    overlay.className = "share-modal-overlay";
    overlay.id = "share-modal-overlay";
    overlay.innerHTML = `
      <div class="share-modal" role="dialog" aria-labelledby="create-shared-title">
        <button type="button" class="share-modal-close" aria-label="Close">×</button>
        <h2 id="create-shared-title" class="share-modal-title">Create Shared Project</h2>
        <p class="share-modal-hint">
          Spin up a new project and invite a Velosify user to collaborate
          on it from day one. They'll see an invitation on their Projects page
          and decide whether to accept.
        </p>
        <div class="share-modal-field">
          <label for="create-shared-name">Project name</label>
          <input id="create-shared-name" type="text" autocomplete="off"
                 maxlength="60" placeholder="e.g. Tampa Plumbers (Q3)" />
        </div>
        <div class="share-modal-field">
          <label for="create-shared-identifier">Collaborator email or username</label>
          <input id="create-shared-identifier" type="text" autocomplete="off"
                 placeholder="teammate@example.com" />
        </div>
        <div class="share-modal-result" id="create-shared-result" hidden></div>
        <div class="share-modal-actions">
          <button type="button" class="btn share-modal-cancel">Cancel</button>
          <button type="button" class="btn btn-primary create-shared-send">Create &amp; Invite</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    setTimeout(() => document.getElementById("create-shared-name")?.focus(), 0);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeShareModal();
    });
    overlay.querySelector(".share-modal-close")?.addEventListener("click", closeShareModal);
    overlay.querySelector(".share-modal-cancel")?.addEventListener("click", closeShareModal);
    overlay.querySelector(".create-shared-send")?.addEventListener("click", submitCreateShared);
    overlay.querySelectorAll("input").forEach(inp => {
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); submitCreateShared(); }
      });
    });
  }
  async function submitCreateShared() {
    const sendBtn = document.querySelector(".create-shared-send");
    // Guard against rapid double-clicks / Enter spam — bail if already in flight.
    if (sendBtn?.disabled) return;
    const name = (document.getElementById("create-shared-name")?.value || "").trim();
    const identifier = (document.getElementById("create-shared-identifier")?.value || "").trim();
    const resultEl = document.getElementById("create-shared-result");
    if (!name) {
      resultEl.hidden = false;
      resultEl.className = "share-modal-result share-err";
      resultEl.textContent = "Enter a project name.";
      return;
    }
    if (!identifier) {
      resultEl.hidden = false;
      resultEl.className = "share-modal-result share-err";
      resultEl.textContent = "Enter a collaborator email or username.";
      return;
    }
    sendBtn.disabled = true;
    sendBtn.textContent = "Creating…";
    try {
      const r = await fetch("/api/projects/shared", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, identifier }),
      });
      const j = await r.json();
      if (!r.ok) {
        resultEl.hidden = false;
        resultEl.className = "share-modal-result share-err";
        resultEl.textContent = j.error || "Couldn't create the project.";
        return;
      }
      const inviteeName = ((j.invited_user?.first_name || "") + " " + (j.invited_user?.last_name || "")).trim()
                          || j.invited_user?.username || identifier;
      toast(`Created "${j.name}" and invited ${inviteeName}.`);
      closeShareModal();
      // Refresh projects so the new project (owned) shows up in My Projects.
      const pr = await fetch("/api/projects", { credentials: "same-origin" });
      const pj = await pr.json();
      state.projects = pj.projects || [];
      state.currentProjectId = pj.current_id ?? state.currentProjectId;
      renderProjectSwitcher();
      renderProjectsView();
    } catch {
      resultEl.hidden = false;
      resultEl.className = "share-modal-result share-err";
      resultEl.textContent = "Network error.";
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = "Create & Invite";
    }
  }

  // -------- Pending share invitations banner (Projects view) --------
  async function renderPendingSharesBanner() {
    const host = document.getElementById("view-projects");
    if (!host) return;
    let pending = [];
    try {
      const r = await fetch("/api/me/pending-shares", { credentials: "same-origin" });
      if (!r.ok) return;
      const j = await r.json();
      pending = j.pending || [];
    } catch { return; }
    // Clear ALL banners right before insert — handles the race where two
    // in-flight calls both saw "no existing banner" and would otherwise
    // double-insert. Doing it post-fetch is the only safe spot.
    host.querySelectorAll(".pending-shares-banner").forEach(el => el.remove());
    if (!pending.length) return;
    const banner = document.createElement("div");
    banner.className = "pending-shares-banner";
    banner.innerHTML = `
      <div class="pending-shares-label">
        ${pending.length === 1 ? "1 project invitation" : `${pending.length} project invitations`}
      </div>
      <div class="pending-shares-list">
        ${pending.map(s => {
          const ownerName = (((s.owner_first_name || "") + " " + (s.owner_last_name || "")).trim()
                             || s.owner_username || s.owner_email || "someone");
          return `
            <div class="pending-share-row" data-pid="${s.project_id}">
              <div class="pending-share-info">
                <strong>${escapeHtml(ownerName)}</strong> wants to share
                <strong>${escapeHtml(s.project_name)}</strong> with you.
              </div>
              <div class="pending-share-actions">
                <button type="button" class="btn btn-primary btn-sm pending-accept-btn" data-pid="${s.project_id}">Accept</button>
                <button type="button" class="btn btn-sm pending-decline-btn" data-pid="${s.project_id}">Decline</button>
              </div>
            </div>
          `;
        }).join("")}
      </div>
    `;
    host.insertBefore(banner, host.firstChild);
  }

  // Accept / decline handlers — event delegation so we don't need to
  // re-attach listeners when the banner re-renders.
  document.addEventListener("click", async (e) => {
    const accept = e.target.closest(".pending-accept-btn");
    if (accept) {
      const pid = accept.dataset.pid;
      accept.disabled = true;
      accept.textContent = "Accepting…";
      try {
        const r = await fetch(`/api/me/pending-shares/${pid}/accept`, {
          method: "POST", credentials: "same-origin",
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          toast(j.error || "Couldn't accept.", "error");
          return;
        }
        toast("Joined the shared project.");
        const pr = await fetch("/api/projects", { credentials: "same-origin" });
        const pj = await pr.json();
        state.projects = pj.projects || [];
        state.currentProjectId = pj.current_id ?? state.currentProjectId;
        renderProjectSwitcher();
        renderProjectsView();
      } catch {
        toast("Network error.", "error");
      }
      return;
    }
    const decline = e.target.closest(".pending-decline-btn");
    if (decline) {
      const pid = decline.dataset.pid;
      decline.disabled = true;
      decline.textContent = "Declining…";
      try {
        await fetch(`/api/me/pending-shares/${pid}/decline`, {
          method: "POST", credentials: "same-origin",
        });
        toast("Invitation declined.");
        renderPendingSharesBanner();
      } catch {
        toast("Network error.", "error");
      }
    }
  });

  // -------- Share Project modal (owner-side) --------
  function openShareModal(project) {
    closeShareModal();
    const overlay = document.createElement("div");
    overlay.className = "share-modal-overlay";
    overlay.id = "share-modal-overlay";
    overlay.innerHTML = `
      <div class="share-modal" role="dialog" aria-labelledby="share-modal-title">
        <button type="button" class="share-modal-close" aria-label="Close">×</button>
        <h2 id="share-modal-title" class="share-modal-title">Share "${escapeHtml(project.name)}"</h2>
        <p class="share-modal-hint">
          Enter the email or username of another Velosify user. They'll see an
          invitation on their Projects page and decide whether to accept.
        </p>
        <div class="share-modal-field">
          <label for="share-modal-input">Email or username</label>
          <input id="share-modal-input" type="text" autocomplete="off"
                 placeholder="teammate@example.com" />
        </div>
        <div class="share-modal-result" id="share-modal-result" hidden></div>

        <div class="share-modal-section">
          <div class="share-modal-section-label">Currently shared with</div>
          <div class="share-modal-list" id="share-modal-list">
            <div class="share-modal-empty">Loading…</div>
          </div>
        </div>

        <div class="share-modal-actions">
          <button type="button" class="btn share-modal-cancel">Close</button>
          <button type="button" class="btn btn-primary share-modal-send" data-pid="${project.id}">Send invite</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    setTimeout(() => document.getElementById("share-modal-input")?.focus(), 0);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeShareModal();
    });
    overlay.querySelector(".share-modal-close")?.addEventListener("click", closeShareModal);
    overlay.querySelector(".share-modal-cancel")?.addEventListener("click", closeShareModal);
    overlay.querySelector(".share-modal-send")?.addEventListener("click", () => sendShareInvite(project.id));
    document.getElementById("share-modal-input")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); sendShareInvite(project.id); }
    });
    loadShareModalList(project.id);
  }
  function closeShareModal() {
    document.getElementById("share-modal-overlay")?.remove();
  }
  async function loadShareModalList(pid) {
    const listEl = document.getElementById("share-modal-list");
    if (!listEl) return;
    try {
      const r = await fetch(`/api/projects/${pid}/shares`, { credentials: "same-origin" });
      if (!r.ok) { listEl.innerHTML = `<div class="share-modal-empty">Couldn't load.</div>`; return; }
      const j = await r.json();
      const shares = j.shares || [];
      if (!shares.length) {
        listEl.innerHTML = `<div class="share-modal-empty">Not shared with anyone yet.</div>`;
        return;
      }
      const fullName = (u) =>
        ((u.first_name || "") + " " + (u.last_name || "")).trim() || u.username;
      listEl.innerHTML = shares.map(s => `
        <div class="share-modal-row" data-uid="${s.user_id}">
          <div class="share-modal-row-info">
            <div class="share-modal-row-name">${escapeHtml(fullName(s))}</div>
            <div class="share-modal-row-meta">
              @${escapeHtml(s.username)} · ${escapeHtml(s.email || "")}
              ${s.status === "pending" ? '<span class="share-pending-pill">Pending</span>' : ""}
            </div>
          </div>
          <button type="button" class="btn btn-sm btn-danger-soft share-modal-remove-btn"
                  data-uid="${s.user_id}" data-pid="${pid}">Remove</button>
        </div>
      `).join("");
      listEl.querySelectorAll(".share-modal-remove-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
          const uid = btn.dataset.uid;
          if (!confirm("Remove this user? They'll lose access immediately.")) return;
          await fetch(`/api/projects/${pid}/shares/${uid}`, {
            method: "DELETE", credentials: "same-origin",
          });
          loadShareModalList(pid);
        });
      });
    } catch {
      listEl.innerHTML = `<div class="share-modal-empty">Network error.</div>`;
    }
  }
  async function sendShareInvite(pid) {
    const input = document.getElementById("share-modal-input");
    const resultEl = document.getElementById("share-modal-result");
    const sendBtn = document.querySelector(".share-modal-send");
    const identifier = (input?.value || "").trim();
    if (!identifier) {
      resultEl.hidden = false;
      resultEl.className = "share-modal-result share-err";
      resultEl.textContent = "Enter an email or username.";
      return;
    }
    sendBtn.disabled = true;
    sendBtn.textContent = "Sending…";
    try {
      const r = await fetch(`/api/projects/${pid}/shares`, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier }),
      });
      const j = await r.json();
      if (!r.ok) {
        resultEl.hidden = false;
        resultEl.className = "share-modal-result share-err";
        resultEl.textContent = j.error || "Couldn't send the invite.";
      } else {
        resultEl.hidden = false;
        resultEl.className = "share-modal-result share-ok";
        const name = ((j.user?.first_name || "") + " " + (j.user?.last_name || "")).trim()
                     || j.user?.username || identifier;
        if (j.already_shared) {
          resultEl.textContent = j.status === "pending"
            ? `${name} already has a pending invitation.`
            : `${name} already has access.`;
        } else {
          resultEl.textContent = `Invitation sent to ${name}. They'll see it on their Projects page.`;
          input.value = "";
        }
        loadShareModalList(pid);
      }
    } catch {
      resultEl.hidden = false;
      resultEl.className = "share-modal-result share-err";
      resultEl.textContent = "Network error.";
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = "Send invite";
    }
  }

  // ------- Lead Generator -------
  // Sentinel value for the "+ Create new list..." option. Picking it opens
  // a prompt; on confirm we add the new option and select it.
  const LG_NEW_LIST = "__velosify_new_list__";

  // Populates the Lead Generator country dropdown with flagged country
  // options. Called from both renderLeadGenView (when LG opens) and
  // loadSettings (when /api/me caches the payload).
  function populateLeadGenCountry(me) {
    const sel = document.getElementById("lg-country");
    if (!sel || !me) return;
    if (sel.dataset.populated === "1" && sel.dataset.cc === (me.country || "")) return;
    sel.innerHTML = "";
    const opts = me.country_options || [{ code: "US", label: "United States", flag: "🇺🇸" }];
    opts.forEach(opt => {
      const o = document.createElement("option");
      o.value = opt.code;
      // Flag emoji + space + name reads nicely in native selects on
      // every modern OS. Some Windows versions render emoji as
      // monochrome but the country name is still clear.
      o.textContent = `${opt.flag || ""} ${opt.label}`.trim();
      sel.appendChild(o);
    });
    sel.value = me.country || "US";
    sel.dataset.populated = "1";
    sel.dataset.cc = me.country || "";
  }

  async function renderLeadGenView() {
    // Mode is set by the sidebar sub-nav (Free / Pro). It's independent of
    // whether the user has saved a key — we honor the user's explicit choice.
    const mode = state.leadgenMode === "pro" ? "pro" : "free";
    // Make sure the country dropdown is populated. If /api/me has been
    // cached (loadSettings ran), use it; otherwise fetch fresh.
    if (window._velosifyMeCache) {
      populateLeadGenCountry(window._velosifyMeCache);
    } else {
      try {
        const me = await api.get("/api/me");
        window._velosifyMeCache = me;
        populateLeadGenCountry(me);
      } catch { /* not fatal */ }
    }
    const meta = state.meta || {};
    const hasKey = !!meta.lead_generator_pro_enabled;
    const freeEnabled = !!meta.lead_generator_free_enabled;
    const freeQuota = meta.lead_generator_free_quota || 0;
    const freeRemaining = meta.lead_generator_free_remaining || 0;
    const freeReset = meta.lead_generator_free_reset || "";
    const bonusCredits = meta.lead_generator_bonus_credits || 0;
    const isPro = mode === "pro";

    // --- Tier UI ---
    const badge = $("#lg-tier-badge");
    const hint = $("#lg-hint");
    const countHelp = $("#lg-count-help");
    if (badge) {
      if (isPro) {
        badge.textContent = "⚡ Pro (Google Maps)";
      } else if (freeEnabled) {
        // With a bonus pool the X/Y badge ("1100/100 leads left") looks
        // nonsensical because remaining exceeds the monthly quota. Drop
        // the denominator when there are bonus credits and just show the
        // total. Otherwise keep the familiar X/quota readout.
        badge.textContent = bonusCredits > 0
          ? `Starter · ${freeRemaining} leads left`
          : `Starter · ${freeRemaining}/${freeQuota} leads left`;
      } else {
        badge.textContent = "Starter (disabled)";
      }
      badge.classList.toggle("pro", isPro);
    }
    if (hint) {
      if (isPro && hasKey) {
        hint.textContent = "Type a ZIP code and an industry. Searches use your Google Places key — your own Google credit covers the cost.";
      } else if (isPro && !hasKey) {
        hint.textContent = "Pro uses your own Google Places API key — no quotas, your own bill. Add a key below to start.";
      } else if (freeEnabled) {
        hint.textContent = bonusCredits > 0
          ? `Type a ZIP code and an industry. You have ${freeRemaining} leads available — includes a ${bonusCredits}-credit starter pack that doesn't reset.`
          : `Type a ZIP code and an industry. Starter tier gives you ${freeQuota} leads per month from Google Maps. ${freeRemaining} left this month — resets ${freeReset}.`;
      } else {
        hint.textContent = "Starter tier isn't enabled on this server. Switch to Pro in the sidebar and add your own Google Places API key.";
      }
    }
    if (countHelp) {
      if (isPro) {
        countHelp.textContent = "Up to 60 results per search (Google's hard cap).";
      } else if (freeEnabled) {
        countHelp.textContent = `Up to 60 per search — capped by your remaining ${freeRemaining} Starter leads this month.`;
      } else {
        countHelp.textContent = "Up to 60 results per search.";
      }
    }

    // The form itself. Hidden when:
    //   - Pro mode and user has no key
    //   - Free mode and the server has no admin key configured
    //   - Free mode and the user is out of monthly credits
    const form = $("#leadgen-form");
    const submitBtn = $("#lg-submit");
    const blocked = (isPro && !hasKey) || (!isPro && !freeEnabled) || (!isPro && freeRemaining <= 0);
    if (submitBtn) submitBtn.disabled = blocked;
    if (form) form.classList.toggle("hidden", blocked);
    // Cap the max-leads input to whatever's remaining in Free mode.
    const countInput = $("#lg-count");
    if (countInput && !isPro && freeEnabled) {
      const cap = Math.max(1, Math.min(60, freeRemaining || 1));
      countInput.max = String(cap);
      if (Number(countInput.value || 60) > cap) countInput.value = cap;
    } else if (countInput && isPro) {
      countInput.max = "60";
    }

    // Populate the list dropdown.
    const select = $("#lg-list");
    if (select) {
      const previousValue = select.value;
      const existing = [...new Set(state.contacts.map(contactList))].sort();
      [...select.options].forEach(o => {
        if (o.value && o.value !== LG_NEW_LIST && !existing.includes(o.value)) {
          existing.push(o.value);
        }
      });
      const opts = [];
      if (existing.length === 0) {
        opts.push(`<option value="Inbox">Inbox</option>`);
      }
      for (const name of existing.sort()) {
        opts.push(`<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`);
      }
      opts.push(`<option value="${LG_NEW_LIST}">+ Create new list…</option>`);
      select.innerHTML = opts.join("");
      if (previousValue && [...select.options].some(o => o.value === previousValue)) {
        select.value = previousValue;
      }
    }

    // --- Upgrade / Pro cards ---
    // Show the upgrade card in:
    //   - Pro mode without key (call to action: add a key)
    //   - Free mode when out of credits or Free is disabled (encourage upgrade)
    // Show the Pro management card in Pro mode with a key.
    const upgradeCard = $("#lg-upgrade-card");
    const proCard = $("#lg-pro-card");
    const showUpgrade = (isPro && !hasKey) || (!isPro && (!freeEnabled || freeRemaining <= 0));
    if (upgradeCard) upgradeCard.classList.toggle("hidden", !showUpgrade);
    if (proCard) proCard.classList.toggle("hidden", !(isPro && hasKey));

    if (isPro && hasKey) {
      try {
        const info = await api.get("/api/me/places-key");
        const previewEl = $("#lg-key-preview");
        if (previewEl) previewEl.textContent = info.preview || "AIza…";
      } catch {}
    }
  }

  // Prompt for an API key, save it, refresh meta + view.
  async function promptForApiKey(opts = {}) {
    const current = opts.current ? "Replace your existing API key. " : "";
    const key = window.prompt(
      current +
      "Paste your Google Places API key (starts with \"AIza\").\n\n" +
      "If you don't have one yet:\n" +
      "  1. console.cloud.google.com → New Project\n" +
      "  2. Enable the Places API\n" +
      "  3. Add billing\n" +
      "  4. APIs & Services → Credentials → Create API key\n" +
      "  5. Restrict it to Places API\n" +
      "  6. Copy and paste here."
    );
    if (!key || !key.trim()) return;
    try {
      const res = await fetch("/api/me/places-key", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: key.trim() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Couldn't save key.");
      // Refresh meta so the tier flips, then re-render the view.
      state.meta.lead_generator_tier = "google";
      toast("API key saved — you're on Pro now.");
      await loadAll();
      if (state.view === "leadgen") renderLeadGenView();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function removeApiKey() {
    const ok = window.confirm(
      "Remove your Google Places API key?\n\n" +
      "You'll drop back to the free OpenStreetMap tier. Coverage will be lower " +
      "but you can add a key again any time."
    );
    if (!ok) return;
    try {
      const res = await fetch("/api/me/places-key", { method: "DELETE" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed.");
      state.meta.lead_generator_tier = "osm";
      toast("API key removed — back to Starter tier.");
      await loadAll();
      if (state.view === "leadgen") renderLeadGenView();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  // Wire the form (one-time at startup; re-renders happen via DOM updates).
  document.addEventListener("DOMContentLoaded", () => {
    const form = document.getElementById("leadgen-form");
    if (!form) return;
    const industryInput = document.getElementById("lg-industry");
    const listSelect = document.getElementById("lg-list");

    // Upgrade / replace / remove buttons in the Pro card.
    document.getElementById("lg-add-key")?.addEventListener("click", () => promptForApiKey());
    document.getElementById("lg-replace-key")?.addEventListener("click", () => promptForApiKey({ current: true }));
    document.getElementById("lg-remove-key")?.addEventListener("click", () => removeApiKey());

    // --- City type-ahead for the "Postal code or city" field --------
    // Hits /api/places/autocomplete (Google's Places Autocomplete proxy)
    // and shows a dropdown of {City, ST, Country} suggestions. Tackles
    // the ambiguous-city problem ("Utica" → NY vs MI) by letting the user
    // pick the exact one before searching.
    // Exposed via window.lgCity so the submit handler can check whether
    // the user actually picked a real Google-confirmed city vs. just
    // typed something that LOOKS like "City, ST".
    window.lgCity = window.lgCity || { picked: false };
    (function wireCityAutocomplete() {
      const input = document.getElementById("lg-zip");
      const panel = document.getElementById("lg-zip-suggestions");
      const countrySel = document.getElementById("lg-country");
      if (!input || !panel) return;
      let debounceTimer = null;
      let activeIndex = -1;
      let lastQuery = "";
      let inFlight = null;
      let suppressNext = false;
      function clearPanel() {
        panel.innerHTML = "";
        panel.hidden = true;
        activeIndex = -1;
      }
      function showLoading() {
        panel.innerHTML = `<li class="autocomplete-empty">Searching…</li>`;
        panel.hidden = false;
      }
      function showEmpty() {
        panel.innerHTML = `<li class="autocomplete-empty">No matches — try a different spelling or add a state code.</li>`;
        panel.hidden = false;
      }
      function render(items) {
        if (!items.length) { showEmpty(); return; }
        panel.innerHTML = items.map((it, i) =>
          `<li class="autocomplete-item" role="option" data-idx="${i}" data-desc="${escapeHtml(it.description)}">` +
            `<span class="ac-pin" aria-hidden="true">📍</span>` +
            `<span>${escapeHtml(it.description)}</span>` +
          `</li>`
        ).join("");
        panel.hidden = false;
        activeIndex = -1;
      }
      function setActive(idx) {
        const items = panel.querySelectorAll(".autocomplete-item");
        if (!items.length) return;
        activeIndex = (idx + items.length) % items.length;
        items.forEach((el, i) => el.setAttribute("aria-selected", i === activeIndex ? "true" : "false"));
        items[activeIndex]?.scrollIntoView({ block: "nearest" });
      }
      function pick(item) {
        if (!item) return;
        const desc = item.dataset?.desc || item.getAttribute("data-desc") || "";
        if (!desc) return;
        // Google returns "Utica, NY, USA" — strip the trailing country
        // so we get the cleaner "Utica, NY" that the user actually wants
        // in the field (and the country dropdown already scopes it).
        const cleaned = desc.replace(/,\s*(USA|United States|Canada|United Kingdom|UK)\s*$/i, "");
        suppressNext = true; // prevent the input event we're about to trigger from re-opening the panel
        input.value = cleaned;
        // Mark that the user committed to a real, Google-confirmed city.
        // Any subsequent keystroke (the input handler below) clears this.
        window.lgCity.picked = true;
        window.lgCity.pickedValue = cleaned;
        clearPanel();
        input.focus();
      }
      async function fetchSuggestions(q) {
        const country = (countrySel?.value || "US").trim() || "US";
        // Abort any pending request — only the latest keystroke matters.
        if (inFlight) try { inFlight.abort(); } catch {}
        const ctrl = new AbortController();
        inFlight = ctrl;
        try {
          const r = await fetch(
            `/api/places/autocomplete?q=${encodeURIComponent(q)}&country=${encodeURIComponent(country)}`,
            { credentials: "same-origin", signal: ctrl.signal },
          );
          if (!r.ok) { clearPanel(); return; }
          const items = await r.json();
          // Discard if the user has typed more since we fired.
          if (q !== input.value.trim()) return;
          render(Array.isArray(items) ? items : []);
        } catch (err) {
          if (err.name !== "AbortError") clearPanel();
        }
      }
      input.addEventListener("input", () => {
        if (suppressNext) { suppressNext = false; return; }
        const q = input.value.trim();
        // Any keystroke after a successful pick invalidates it — if the
        // user edited the value after picking 'Utica, NY' they need to
        // either pick again or fall back to a ZIP. Prevents 'Uticaaa, NY'
        // typos from sneaking past validation.
        if (window.lgCity.picked && q !== window.lgCity.pickedValue) {
          window.lgCity.picked = false;
        }
        lastQuery = q;
        clearTimeout(debounceTimer);
        if (q.length < 2) { clearPanel(); return; }
        // Pure-digit ZIP codes don't need autocomplete (one-to-one already)
        if (/^\d+$/.test(q)) { clearPanel(); return; }
        showLoading();
        // 250ms debounce — only fires when user pauses typing.
        debounceTimer = setTimeout(() => fetchSuggestions(q), 250);
      });
      input.addEventListener("keydown", (e) => {
        if (panel.hidden) return;
        const items = panel.querySelectorAll(".autocomplete-item");
        if (e.key === "ArrowDown") { e.preventDefault(); setActive(activeIndex + 1); return; }
        if (e.key === "ArrowUp")   { e.preventDefault(); setActive(activeIndex - 1); return; }
        if (e.key === "Enter" && activeIndex >= 0) { e.preventDefault(); pick(items[activeIndex]); return; }
        if (e.key === "Escape") { clearPanel(); return; }
      });
      panel.addEventListener("mousedown", (e) => {
        // mousedown (not click) so it fires BEFORE the input's blur
        // event tries to close us.
        const item = e.target.closest(".autocomplete-item");
        if (item) { e.preventDefault(); pick(item); }
      });
      input.addEventListener("blur", () => {
        // Small delay so a click on a suggestion still registers.
        setTimeout(() => clearPanel(), 120);
      });
      // Reset when the country dropdown changes — old suggestions are stale.
      countrySel?.addEventListener("change", () => {
        clearPanel();
        // Different country = the previous pick no longer applies.
        window.lgCity.picked = false;
        if (input.value.trim().length >= 2 && !/^\d+$/.test(input.value.trim())) {
          fetchSuggestions(input.value.trim());
        }
      });
    })();

    // When the user picks "+ Create new list…", prompt for a name. Suggested
    // default is "<Industry> (<City, State>)" — pulls from the postal-code/
    // city field so the list name reflects WHERE the leads came from, not
    // just the source (everything is Google Maps now anyway).
    listSelect?.addEventListener("change", () => {
      if (listSelect.value !== LG_NEW_LIST) return;
      const industry = (industryInput?.value || "").trim();
      const where = (document.getElementById("lg-zip")?.value || "").trim();
      const titleCase = (s) => s.replace(/\b\w/g, c => c.toUpperCase());
      // Format the location nicely:
      //   "Utica NY"        → "Utica, NY"
      //   "Utica, NY 13501" → "Utica, NY"
      //   "13501"           → "13501"  (just keep as-is)
      //   "san francisco ca"→ "San Francisco, CA"
      const formatWhere = (raw) => {
        if (!raw) return "";
        const cleaned = raw.replace(/\s+\d{4,}\s*$/, "").trim(); // strip trailing ZIP
        if (/^\d/.test(cleaned)) return cleaned; // pure numeric ZIP — leave alone
        // Try to split into "city" + "state" (2-letter state abbrev at end)
        const m = cleaned.match(/^(.*?)[,\s]+([A-Za-z]{2})$/);
        if (m) {
          const city = titleCase(m[1].trim());
          const state = m[2].toUpperCase();
          return `${city}, ${state}`;
        }
        return titleCase(cleaned);
      };
      const industryTitle = industry ? titleCase(industry) : "";
      const whereFormatted = formatWhere(where);
      const suggested = industryTitle && whereFormatted
        ? `${industryTitle} (${whereFormatted})`
        : industryTitle || "";
      const name = window.prompt("Name your new list:", suggested);
      if (!name || !name.trim()) {
        // User cancelled — revert to whatever was selected before, or the first option.
        listSelect.value = listSelect.options[0]?.value || "";
        return;
      }
      const trimmed = name.trim();
      const existing = [...listSelect.options].map(o => o.value);
      if (!existing.includes(trimmed)) {
        const opt = document.createElement("option");
        opt.value = trimmed;
        opt.textContent = trimmed;
        const newRow = listSelect.querySelector(`option[value="${LG_NEW_LIST}"]`);
        listSelect.insertBefore(opt, newRow);
      }
      listSelect.value = trimmed;
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const submit = document.getElementById("lg-submit");
      const result = document.getElementById("lg-result");
      const labelEl = submit?.querySelector(".lg-submit-label");
      const original = labelEl ? labelEl.textContent : "";
      // If somehow the user submits with the sentinel still selected, prompt now.
      if (listSelect && listSelect.value === LG_NEW_LIST) {
        listSelect.dispatchEvent(new Event("change"));
        if (listSelect.value === LG_NEW_LIST) return;  // they cancelled
      }

      // The only ways the form is allowed to submit:
      //   1. Pure numeric ZIP/postal code (unambiguous on its own).
      //   2. A confirmed Google-Places dropdown pick — tracked by
      //      window.lgCity.picked. Just shape-matching "City, ST" is
      //      not enough: a user could type "Uticaaa, NY" and the regex
      //      would pass even though the city doesn't exist (Google
      //      would silently match to nearest real city).
      const zipVal = document.getElementById("lg-zip").value.trim();
      const isNumericZip   = /^\d{4,10}$/.test(zipVal);
      const isConfirmedPick = window.lgCity?.picked && zipVal === window.lgCity.pickedValue;
      if (!isNumericZip && !isConfirmedPick) {
        if (result) {
          result.innerHTML =
            `<div class="lg-error">Please enter a <strong>Zip code</strong> or <strong>pick a City, State</strong> from the suggestions list. Typing a city manually won't work — you need to select an actual city from Google so we know exactly which one to search.</div>`;
        } else {
          alert("Please enter a Zip code or pick a City, State from the suggestions. Typing manually won't work.");
        }
        const input = document.getElementById("lg-zip");
        input?.focus();
        // Trigger the autocomplete so the dropdown opens immediately.
        if (input && input.value.trim().length >= 2 && !/^\d+$/.test(input.value.trim())) {
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
        return;
      }
      // Send the explicit tier the user picked in the sidebar so the server
      // honors their choice rather than auto-detecting from their key state.
      const mode = state.leadgenMode === "pro" ? "pro" : "free";
      const tierParam = mode === "pro" ? "google" : "osm";
      const payload = {
        zip: document.getElementById("lg-zip").value.trim(),
        query: industryInput.value.trim(),
        list_name: listSelect?.value.trim() || "",
        count: Number(document.getElementById("lg-count").value || 60),
        tier: tierParam,
        // The Lead Generator's own country dropdown — server-side this
        // overrides the user's profile country for this search AND
        // gets persisted as their new default. No separate save step.
        country: document.getElementById("lg-country")?.value || "",
      };
      const sourceName = mode === "pro" ? "Google Maps" : "OpenStreetMap";
      if (submit) submit.disabled = true;
      if (labelEl) labelEl.textContent = `Searching ${sourceName}…`;
      if (result) {
        result.classList.remove("hidden", "error");
        result.textContent = `Searching ${sourceName} for "${payload.query}" in ${payload.zip}…`;
      }
      try {
        // Auto-retry once on a transient gateway timeout (502/504). Free-tier
        // OSM data sometimes hiccups on the first try and works on the second.
        let body;
        let attempts = 0;
        const maxAttempts = 2;
        while (true) {
          attempts++;
          try {
            body = await _safeFetchJson("/api/lead-generator/search", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });
            break;  // success
          } catch (e) {
            const isTransient = /\b50[24]\b|timed out/i.test(e.message);
            if (!isTransient || attempts >= maxAttempts) throw e;
            if (result) {
              result.classList.remove("error");
              result.textContent = `${sourceName} was slow — retrying…`;
            }
            await new Promise(r => setTimeout(r, 2500));
          }
        }
        // Both Free and Pro use Google Maps now; the only difference is whose
        // API key powers it.
        const providerName = body.provider === "pro" ? "Google Maps (Pro)" : "Google Maps (Starter)";
        const parts = [];
        parts.push(`Found ${body.total_found} businesses via ${providerName}`);
        parts.push(`imported ${body.imported}`);
        if (body.skipped) parts.push(`skipped ${body.skipped} duplicate${body.skipped === 1 ? "" : "s"}`);
        if (typeof body.free_remaining === "number") {
          parts.push(`${body.free_remaining} Starter leads left this month`);
        }
        const summary = parts.join(", ") + ".";
        // Sync meta so the badge in the header updates the next render.
        if (typeof body.free_remaining === "number") {
          state.meta.lead_generator_free_used = body.free_used;
          state.meta.lead_generator_free_remaining = body.free_remaining;
          state.meta.lead_generator_free_reset = body.free_reset;
        }
        if (result) {
          result.classList.remove("error");
          result.innerHTML =
            `<strong>${escapeHtml(summary)}</strong><br>` +
            `Added to <strong>"${escapeHtml(body.list_name)}"</strong>. ` +
            `<a href="#" id="lg-go-contacts">View in Contacts →</a>`;
          $("#lg-go-contacts")?.addEventListener("click", (ev) => {
            ev.preventDefault();
            state.contactList = body.list_name;
            switchView("contacts");
          });
        }
        toast(summary);
        // Refresh data so contacts page reflects the new entries.
        await loadAll();
      } catch (err) {
        if (result) {
          result.classList.add("error");
          result.textContent = "Error: " + err.message;
        }
        toast(err.message, "error");
      } finally {
        if (submit) submit.disabled = false;
        if (labelEl) labelEl.textContent = original || "⌖ Generate leads";
      }
    });
  });

  // ------- Navigation -------
  function switchView(view) {
    // Superadmin-only views — Admin Panel is restricted to the founder
    // (nolan201). Belt-and-suspenders against direct JS calls bypassing the
    // hidden nav button.
    const superAdminViews = new Set(["users"]);
    if (superAdminViews.has(view) && !state._isSuperAdmin) {
      view = "dashboard";
    }
    state.view = view;
    $$(".nav-item").forEach(b => {
      // For sub-nav items (Free/Pro under Lead Generator, or
      // Profile/Billing under Settings), the active item is the one
      // whose mode matches the current sub-state.
      let isActive = b.dataset.view === view;
      if (b.dataset.leadgenMode) {
        isActive = isActive && b.dataset.leadgenMode === state.leadgenMode;
      }
      if (b.dataset.settingsMode) {
        isActive = isActive && b.dataset.settingsMode === state.settingsMode;
      }
      if (b.dataset.gameMode) {
        isActive = isActive && b.dataset.gameMode === state.gameMode;
      }
      if (b.dataset.scriptMode) {
        isActive = isActive && b.dataset.scriptMode === state.scriptMode;
      }
      b.classList.toggle("active", isActive);
    });
    $$(".view").forEach(v => v.classList.toggle("active", v.id === `view-${view}`));
    // Only show the script-card matching the current scriptMode.
    if (view === "scripts") {
      $$(".script-card").forEach(card => {
        card.classList.toggle("hidden", card.dataset.scriptPane !== state.scriptMode);
      });
    }
    // Lead Generator + Settings sidebar groups: open when we're on them,
    // collapse when we leave so the sidebar doesn't keep showing
    // Starter/Pro or Profile/Billing after navigating away.
    const toggleSection = (toggleId, childrenId, isActive) => {
      const t = $("#" + toggleId);
      const c = $("#" + childrenId);
      if (!t || !c) return;
      if (isActive) {
        t.setAttribute("aria-expanded", "true");
        c.classList.remove("collapsed");
      } else {
        t.setAttribute("aria-expanded", "false");
        c.classList.add("collapsed");
      }
    };
    toggleSection("leadgen-section-toggle", "leadgen-section-children", view === "leadgen");
    toggleSection("settings-section-toggle", "settings-section-children", view === "settings");
    toggleSection("scripts-section-toggle", "scripts-section-children", view === "scripts");
    toggleSection("games-section-toggle", "games-section-children", view === "freegame");
    const scriptTitles = {
      "web-design":      "Scripts — Web Design",
      "seo":             "Scripts — SEO Services",
      "graphic-design":  "Scripts — Graphic Design",
      "social-media":    "Scripts — Social Media",
      "marketing-agency": "Scripts — Marketing Agency",
    };
    const titles = {
      dashboard: "Dashboard",
      deals: "Deals Pipeline",
      leadgen: state.leadgenMode === "pro"
        ? "Lead Generator Pro"
        : "Lead Generator Starter",
      contacts: "Contacts",
      companies: "Companies",
      activities: "Activities",
      scripts: scriptTitles[state.scriptMode] || "Scripts",
      freegame: state.gameMode === "blackjack" ? "Games — Blackjack"
              : state.gameMode === "chess"     ? "Games — Chess"
              : "Games — VelosiRunner",
      settings: state.settingsMode === "billing"
        ? "Settings — Billing"
        : state.settingsMode === "api-keys"
          ? "Settings — API Keys"
          : "Settings — Profile",
      users: "Admin Panel",
      projects: "Projects",
      referrals: "Referral Program",
      support: "Support",
    };
    $("#view-title").textContent = titles[view];
    // Tag the topbar with the current view so CSS can scope per-view
    // mobile overrides (e.g. hiding +New on Contacts because it lives
    // in the kebab there, while keeping it on Companies/Deals/etc.).
    document.querySelector("header.topbar")?.setAttribute("data-view", view);
    $("#search").value = "";
    state.search = "";
    // Hide the search + "New" buttons on management views. Admin Panel keeps
    // the + New button (it opens the Create User modal).
    const hideChrome = view === "settings" || view === "projects" || view === "leadgen" || view === "freegame" || view === "scripts" || view === "support" || view === "referrals";
    const hideSearch = hideChrome || view === "users";
    const hideNew = hideChrome;
    $("#search").style.display = hideSearch ? "none" : "";
    $("#new-btn").style.display = hideNew ? "none" : "";

    // Import / Export buttons — show on list views that have a CSV endpoint.
    const exportViews = { contacts: "contacts", companies: "companies", deals: "deals", activities: "activities" };
    const exportName = exportViews[view];
    const exportBtn = $("#export-btn");
    const importBtn = $("#import-btn");
    if (exportName) {
      exportBtn.removeAttribute("hidden");
      exportBtn.dataset.entity = exportName;
    } else {
      exportBtn.setAttribute("hidden", "");
    }
    // Import + Identify Lines are contacts-only. (Add-to-Pipeline and
    // Bulk-Classify moved into the bottom selection bar — they only appear
    // when the user has selected specific contacts.)
    // Identify Lines / Verify Mobiles / Custom Columns / +New contact
    // (desktop) all live inside #view-contacts itself, so they auto-
    // show/hide with the view — no JS needed.
    //
    // Topbar-resident bits still need per-view toggling:
    //   - #pd-activate-btn         : show on Contacts only
    //   - #contacts-overflow-menu  : show on Contacts only (mobile-gated by CSS)
    //   - #import-btn (topbar)     : show on Contacts (then a CSS rule
    //                                hides it because the row mirror takes
    //                                over) so the JS state stays consistent
    //                                with pre-refactor behavior. Companies/
    //                                Deals/Activities don't get Import.
    if (view === "contacts") {
      $("#import-btn")?.removeAttribute("hidden");
      $("#pd-activate-btn")?.removeAttribute("hidden");
      $("#contacts-overflow-menu")?.removeAttribute("hidden");
    } else {
      $("#import-btn")?.setAttribute("hidden", "");
      $("#pd-activate-btn")?.setAttribute("hidden", "");
      $("#contacts-overflow-menu")?.setAttribute("hidden", "");
    }

    if (view === "settings") {
      // Show only the active sub-section (Profile / API Keys / Billing). The
      // "Want it for free?" promo card under Billing funnels users
      // into the dedicated Referral Program view via its own click
      // handler — no inline referrals UI here anymore.
      const mode = state.settingsMode;
      $(".settings-section-profile")?.classList.toggle("hidden", mode !== "profile");
      $(".settings-section-api-keys")?.classList.toggle("hidden", mode !== "api-keys");
      $(".settings-section-billing")?.classList.toggle("hidden", mode !== "billing");
      loadSettings();
    }
    if (view === "referrals") loadReferrals();
    if (view === "users") loadUsers();
    if (view === "projects") renderProjectsView();
    if (view === "leadgen") renderLeadGenView();
    if (view === "freegame") {
      // Show only the active sub-game's pane; stop the others.
      const mode = state.gameMode || "runner";
      document.querySelectorAll(".freegame-pane").forEach(pane => {
        pane.hidden = pane.dataset.pane !== mode;
      });
      FreeGame.stop();
      BlackjackGame?.stop();
      ChessGame?.stop();
      if (mode === "blackjack")   BlackjackGame?.start();
      else if (mode === "chess")  ChessGame?.start();
      else FreeGame.start();
    } else {
      FreeGame.stop();
      BlackjackGame?.stop();
      ChessGame?.stop();
    }
    render();
  }

  async function loadUsers() {
    try {
      state.users = await api.get("/api/users");
      renderUsers();
    } catch (err) {
      toast("Couldn't load users: " + err.message, "error");
    }
  }

  function renderUsers() {
    const tbody = $("#users-table tbody");
    if (!tbody) return;
    // Assign fresh sequential ordinals (#1, #2, …) by signup order so
    // the IDs stay stable regardless of how the table is sorted.
    const ordinalById = new Map();
    [...state.users]
      .sort((a, b) => (a.id || 0) - (b.id || 0))
      .forEach((u, idx) => ordinalById.set(u.id, idx + 1));
    const users = sortRows(state.users, "users");
    tbody.innerHTML = "";
    users.forEach(u => {
      const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || "—";
      const created = (u.created_at || "").slice(0, 10);
      const records = `${u.company_count} co · ${u.contact_count} ct · ${u.deal_count} deals`;
      const planLabel = u.plan_label || "—";
      const planClass = u.plan_class || "none";
      const refId = `#${ordinalById.get(u.id) ?? "—"}`;
      const isFounder = !!u.grandfathered;
      const grandfatherBtn = isFounder
        ? `<button class="btn btn-sm" data-grandfather="${u.id}" data-username="${escapeHtml(u.username)}" data-enable="0" title="Remove grandfather status">Revoke Founder</button>`
        : `<button class="btn btn-sm btn-primary" data-grandfather="${u.id}" data-username="${escapeHtml(u.username)}" data-enable="1" title="Mark as grandfathered (free forever)">Make Founder</button>`;
      // Per-user toggle for the "Founder · Free forever" sidebar chip
      // and banner. Independent from grandfather status — lets a
      // grandfathered account keep its access while hiding the badge.
      // Only useful for grandfathered users (otherwise no banner shows
      // in the first place), so we only render the button for them.
      const hideBanner = !!u.hide_founder_banner;
      const hideBannerBtn = isFounder
        ? (hideBanner
            ? `<button class="btn btn-sm" data-hide-banner="${u.id}" data-username="${escapeHtml(u.username)}" data-enable="0" title="Show the Founder badge for this user again">Show Badge</button>`
            : `<button class="btn btn-sm" data-hide-banner="${u.id}" data-username="${escapeHtml(u.username)}" data-enable="1" title="Hide the Founder · Free forever badge for this user (keeps grandfather access)">Hide Badge</button>`)
        : "";
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="user-ref-id">${refId}</td>
        <td><strong>${escapeHtml(u.username)}</strong></td>
        <td>${escapeHtml(name)}</td>
        <td>${escapeHtml(u.email || "")}</td>
        <td>${escapeHtml(formatPhone(u.phone))}</td>
        <td><span class="plan-pill plan-${escapeHtml(planClass)}">${escapeHtml(planLabel)}</span></td>
        <td style="color:var(--text-dim)">${escapeHtml(created)}</td>
        <td style="color:var(--text-dim)">${escapeHtml(records)}</td>
        <td class="row-actions">
          ${grandfatherBtn}
          ${hideBannerBtn}
        </td>
      `;
      tbody.appendChild(tr);
    });
    // Grandfather / Revoke Founder toggle.
    $$("#users-table button[data-grandfather]").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = btn.dataset.grandfather;
        const uname = btn.dataset.username;
        const enable = btn.dataset.enable === "1";
        const msg = enable
          ? `Mark "${uname}" as Founder · Free forever? They'll skip the paywall and any trial countdown.`
          : `Revoke Founder status from "${uname}"? They'll see the trial / paywall banner again.`;
        if (!confirm(msg)) return;
        try {
          const res = await fetch(`/api/users/${id}/grandfather`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ grandfathered: enable }),
          });
          const body = await res.json();
          if (!res.ok) throw new Error(body.error || "Update failed.");
          toast(enable ? `${uname} upgraded to Founder` : `Founder status revoked from ${uname}`);
          loadUsers();
        } catch (err) {
          toast(err.message, "error");
        }
      });
    });
    // Hide / Show Founder badge toggle (UI-only, doesn't affect access).
    $$("#users-table button[data-hide-banner]").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = btn.dataset.hideBanner;
        const uname = btn.dataset.username;
        const enable = btn.dataset.enable === "1";  // true = hide
        try {
          const res = await fetch(`/api/users/${id}/hide-founder-banner`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ hide: enable }),
          });
          const body = await res.json();
          if (!res.ok) throw new Error(body.error || "Update failed.");
          toast(enable ? `Founder badge hidden for ${uname}` : `Founder badge restored for ${uname}`);
          loadUsers();
        } catch (err) {
          toast(err.message, "error");
        }
      });
    });
  }

  // Admin → Create user form (lives on the Users view)
  document.getElementById("admin-create-user-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      username: document.getElementById("cu-username").value.trim(),
      password: document.getElementById("cu-password").value,
      first_name: document.getElementById("cu-first").value.trim(),
      last_name: document.getElementById("cu-last").value.trim(),
      email: document.getElementById("cu-email").value.trim(),
      phone: document.getElementById("cu-phone").value.trim(),
      grandfather: document.getElementById("cu-grandfather").checked,
    };
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Couldn't create user.");
      toast(`Created ${body.username}${body.grandfathered ? " (founder)" : ""}`);
      // Clear the form for the next entry, then reload the users list.
      e.target.reset();
      document.getElementById("cu-grandfather").checked = true;
      closeCreateUserModal();
      loadUsers();
    } catch (err) {
      toast(err.message, "error");
    }
  });

  /**
   * Fetch the current user's referral state and render BOTH panels:
   * the Settings → Billing inline panel (suffix-less IDs) AND the
   * dedicated standalone view at /referrals (suffix "-page" IDs).
   * Idempotent — safe to call on every tab switch.
   */

  async function loadReferrals() {
    let data;
    try {
      const res = await fetch("/api/me/referrals");
      if (!res.ok) return;
      data = await res.json();
    } catch { return; }

    const required = data.required || 3;
    const count = Math.min(data.paid_count || 0, required);
    const pct = Math.round((count / required) * 100);

    // Render into ONE panel given its set of element-id suffixes.
    // `suffix` is "" for the Settings inline panel, "-page" for the
    // standalone Referral Program view.
    function renderPanel(suffix) {
      const id = (base) => document.getElementById(base + suffix);

      const requiredEl  = id("ref-required");
      const required2El = id("ref-required-2");
      const countEl     = id("ref-count");
      const fillEl      = id("ref-progress-fill");
      const pillEl      = id("ref-status-pill");
      const linkInput   = id("ref-link");
      const tweetBtn    = id("ref-share-tweet");
      const smsBtn      = id("ref-share-sms");
      const emailBtn    = id("ref-share-email");
      const list        = id("ref-list");
      const empty       = id("ref-empty");

      if (requiredEl)  requiredEl.textContent  = required;
      if (required2El) required2El.textContent = required;
      if (countEl)     countEl.textContent     = data.paid_count || 0;
      if (fillEl)      fillEl.style.width      = pct + "%";

      if (pillEl) {
        if (data.referral_free) {
          pillEl.textContent = "Free unlocked";
          pillEl.removeAttribute("hidden");
        } else {
          pillEl.setAttribute("hidden", "");
        }
      }

      if (linkInput) linkInput.value = data.share_link || "";

      if (tweetBtn && data.share_link) {
        const tweetText = encodeURIComponent(
          `I've been using Velosify CRM — it scrapes 18,000 leads/mo and finds owner cell phones. Try it: ${data.share_link}`
        );
        tweetBtn.href = `https://twitter.com/intent/tweet?text=${tweetText}`;
      }
      if (smsBtn && data.share_link) {
        const smsBody = encodeURIComponent(
          `Check out the CRM I'm using — finds leads for me automatically: ${data.share_link}`
        );
        smsBtn.href = `sms:?&body=${smsBody}`;
      }
      if (emailBtn && data.share_link) {
        const subject = encodeURIComponent("Check out Velosify CRM");
        const body = encodeURIComponent(
          `Hey,\n\nI've been using Velosify CRM — it scrapes local business leads automatically and finds owner cell phones so I'm not stuck on landlines. Game-changer for outbound.\n\nIf you want to try it: ${data.share_link}\n`
        );
        emailBtn.href = `mailto:?subject=${subject}&body=${body}`;
      }

      if (list) {
        const items = (data.referees || []);
        list.innerHTML = "";
        if (!items.length) {
          if (empty) list.appendChild(empty);
        } else {
          items.forEach(r => {
            const item = document.createElement("div");
            item.className = "referral-list-item";
            const date = (r.signed_up_at || "").slice(0, 10);
            const statusClass =
              r.status_label === "Paying" ? "paying"
              : r.status_label === "Past due" ? "past_due"
              : r.status_label === "Cancelled" ? "cancelled"
              : r.status_label === "Card pending" ? "card-pending"
              : "";
            item.innerHTML =
              `<span>@${escapeHtml(r.username)}` +
              `  <span class="referral-list-item-meta">· joined ${escapeHtml(date)}</span></span>` +
              `<span class="referral-list-item-status ${statusClass}">${escapeHtml(r.status_label)}</span>`;
            list.appendChild(item);
          });
        }
      }
    }

    // Only one referral panel exists now (the standalone view).
    // The Settings → Billing tab uses a promo card that links here.
    renderPanel("-page");
  }

  /* ─── Referral panel handlers (Copy + Save).
     The edit row is always visible now (no toggling), so the JS just
     wires the Copy and Save buttons + a live-clean input filter to
     mirror the server-side regex. DRYed via a tiny factory so the
     Settings inline panel (suffix "") and the standalone view
     (suffix "-page") share one implementation. */
  function wireRefPanel(suffix) {
    const saveBt  = document.getElementById("ref-save-btn"  + suffix);
    const copyBt  = document.getElementById("ref-copy-btn"  + suffix);
    const codeInp = document.getElementById("ref-code-input" + suffix);

    copyBt?.addEventListener("click", async () => {
      const input = document.getElementById("ref-link" + suffix);
      if (!input || !input.value) return;
      try {
        await navigator.clipboard.writeText(input.value);
        toast("Link copied — share away.");
      } catch {
        input.select();
        document.execCommand("copy");
        toast("Link copied.");
      }
    });

    saveBt?.addEventListener("click", async () => {
      const error = document.getElementById("ref-edit-error" + suffix);
      if (!codeInp) return;
      const newCode = (codeInp.value || "").trim().toLowerCase();
      if (!newCode) {
        if (error) {
          error.textContent = "Pick a code first.";
          error.removeAttribute("hidden");
        }
        return;
      }
      try {
        const res = await fetch("/api/me/referral-code", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: newCode }),
        });
        const body = await res.json();
        if (!res.ok) {
          if (error) {
            error.textContent = body.error || "Couldn't save that code.";
            error.removeAttribute("hidden");
          }
          return;
        }
        if (error) error.setAttribute("hidden", "");
        toast("Referral link updated.");
        loadReferrals();
      } catch (err) {
        if (error) {
          error.textContent = err.message || "Network error.";
          error.removeAttribute("hidden");
        }
      }
    });

    // Live-clean the input — strip illegal chars as the user types so
    // they see exactly what will be saved. Mirrors the server regex.
    codeInp?.addEventListener("input", (e) => {
      const cleaned = (e.target.value || "")
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "")
        .slice(0, 30);
      if (cleaned !== e.target.value) e.target.value = cleaned;
    });
  }
  // Only the standalone Referral Program view exists now.
  wireRefPanel("-page");

  // "Want it for free?" promo card on Settings → Billing — clicking
  // it switches to the Referral Program view (which the sidebar nav
  // also opens). Wired to the existing data-view machinery so the
  // sidebar highlight follows along.
  document.getElementById("ref-promo-cta")?.addEventListener("click", () => {
    document.querySelector('.nav-item[data-view="referrals"]')?.click();
  });

  async function loadSettings() {
    try {
      const me = await api.get("/api/me");
      $("#s-first").value = me.first_name || "";
      $("#s-last").value = me.last_name || "";
      $("#s-email").value = me.email || "";
      $("#s-phone").value = me.phone || "";
      $("#s-username").value = me.username || "";
      // Country dropdown moved to the Lead Generator view. Cache the
      // payload here so the LG renderer can populate without a second
      // /api/me call.
      window._velosifyMeCache = me;
      // Populate the Lead Generator country dropdown if it's mounted.
      populateLeadGenCountry(me);
      $("#s-current-pw").value = "";
      $("#s-new-pw").value = "";
      $("#s-confirm-pw").value = "";
    } catch (err) {
      toast("Couldn't load settings: " + err.message, "error");
    }
    loadBillingPanel();
    loadApiKeysPanel();
  }

  // Stripe.js handles for the inline card-update widget. Lazily set up
  // when the user clicks "Update card" so we don't load Elements unless
  // they actually want to swap their card.
  let _stripe = null;
  let _stripeElements = null;
  let _stripePublishableKey = null;

  // -------- API Keys panel (Settings → Profile) --------
  async function loadApiKeysPanel() {
    await Promise.all([loadPlacesKey(), loadTwilioKey(), loadCallerId()]);
  }

  async function loadPlacesKey() {
    const status = document.getElementById("places-key-status");
    const editBtn = document.getElementById("places-key-edit-btn");
    const removeBtn = document.getElementById("places-key-remove-btn");
    if (!status) return;
    try {
      const r = await api.get("/api/me/places-key");
      if (r.has_key) {
        status.textContent = `Set · ${r.preview}`;
        status.className = "api-key-status set";
        editBtn.textContent = "Replace";
        removeBtn.hidden = false;
      } else {
        status.textContent = "Not set";
        status.className = "api-key-status";
        editBtn.textContent = "Add key";
        removeBtn.hidden = true;
      }
    } catch {
      status.textContent = "—";
    }
  }

  async function loadTwilioKey() {
    const status = document.getElementById("twilio-key-status");
    const editBtn = document.getElementById("twilio-key-edit-btn");
    const removeBtn = document.getElementById("twilio-key-remove-btn");
    if (!status) return;
    try {
      const r = await api.get("/api/me/twilio-key");
      if (r.has_key) {
        status.textContent = `Set · ${r.preview}`;
        status.className = "api-key-status set";
        editBtn.textContent = "Replace";
        removeBtn.hidden = false;
      } else {
        status.textContent = "Not set";
        status.className = "api-key-status";
        editBtn.textContent = "Add credentials";
        removeBtn.hidden = true;
      }
    } catch {
      status.textContent = "—";
    }
  }

  // Places: edit/save/cancel/remove
  document.getElementById("places-key-edit-btn")?.addEventListener("click", () => {
    document.getElementById("places-key-edit").hidden = false;
    document.getElementById("places-key-input").value = "";
    document.getElementById("places-key-input").focus();
  });
  document.getElementById("places-key-cancel")?.addEventListener("click", () => {
    document.getElementById("places-key-edit").hidden = true;
  });
  document.getElementById("places-key-save")?.addEventListener("click", async () => {
    const key = document.getElementById("places-key-input").value.trim();
    if (!key) return;
    try {
      const res = await fetch("/api/me/places-key", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Save failed.");
      document.getElementById("places-key-edit").hidden = true;
      toast("Google Places key saved");
      loadPlacesKey();
    } catch (err) { toast(err.message, "error"); }
  });
  document.getElementById("places-key-remove-btn")?.addEventListener("click", async () => {
    if (!window.confirm("Remove your Google Places API key? Lead Generator Pro will fall back to Starter tier.")) return;
    try {
      await fetch("/api/me/places-key", { method: "DELETE" });
      toast("Google Places key removed");
      loadPlacesKey();
    } catch (err) { toast(err.message, "error"); }
  });

  // Twilio: edit/save/cancel/remove
  document.getElementById("twilio-key-edit-btn")?.addEventListener("click", () => {
    document.getElementById("twilio-key-edit").hidden = false;
    document.getElementById("twilio-sid-input").value = "";
    document.getElementById("twilio-token-input").value = "";
    document.getElementById("twilio-sid-input").focus();
  });
  document.getElementById("twilio-key-cancel")?.addEventListener("click", () => {
    document.getElementById("twilio-key-edit").hidden = true;
  });
  document.getElementById("twilio-key-save")?.addEventListener("click", async () => {
    const account_sid = document.getElementById("twilio-sid-input").value.trim();
    const auth_token = document.getElementById("twilio-token-input").value.trim();
    if (!account_sid || !auth_token) {
      toast("Both Account SID and Auth Token are required.", "error");
      return;
    }
    try {
      const res = await fetch("/api/me/twilio-key", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_sid, auth_token }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Save failed.");
      document.getElementById("twilio-key-edit").hidden = true;
      toast("Twilio credentials saved");
      loadTwilioKey();
    } catch (err) { toast(err.message, "error"); }
  });
  document.getElementById("twilio-key-remove-btn")?.addEventListener("click", async () => {
    if (!window.confirm("Remove your Twilio credentials? Verify Mobiles will be disabled until you add them back.")) return;
    try {
      await fetch("/api/me/twilio-key", { method: "DELETE" });
      toast("Twilio credentials removed");
      loadTwilioKey();
    } catch (err) { toast(err.message, "error"); }
  });

  // ---- Power Dial Caller ID --------------------------------------------
  // Stores the verified-with-Twilio number that appears on prospect caller
  // IDs when Power Dialing. Optional — backend falls back to users.phone.
  async function loadCallerId() {
    const status = document.getElementById("caller-id-status");
    const editBtn = document.getElementById("caller-id-edit-btn");
    const removeBtn = document.getElementById("caller-id-remove-btn");
    if (!status) return;
    try {
      const r = await api.get("/api/me/caller-id");
      if (r.caller_id) {
        // Explicit cold-call number set — used for both legs of the bridge.
        status.textContent = `Set · ${r.caller_id}`;
        status.className = "api-key-status set";
        editBtn.textContent = "Replace";
        removeBtn.hidden = false;
      } else if (r.fallback_phone) {
        // No override — falls back to profile phone for both ringing AND caller ID.
        status.textContent = `Falling back to profile · ${r.fallback_phone}`;
        status.className = "api-key-status";
        editBtn.textContent = "Use a different number";
        removeBtn.hidden = true;
      } else {
        // Neither set — Power Dial can't work yet.
        status.textContent = "Not set — add a number to enable Power Dial";
        status.className = "api-key-status";
        editBtn.textContent = "Set number";
        removeBtn.hidden = true;
      }
    } catch {
      status.textContent = "—";
    }
  }
  document.getElementById("caller-id-edit-btn")?.addEventListener("click", () => {
    document.getElementById("caller-id-edit").hidden = false;
    document.getElementById("caller-id-input").value = "";
    document.getElementById("caller-id-input").focus();
  });
  document.getElementById("caller-id-cancel")?.addEventListener("click", () => {
    document.getElementById("caller-id-edit").hidden = true;
  });
  document.getElementById("caller-id-save")?.addEventListener("click", async () => {
    const caller_id = document.getElementById("caller-id-input").value.trim();
    if (!caller_id) {
      toast("Enter a number in E.164 format like +13135551234.", "error");
      return;
    }
    try {
      const res = await fetch("/api/me/caller-id", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caller_id }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Save failed.");
      document.getElementById("caller-id-edit").hidden = true;
      toast("Caller ID saved");
      loadCallerId();
    } catch (err) { toast(err.message, "error"); }
  });
  document.getElementById("caller-id-remove-btn")?.addEventListener("click", async () => {
    if (!window.confirm("Remove your Power Dial caller ID? Will fall back to your profile phone.")) return;
    try {
      await fetch("/api/me/caller-id", { method: "DELETE" });
      toast("Caller ID removed");
      loadCallerId();
    } catch (err) { toast(err.message, "error"); }
  });

  async function loadBillingPanel() {
    const summary = document.getElementById("billing-summary");
    const display = document.getElementById("billing-card-display");
    const updateBtn = document.getElementById("billing-update-btn");
    const panel = document.getElementById("billing-panel");
    if (!panel) return;
    try {
      const pm = await api.get("/api/billing/payment-method");
      _stripePublishableKey = pm.publishable_key || null;
      if (!pm.billing_enabled) {
        if (summary) summary.textContent = "Billing isn't configured on this server yet.";
        if (display) display.setAttribute("hidden", "");
        if (updateBtn) updateBtn.disabled = true;
        return;
      }
      const status = await api.get("/api/billing/status");
      if (pm.card_verified && pm.last4) {
        // Summary text is set further down based on cancel_at_period_end —
        // skip the redundant initial write so we don't flash the wrong copy.
        const brandEl = document.getElementById("billing-card-brand");
        if (brandEl) brandEl.textContent = (pm.brand || "Card").replace(/^./, c => c.toUpperCase());
        const last4El = document.getElementById("billing-card-last4");
        if (last4El) last4El.textContent = pm.last4;
        const expEl = document.getElementById("billing-card-exp");
        if (expEl && pm.exp_month && pm.exp_year) {
          expEl.textContent = `${String(pm.exp_month).padStart(2, "0")}/${String(pm.exp_year).slice(-2)}`;
        }
        const planEl = document.getElementById("billing-plan");
        if (planEl) planEl.textContent = `$${status.price_monthly || 49}/month`;
        const statusEl = document.getElementById("billing-status");
        const cancelPending = !!status.cancel_at_period_end;
        if (statusEl) {
          let label = "—";
          // Tone drives the pill color: ok (green), warn (amber),
          // danger (red), neutral (slate). Active subs are green;
          // cancelling/trial are amber; past_due/cancelled are red.
          let tone = "neutral";
          if (status.status === "trialing") {
            const d = status.days_remaining;
            label = d == null ? "Trial active" : `Trial — ${d} day${d === 1 ? "" : "s"} left`;
            tone = "warn";
          } else if (status.status === "active") {
            if (cancelPending) {
              label = "Cancelling";
              tone = "warn";
            } else {
              label = "Active";
              tone = "ok";
            }
          } else if (status.status === "past_due") {
            label = "Past due";
            tone = "danger";
          } else if (status.status === "canceled") {
            label = "Cancelled";
            tone = "danger";
          } else if (status.status === "grandfathered") {
            label = "Founder";
            tone = "ok";
          } else {
            label = status.status || "—";
          }
          statusEl.textContent = label;
          statusEl.classList.add("billing-status-pill");
          statusEl.classList.remove(
            "billing-status-ok",
            "billing-status-warn",
            "billing-status-danger",
            "billing-status-neutral",
          );
          statusEl.classList.add(`billing-status-${tone}`);
        }

        // Renewal / ends-on row. Show whenever we have a period end on
        // file — labels the date as either the next charge ("Next
        // renewal") or the access cutoff ("Access ends") when the user
        // has cancelled but still has time left.
        const renewRow = document.getElementById("billing-renewal-row");
        const renewLabel = document.getElementById("billing-renewal-label");
        const renewEl = document.getElementById("billing-renewal");
        if (renewRow && renewEl) {
          if (status.current_period_end) {
            const dt = new Date(status.current_period_end);
            if (!isNaN(dt.getTime())) {
              const formatted = dt.toLocaleDateString(undefined, {
                year: "numeric", month: "long", day: "numeric",
              });
              renewEl.textContent = formatted;
              if (renewLabel) {
                renewLabel.textContent = cancelPending
                  ? "Access ends"
                  : status.status === "trialing"
                    ? "Trial ends"
                    : "Next renewal";
              }
              renewRow.removeAttribute("hidden");
            } else {
              renewRow.setAttribute("hidden", "");
            }
          } else {
            renewRow.setAttribute("hidden", "");
          }
        }

        if (display) display.removeAttribute("hidden");
        if (updateBtn) updateBtn.textContent = "Update card";

        // Cancel/Resume button toggle. When the user has already
        // cancelled (cancel_at_period_end=true) we hide the Cancel
        // button and surface a green Resume button instead. Once their
        // mind changes back we revert.
        const cancelBtn = document.getElementById("billing-cancel-membership-btn");
        const resumeBtn = document.getElementById("billing-resume-membership-btn");
        if (cancelPending) {
          if (cancelBtn) cancelBtn.setAttribute("hidden", "");
          if (resumeBtn) resumeBtn.removeAttribute("hidden");
        } else {
          if (cancelBtn) cancelBtn.removeAttribute("hidden");
          if (resumeBtn) resumeBtn.setAttribute("hidden", "");
        }

        // Update the "Card on file" summary to match — if they've
        // cancelled, no more charges are coming, so the auto-charge
        // line is misleading.
        if (summary) {
          summary.textContent = cancelPending
            ? `Your subscription is set to end on ${new Date(status.current_period_end).toLocaleDateString()}. Resume any time before then to keep your access.`
            : "Card on file — your $49/month subscription will be charged automatically.";
        }
      } else {
        if (summary) summary.textContent = "No card on file yet. Add one to access your CRM.";
        if (display) display.setAttribute("hidden", "");
        if (updateBtn) updateBtn.textContent = "Add a card";
      }
    } catch (err) {
      if (summary) summary.textContent = "Couldn't load billing info.";
    }
  }

  // ------- Inline "Update card" flow (Stripe Elements) -------

  function _showCardError(msg) {
    const el = document.getElementById("billing-card-error");
    if (!el) return;
    if (msg) {
      el.textContent = msg;
      el.removeAttribute("hidden");
    } else {
      el.textContent = "";
      el.setAttribute("hidden", "");
    }
  }

  async function startCardUpdate() {
    const form = document.getElementById("billing-update-form");
    const mount = document.getElementById("billing-card-element");
    const updateBtn = document.getElementById("billing-update-btn");
    if (!form || !mount) return;
    if (!window.Stripe) {
      toast("Stripe library failed to load.", "error");
      return;
    }
    // Reveal the form immediately so the user sees something happening.
    form.removeAttribute("hidden");
    if (updateBtn) updateBtn.disabled = true;
    _showCardError(null);
    try {
      const intent = await fetch("/api/billing/setup-intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }).then(r => r.json().then(j => ({ ok: r.ok, body: j })));
      if (!intent.ok) {
        throw new Error(intent.body?.error || "Couldn't start card update.");
      }
      const { client_secret, publishable_key } = intent.body;
      _stripe = window.Stripe(publishable_key);
      // Tear down any previous element so re-opens don't double-mount.
      mount.innerHTML = "";
      _stripeElements = _stripe.elements({
        clientSecret: client_secret,
        appearance: {
          theme: "night",
          variables: {
            colorPrimary: "#c084fc",
            colorBackground: "#0e0c1c",
            colorText: "#e9d5ff",
            colorDanger: "#fecaca",
            fontFamily: "Inter, -apple-system, BlinkMacSystemFont, sans-serif",
            borderRadius: "8px",
          },
        },
      });
      const paymentElement = _stripeElements.create("payment", {
        layout: { type: "tabs" },
      });
      paymentElement.mount(mount);
    } catch (err) {
      // Keep the form visible so the inline error is readable. Also toast
      // it in case the form was scrolled out of view.
      const msg = err.message || String(err);
      _showCardError(msg);
      toast(msg, "error");
      if (updateBtn) updateBtn.disabled = false;
    }
  }

  function cancelCardUpdate() {
    const form = document.getElementById("billing-update-form");
    const mount = document.getElementById("billing-card-element");
    const updateBtn = document.getElementById("billing-update-btn");
    if (form) form.setAttribute("hidden", "");
    if (mount) mount.innerHTML = "";
    if (updateBtn) updateBtn.disabled = false;
    _stripeElements = null;
    _showCardError(null);
  }

  async function saveNewCard() {
    if (!_stripe || !_stripeElements) {
      _showCardError("Card form isn't ready — try again.");
      return;
    }
    const saveBtn = document.getElementById("billing-save-btn");
    const cancelBtn = document.getElementById("billing-cancel-btn");
    _showCardError(null);
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving…"; }
    if (cancelBtn) cancelBtn.disabled = true;
    try {
      const result = await _stripe.confirmSetup({
        elements: _stripeElements,
        redirect: "if_required",
      });
      if (result.error) {
        throw new Error(result.error.message || "Card couldn't be saved.");
      }
      const pm = result.setupIntent?.payment_method;
      const pmId = typeof pm === "string" ? pm : pm?.id;
      if (!pmId) throw new Error("Stripe didn't return a payment method id.");
      const res = await fetch("/api/billing/save-card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payment_method_id: pmId }),
      });
      const body = await res.json();
      if (!res.ok || !body.saved) {
        throw new Error(body.error || "Server couldn't save the new card.");
      }
      toast("Card updated");
      cancelCardUpdate();
      loadBillingPanel();
    } catch (err) {
      _showCardError(err.message || String(err));
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Save card"; }
      if (cancelBtn) cancelBtn.disabled = false;
    }
  }

  // Wire up the buttons. Idempotent — `loadSettings` is called every time
  // the user opens the Settings view, but the listeners live on the DOM
  // nodes which only exist once.
  document.getElementById("billing-update-btn")?.addEventListener("click", startCardUpdate);
  document.getElementById("billing-cancel-btn")?.addEventListener("click", cancelCardUpdate);
  document.getElementById("billing-save-btn")?.addEventListener("click", saveNewCard);
  document.getElementById("billing-cancel-membership-btn")?.addEventListener("click", cancelMembership);
  document.getElementById("billing-resume-membership-btn")?.addEventListener("click", resumeMembership);

  async function resumeMembership() {
    const btn = document.getElementById("billing-resume-membership-btn");
    if (btn) { btn.disabled = true; btn.textContent = "Resuming…"; }
    try {
      const res = await fetch("/api/billing/reactivate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const body = await res.json();
      if (!res.ok || !body.resumed) {
        throw new Error(body.error || "Couldn't resume.");
      }
      toast("Membership resumed — your subscription will renew normally.");
      loadBillingPanel();
    } catch (err) {
      toast(err.message || String(err), "error");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Resume membership"; }
    }
  }

  async function cancelMembership() {
    const ok = window.confirm(
      "Cancel your Velosify CRM membership?\n\n" +
      "If you're on a paid plan, you'll keep access until the end of the " +
      "current billing period. If you're on the trial, your access ends " +
      "when the trial ends."
    );
    if (!ok) return;
    const btn = document.getElementById("billing-cancel-membership-btn");
    if (btn) { btn.disabled = true; btn.textContent = "Cancelling…"; }
    try {
      const res = await fetch("/api/billing/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const body = await res.json();
      if (!res.ok || !body.canceled) {
        throw new Error(body.error || "Couldn't cancel.");
      }
      if (body.cancel_at_period_end && body.ends_at) {
        const d = new Date(body.ends_at);
        const when = isNaN(d) ? "the end of your billing period"
                              : d.toLocaleDateString();
        toast(`Cancelled. Access ends ${when}.`);
      } else {
        toast("Membership cancelled.");
      }
      loadBillingPanel();
    } catch (err) {
      toast(err.message || String(err), "error");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Cancel membership"; }
    }
  }

  // ------- Rendering dispatch -------
  function render() {
    renderDashboard();
    renderContacts();
    renderCompanies();
    renderDeals();
    renderActivities();
    renderUsers();
    renderProjectsView();
    applySortIndicators();
  }

  // ------- Dashboard -------
  async function renderDashboard() {
    const d = await api.get("/api/dashboard");
    $("#kpi-pipeline").textContent = fmtMoney(d.pipeline_value);
    $("#kpi-won").textContent = fmtMoney(d.won_value);
    $("#kpi-contacts").textContent = d.total_contacts;
    $("#kpi-companies").textContent = d.total_companies;
    $("#kpi-tasks").textContent = d.open_tasks;

    // Stage chart
    const stageEl = $("#stage-chart");
    stageEl.innerHTML = "";
    const stages = state.meta.stages.length ? state.meta.stages : Object.keys(d.by_stage);
    const maxStageValue = Math.max(1, ...stages.map(s => (d.by_stage[s]?.value || 0)));
    stages.forEach(stage => {
      const info = d.by_stage[stage] || { count: 0, value: 0 };
      const pct = (info.value / maxStageValue) * 100;
      stageEl.insertAdjacentHTML("beforeend", `
        <div class="bar-row">
          <div class="bar-label">${escapeHtml(stage)} <span style="color:var(--text-dim)">(${info.count})</span></div>
          <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
          <div class="bar-value">${fmtMoney(info.value)}</div>
        </div>
      `);
    });

    // Service chart
    const svcEl = $("#service-chart");
    svcEl.innerHTML = "";
    const maxSvc = Math.max(1, ...d.by_service.map(s => s.value));
    d.by_service.forEach(row => {
      const pct = (row.value / maxSvc) * 100;
      svcEl.insertAdjacentHTML("beforeend", `
        <div class="bar-row">
          <div class="bar-label">${escapeHtml(row.service)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
          <div class="bar-value">${fmtMoney(row.value)}</div>
        </div>
      `);
    });

    // Upcoming activities
    const list = $("#upcoming-list");
    const upcoming = state.activities
      .filter(a => !a.completed)
      .sort((a, b) => (a.due_date || "").localeCompare(b.due_date || ""))
      .slice(0, 6);
    list.innerHTML = upcoming.length ? "" : `<div style="color:var(--text-dim);padding:16px;">No upcoming activities.</div>`;
    upcoming.forEach(a => {
      list.insertAdjacentHTML("beforeend", `
        <div class="mini-item">
          <span class="tag">${escapeHtml(a.type)}</span>
          <div><strong>${escapeHtml(a.subject)}</strong></div>
          <div>${escapeHtml(a.contact_name || "")}</div>
          <div style="color:var(--text-dim)">${escapeHtml(a.due_date || "No date")}</div>
        </div>
      `);
    });
  }

  // ------- Contact lists -------
  function contactList(c) {
    return c.list_name && c.list_name.trim() ? c.list_name : "Inbox";
  }

  // Phone-type cell. Click to cycle: ? → 📱 → ☎ → 🖧 → ?
  // Tooltip shows current state + carrier/region label if libphonenumber knew it.
  function phoneTypeCell(c) {
    if (!c.phone) return "";
    const meta = {
      mobile:   { icon: "📱", label: "Mobile",     cls: "mobile" },
      landline: { icon: "☎",  label: "Landline",   cls: "landline" },
      voip:     { icon: "🖧", label: "VoIP",       cls: "voip" },
      tollfree: { icon: "🆓", label: "Toll-free",  cls: "tollfree" },
      premium:  { icon: "$",  label: "Premium",    cls: "premium" },
      invalid:  { icon: "✕",  label: "Invalid",    cls: "invalid" },
      unknown:  { icon: "?",  label: "Ambiguous",  cls: "unknown" },
    };
    const t = c.phone_type ? String(c.phone_type).toLowerCase() : null;
    const m = t ? (meta[t] || meta.unknown) : { icon: "?", label: "Tap to classify", cls: "unclassified" };
    const carrierRaw = (c.phone_carrier || "").trim();
    const tipCarrier = carrierRaw ? ` — ${carrierRaw}` : "";
    const tip = `${m.label}${tipCarrier} · click to change`;
    // Show the carrier name as a subtitle under the badge so users can
    // tell at a glance whether a "Mobile" tag is backed by a real wireless
    // carrier (Verizon Wireless, T-Mobile) or whether it just slipped past
    // the business-VoIP downgrade rule.
    const carrierLine = carrierRaw
      ? `<span class="phone-type-carrier">${escapeHtml(carrierRaw)}</span>`
      : "";
    return `<span class="phone-type-wrap" title="${escapeHtml(tip)}">
              <span class="phone-type clickable ${m.cls}">${m.icon} ${escapeHtml(m.label)}</span>
              ${carrierLine}
            </span>`;
  }

  // Cached list metadata (names + counts) fetched from the server. Combines
  // lists with contacts AND empty lists from contact_lists. Refreshed on
  // any list mutation (create/rename/delete).
  state.contactLists = state.contactLists || [];

  async function refreshContactLists() {
    try {
      state.contactLists = (await api.get("/api/contacts/lists")).lists || [];
    } catch {
      state.contactLists = [];
    }
    renderListTabs();
  }

  function renderListTabs() {
    const container = $("#list-tabs");
    if (!container) return;
    // Use server-side counts (authoritative) so empty lists also show.
    // Fallback: compute from state.contacts if /api/contacts/lists hasn't
    // returned yet.
    const lists = (state.contactLists || []).slice();
    if (!lists.length) {
      const counts = new Map();
      state.contacts.forEach(c => {
        const n = contactList(c);
        counts.set(n, (counts.get(n) || 0) + 1);
      });
      [...counts.keys()].sort().forEach(n => lists.push({name: n, count: counts.get(n)}));
    }
    const total = state.contacts.length;
    const sel = state.contactList;
    let options = `<option value=""${sel === "" ? " selected" : ""}>All (${total})</option>`;
    lists.forEach(l => {
      const safe = escapeHtml(l.name);
      const isSel = sel === l.name ? " selected" : "";
      options += `<option value="${safe}"${isSel}>${safe} (${l.count})</option>`;
    });
    // Append a "+ New list…" option at the end of the dropdown so the
    // separate +New list button can hide on mobile. Picking it triggers
    // the existing list-new flow.
    options += `<option value="__NEW_LIST__">+ New list…</option>`;
    container.innerHTML = `
      <label class="list-select-wrap">
        <span class="list-select-label">List</span>
        <select id="list-select" class="list-select">${options}</select>
      </label>
    `;
    const select = $("#list-select", container);
    select.addEventListener("change", () => {
      if (select.value === "__NEW_LIST__") {
        // Restore the dropdown back to the previously-chosen list before
        // firing the new-list flow, so a cancelled prompt doesn't leave
        // the dropdown stuck on "+ New list…".
        select.value = state.contactList || "";
        document.getElementById("list-new-btn")?.click();
        return;
      }
      state.contactList = select.value;
      state.selectedContacts.clear();
      renderContacts();
      renderListTabs();
    });
    // Show Rename / Delete only when a specific (non-Inbox) list is selected.
    const renameBtn = $("#list-rename-btn");
    const deleteBtn = $("#list-delete-btn");
    const isManageable = sel && sel.toLowerCase() !== "inbox";
    if (renameBtn) renameBtn.toggleAttribute("hidden", !isManageable);
    if (deleteBtn) deleteBtn.toggleAttribute("hidden", !isManageable);
  }

  // List management — + New, Rename, Delete buttons next to the dropdown.
  $("#list-new-btn")?.addEventListener("click", async () => {
    const name = (window.prompt("Name for the new list:") || "").trim();
    if (!name) return;
    try {
      await _safeFetchJson("/api/contacts/lists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      await refreshContactLists();
      state.contactList = name;
      renderContacts();
      renderListTabs();
      toast(`Created list "${name}"`);
    } catch (err) {
      toast(err.message, "error");
    }
  });

  $("#list-rename-btn")?.addEventListener("click", async () => {
    const oldName = state.contactList;
    if (!oldName) return;
    const newName = (window.prompt(`Rename list "${oldName}" to:`, oldName) || "").trim();
    if (!newName || newName === oldName) return;
    try {
      const res = await _safeFetchJson(
        `/api/contacts/lists/${encodeURIComponent(oldName)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: newName }),
        },
      );
      state.contactList = newName;
      await refreshContactLists();
      await loadAll();
      toast(`Renamed to "${newName}" (${res.renamed} contact${res.renamed === 1 ? "" : "s"} updated)`);
    } catch (err) {
      toast(err.message, "error");
    }
  });

  $("#list-delete-btn")?.addEventListener("click", async () => {
    const name = state.contactList;
    if (!name) return;
    // Find the count for this list so the confirm message is specific.
    const entry = (state.contactLists || []).find(l => l.name === name);
    const count = entry ? entry.count : 0;
    let msg;
    if (count === 0) {
      msg = `Delete the empty list "${name}"?`;
    } else {
      msg = `Delete list "${name}"?\n\n` +
            `Its ${count} contact${count === 1 ? "" : "s"} will be moved to Inbox.\n\n` +
            `(To delete the contacts entirely, hold Shift while clicking OK.)`;
    }
    const ok = window.confirm(msg);
    if (!ok) return;
    // Detect shift-held confirm via a follow-up prompt for non-empty lists.
    let purgeContacts = false;
    if (count > 0) {
      const purgeAns = window.prompt(
        `Type "DELETE" to also remove the ${count} contact${count === 1 ? "" : "s"} (otherwise they'll just move to Inbox). Leave blank to move them to Inbox.`,
      );
      purgeContacts = (purgeAns || "").trim().toUpperCase() === "DELETE";
    }
    const qs = purgeContacts ? "?move_to=delete" : "";
    try {
      const res = await _safeFetchJson(
        `/api/contacts/lists/${encodeURIComponent(name)}${qs}`,
        { method: "DELETE" },
      );
      state.contactList = "";
      await loadAll();   // refresh contacts (some may be gone/moved)
      await refreshContactLists();
      toast(`Deleted "${name}" — ${res.affected} contact${res.affected === 1 ? "" : "s"} ${res.action}`);
    } catch (err) {
      toast(err.message, "error");
    }
  });

  // ------- Contacts -------
  // Currently visible (after list/search filter + sort) — the "select all"
  // checkbox operates on this set, NOT the raw state.contacts.
  let _visibleContacts = [];

  // Column model for the contacts table. The order shown is whatever the
  // user has dragged into place; widths are also remembered. The "select"
  // and "actions" columns are anchored at the start/end and can't be
  // dragged (but can still be resized — well, "select" stays narrow).
  function buildContactColumns() {
    return [
      {
        id: "select",
        anchored: "start",
        width: 48, minWidth: 48,
        headerClass: "select-col",
        cellClass: "select-col",
        renderHeader: () => `<input type="checkbox" id="select-all-contacts" aria-label="Select all" />`,
        renderCell: c => `<input type="checkbox" class="row-select" data-id="${c.id}"${state.selectedContacts.has(c.id) ? " checked" : ""} aria-label="Select" />`,
      },
      {
        id: "ref_id", label: "ID",
        sortKey: "ref_id", sortType: "number",
        width: 80, minWidth: 60,
        cellStyle: "color:var(--text-dim);font-variant-numeric:tabular-nums;",
        renderCell: c => c.ref_id != null ? String(c.ref_id) : "",
      },
      {
        id: "name", label: "Name",
        sortKey: "name",
        width: 170, minWidth: 100,
        renderCell: c => `<strong>${escapeHtml(c.first_name)} ${escapeHtml(c.last_name || "")}</strong>`,
      },
      {
        id: "title", label: "Title",
        sortKey: "title",
        width: 140, minWidth: 80,
        renderCell: c => escapeHtml(c.title || ""),
      },
      {
        id: "company", label: "Company",
        sortKey: "company_name",
        width: 180, minWidth: 100,
        renderCell: c => escapeHtml(c.company_name || ""),
      },
      {
        id: "email", label: "Email",
        sortKey: "email",
        width: 200, minWidth: 120,
        renderCell: c => c.email
          ? `<a class="email-link" href="mailto:${encodeURIComponent(c.email)}">${escapeHtml(c.email)}</a>`
          : "",
      },
      {
        id: "phone", label: "Phone",
        sortKey: "phone",
        width: 140, minWidth: 100,
        renderCell: c => c.phone
          ? `<a class="phone-link" href="tel:${encodeURIComponent(c.phone)}">${escapeHtml(formatPhone(c.phone))}</a>`
          : "",
      },
      {
        id: "line", label: "Line",
        sortKey: "phone_type",
        width: 110, minWidth: 80,
        renderCell: c => phoneTypeCell(c),
      },
      {
        id: "website", label: "Website",
        sortKey: "company_website",
        width: 180, minWidth: 100,
        renderCell: c => {
          if (c.company_website) {
            const url = /^https?:\/\//i.test(c.company_website)
              ? c.company_website : "https://" + c.company_website;
            const display = c.company_website.replace(/^https?:\/\//i, "").replace(/^www\./, "").replace(/\/$/, "");
            const short = display.length > 32 ? display.slice(0, 30) + "…" : display;
            return `<a class="website-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(c.company_website)}">${escapeHtml(short)} ↗</a>`;
          }
          if (c.company_name) {
            return `<span class="tag red" title="No website on file — pitch opportunity">No website</span>`;
          }
          return "";
        },
      },
      {
        id: "address", label: "Address",
        sortKey: "company_address",
        width: 240, minWidth: 140,
        renderCell: c => {
          const a = (c.company_address || "").trim();
          if (!a) return "";
          // Show the truncated street + city; tooltip carries the full address.
          // Make it clickable — opens Google Maps in a new tab so the user
          // can see the storefront / route before dialing.
          const short = a.length > 42 ? a.slice(0, 40) + "…" : a;
          const mapUrl = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(a);
          return `<a class="address-link" href="${escapeHtml(mapUrl)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(a)} (open in Google Maps)">${escapeHtml(short)} ↗</a>`;
        },
      },
      {
        id: "reviews", label: "Reviews",
        sortKey: "review_count", sortType: "number",
        width: 90, minWidth: 70,
        cellStyle: "font-variant-numeric:tabular-nums;text-align:left;",
        renderCell: c => {
          const n = c.review_count;
          if (n == null) return "";
          // Format big numbers with commas; bold high-value leads (50+).
          const formatted = Number(n).toLocaleString();
          const cls = n >= 50 ? "reviews-high" : n >= 10 ? "reviews-mid" : "reviews-low";
          return `<span class="${cls}" title="${formatted} Google reviews">${formatted}</span>`;
        },
      },
      {
        id: "rating", label: "Rating",
        sortKey: "review_rating", sortType: "number",
        width: 110, minWidth: 90,
        renderCell: c => {
          const r = c.review_rating;
          if (r == null) return "";
          // Render filled / half / empty stars based on the rating value.
          // 4.3 -> ★★★★☆  (4 filled, 1 empty — half-star looks busy in a row)
          const filled = Math.round(r);
          const stars = "★".repeat(filled) + "☆".repeat(Math.max(0, 5 - filled));
          const cls = r >= 4.5 ? "rating-good" : r >= 3.5 ? "rating-ok" : "rating-bad";
          return `<span class="${cls}" title="${r.toFixed(1)} stars">${stars} <span class="rating-num">${r.toFixed(1)}</span></span>`;
        },
      },
      {
        id: "status", label: "Status",
        sortKey: "business_status",
        width: 130, minWidth: 100,
        renderCell: c => {
          const s = (c.business_status || "").trim().toUpperCase();
          // Empty status = imported before the migration / not from Google Places.
          if (!s) return `<span class="biz-status biz-unknown" title="No status data — pre-migration or non-Places import">—</span>`;
          if (s === "OPERATIONAL") return `<span class="biz-status biz-open" title="Marked as operational on Google">✓ Open</span>`;
          if (s === "CLOSED_TEMPORARILY") return `<span class="biz-status biz-temp" title="Marked as temporarily closed on Google">Closed (temp)</span>`;
          if (s === "CLOSED_PERMANENTLY") return `<span class="biz-status biz-perm" title="Permanently closed — likely a dead lead">CLOSED</span>`;
          return `<span class="biz-status">${escapeHtml(s)}</span>`;
        },
      },
      {
        id: "source", label: "Source",
        sortKey: "source",
        width: 170, minWidth: 90,
        renderCell: c => `${escapeHtml(c.source || "")}${c.source ? " · " : ""}<span class="tag" style="background:rgba(139,92,246,0.18);color:#e9d5ff">${escapeHtml(contactList(c))}</span>`,
      },
      {
        id: "tags", label: "Tags",
        sortKey: "tags",
        width: 140, minWidth: 80,
        renderCell: c => (c.tags || "").split(",").filter(Boolean)
          .map(t => `<span class="tag">${escapeHtml(t.trim())}</span>`).join(""),
      },
      {
        id: "notes", label: "Notes",
        width: 280, minWidth: 150,
        renderCell: c => {
          // Auto-populate from the most recent call activity. Falls back to
          // the contact's own notes field when no call has been logged yet.
          const calls = (state.activities || []).filter(a =>
            a.contact_id === c.id && a.type === "call"
          );
          const generalFull = (c.notes || "").trim();
          // Only the most recent block in the row — older blocks stay in
          // c.notes and surface in the contact-edit modal's textarea.
          const general = latestNoteBlock(generalFull);
          if (calls.length > 0) {
            const latest = calls.slice().sort((a, b) =>
              (b.created_at || "").localeCompare(a.created_at || "")
            )[0];
            const html = [];
            const tipBits = [];
            if (latest.outcome) {
              html.push(`<strong class="notes-outcome">${escapeHtml(latest.outcome)}</strong>`);
              tipBits.push(latest.outcome);
            }
            if (latest.duration_minutes) {
              html.push(`<span class="notes-duration">${latest.duration_minutes}m</span>`);
              tipBits.push(latest.duration_minutes + "m");
            }
            const txt = (latest.notes || "").trim();
            if (txt) {
              html.push(`<span class="notes-text">${highlightPowerDial(txt)}</span>`);
              tipBits.push(txt);
            }
            if (general) {
              html.push(`<span class="notes-text notes-general">${highlightPowerDial(general)}</span>`);
              tipBits.push(general);
            }
            // Tooltip shows the FULL notes (with history) on hover.
            const tip = (tipBits.join(" · ") + (generalFull && generalFull !== general ? "\n\n— Full history available when editing —" : ""));
            return `<span class="cell-notes" title="${escapeHtml(tip)}">${html.join(' <span class="notes-sep">·</span> ')}</span>`;
          }
          if (general) {
            return `<span class="cell-notes" title="${escapeHtml(generalFull)}"><span class="notes-text notes-general">${highlightPowerDial(general)}</span></span>`;
          }
          return "";
        },
      },
      {
        id: "actions",
        label: "Log Call",
        anchored: "end",
        width: 110, minWidth: 90,
        cellClass: "row-actions",  // applied only to <td>, not <th>
        renderCell: c => {
          // Has this contact had any call logged against them?
          const calls = (state.activities || []).filter(a =>
            a.contact_id === c.id && a.type === "call"
          );
          if (calls.length > 0) {
            // Show the most recent outcome in the tooltip so the user
            // can see at a glance how the last call went.
            const latest = calls.slice().sort((a, b) =>
              (b.created_at || "").localeCompare(a.created_at || "")
            )[0];
            const tipBits = [];
            if (latest?.outcome) tipBits.push(`Last: ${latest.outcome}`);
            if (calls.length > 1) tipBits.push(`${calls.length} calls`);
            tipBits.push("Click to log another");
            const tip = tipBits.join(" · ");
            return `<button class="btn btn-ghost log-call-btn logged" data-contact-id="${c.id}" title="${escapeHtml(tip)}">✓ Logged</button>`;
          }
          return `<button class="btn btn-ghost log-call-btn" data-contact-id="${c.id}" title="Log a call with this contact">📞 Log</button>`;
        },
      },
    ];
  }

  // Custom user-defined columns. Each one has id "custom_<fieldId>" so the
  // column system (order, widths, hidden) can persist them per-project just
  // like built-ins.
  function customContactColumns() {
    return (state.customFields || []).map(f => ({
      id: "custom_" + f.id,
      label: f.label,
      isCustom: true,
      customFieldId: f.id,
      width: 180, minWidth: 100,
      sortKey: "custom_" + f.id,
      cellClass: "custom-col",
      renderCell: c => {
        const v = c.custom_data && c.custom_data[String(f.id)];
        if (v) return escapeHtml(v);
        return `<span class="custom-empty">—</span>`;
      },
    }));
  }

  // Combined column set: built-ins + custom. Custom appear after the
  // built-in middle columns by default (but the user can drag them anywhere).
  function allContactColumns() {
    const builtins = buildContactColumns();
    const customs = customContactColumns();
    if (!customs.length) return builtins;
    // Insert customs right before the trailing 'actions' anchor.
    const out = [];
    for (const c of builtins) {
      if (c.id === "actions") {
        out.push(...customs);
      }
      out.push(c);
    }
    return out;
  }

  // Default visible columns + order for first-time users. Tuned for the
  // Google-Maps-scraped cold-call workflow: lead the row with the business
  // (Company), critical contact info (Phone/Line/Website), the Places
  // review intel (Reviews/Rating/Status), then Address and Notes.
  // Personal-contact columns (Name/Title/Email) and meta columns (Source/
  // Tags) are hidden by default; the Custom Columns picker can re-enable
  // them anytime.
  const DEFAULT_HIDDEN_COLUMNS = ["name", "title", "email", "source", "tags"];
  const DEFAULT_COLUMN_ORDER = [
    "select", "ref_id", "company", "phone", "line", "website",
    "reviews", "rating", "status", "address", "notes", "actions",
  ];

  // Persisted layout: order of column IDs and per-column widths.
  // Stored under one key per project so each project can have its own layout.
  function _layoutKey(suffix) {
    const pid = state.currentProjectId || "default";
    return `velosify.contacts.${suffix}.p${pid}`;
  }
  function loadColumnLayout() {
    try {
      // Read raw values so we can distinguish "never saved" from
      // "saved as empty []". Never-saved = first-time user → apply
      // defaults; explicit empty = user customized → respect it.
      const orderRaw  = localStorage.getItem(_layoutKey("colOrder"));
      const widthsRaw = localStorage.getItem(_layoutKey("colWidths"));
      const hiddenRaw = localStorage.getItem(_layoutKey("colHidden"));

      if (orderRaw === null) {
        state.contactColumnOrder = [...DEFAULT_COLUMN_ORDER];
      } else {
        const order = JSON.parse(orderRaw);
        state.contactColumnOrder = Array.isArray(order) ? order : null;
      }

      state.contactColumnWidths = widthsRaw
        ? (JSON.parse(widthsRaw) || {}) : {};

      if (hiddenRaw === null) {
        state.contactColumnHidden = new Set(DEFAULT_HIDDEN_COLUMNS);
      } else {
        const hidden = JSON.parse(hiddenRaw);
        state.contactColumnHidden = new Set(Array.isArray(hidden) ? hidden : []);
      }
    } catch {
      state.contactColumnOrder = [...DEFAULT_COLUMN_ORDER];
      state.contactColumnWidths = {};
      state.contactColumnHidden = new Set(DEFAULT_HIDDEN_COLUMNS);
    }
  }
  function saveColumnOrder() {
    try {
      localStorage.setItem(_layoutKey("colOrder"), JSON.stringify(state.contactColumnOrder));
    } catch {}
  }
  function saveColumnWidths() {
    try {
      localStorage.setItem(_layoutKey("colWidths"), JSON.stringify(state.contactColumnWidths));
    } catch {}
  }
  function saveColumnHidden() {
    try {
      localStorage.setItem(_layoutKey("colHidden"), JSON.stringify([...state.contactColumnHidden]));
    } catch {}
  }

  // Resolve the actual column array to render: anchored start cols, then
  // user-ordered middle cols (with hidden ones filtered out), then anchored
  // end cols. Anchored columns can NOT be hidden — they're functional.
  function getOrderedContactColumns() {
    const all = allContactColumns();
    const byId = new Map(all.map(c => [c.id, c]));
    const startAnchors = all.filter(c => c.anchored === "start");
    const endAnchors   = all.filter(c => c.anchored === "end");
    const middleAll    = all.filter(c => !c.anchored);

    let middleOrder = state.contactColumnOrder || middleAll.map(c => c.id);
    middleOrder = middleOrder.filter(id => byId.has(id) && byId.get(id).anchored !== "start" && byId.get(id).anchored !== "end");
    for (const c of middleAll) {
      if (!middleOrder.includes(c.id)) middleOrder.push(c.id);
    }
    const hidden = state.contactColumnHidden || new Set();
    const middle = middleOrder
      .map(id => byId.get(id))
      .filter(c => !hidden.has(c.id));
    return [...startAnchors, ...middle, ...endAnchors];
  }

  function effectiveColumnWidth(col) {
    const saved = state.contactColumnWidths?.[col.id];
    return Math.max(col.minWidth || 40, saved || col.width || 100);
  }

  function renderContacts() {
    const table = $("#contacts-table");
    const tbody = table?.querySelector("tbody");
    const colgroup = table?.querySelector("colgroup");
    const headerRow = table?.querySelector("thead tr");
    if (!tbody || !colgroup || !headerRow) return;
    renderListTabs();
    // Refresh the server-side list metadata once per render so empty lists
    // appear immediately after creation, and counts are authoritative.
    // Fire-and-forget — the table renders right away with in-memory counts.
    refreshContactLists();

    const q = state.search.toLowerCase();
    const rows = sortRows(
      state.contacts.filter(c => {
        if (state.contactList && contactList(c) !== state.contactList) return false;
        if (!q) return true;
        return [c.first_name, c.last_name, c.email, c.phone, c.title, c.company_name, c.tags, contactList(c)]
          .join(" ").toLowerCase().includes(q);
      }),
      "contacts",
    );
    _visibleContacts = rows;
    const liveIds = new Set(state.contacts.map(c => c.id));
    for (const id of [...state.selectedContacts]) {
      if (!liveIds.has(id)) state.selectedContacts.delete(id);
    }

    const cols = getOrderedContactColumns();

    // <colgroup> drives the column widths under table-layout: fixed.
    colgroup.innerHTML = cols.map(col =>
      `<col data-col-id="${col.id}" style="width:${effectiveColumnWidth(col)}px"/>`
    ).join("");

    // Set the table's outer width to the sum of column widths so column
    // widths are exact (otherwise table-layout: fixed proportionally squeezes
    // them to fit 100% of the wrapper).
    table.style.width = cols.reduce((sum, c) => sum + effectiveColumnWidth(c), 0) + "px";

    // Header — each <th> is draggable (except anchored ones) and holds a
    // resize grabber on its right edge. NOTE: cellClass is intentionally
    // applied to <td> only (some classes like 'row-actions' use display:flex
    // and would break the <th>'s table-cell layout). Headers can opt in via
    // headerClass when they really do want a special class.
    headerRow.innerHTML = cols.map(col => {
      const cls = ["col-" + col.id];
      if (col.headerClass) cls.push(col.headerClass);
      const sortAttrs = col.sortKey
        ? ` data-sort="${col.sortKey}"${col.sortType ? ` data-type="${col.sortType}"` : ""}`
        : "";
      const drag = !col.anchored ? ` draggable="true"` : "";
      const headerInner = col.renderHeader ? col.renderHeader() : escapeHtml(col.label || "");
      return (
        `<th class="${cls.join(" ")}" data-col-id="${col.id}"${sortAttrs}${drag}>` +
          `<span class="th-label">${headerInner}</span>` +
          (!col.anchored ? `<span class="col-resize" aria-hidden="true"></span>` : "") +
        `</th>`
      );
    }).join("");

    // Apply persisted sort indicator after re-rendering the header.
    applySortIndicators();

    // Body rows.
    tbody.innerHTML = "";
    rows.forEach(c => {
      const tr = document.createElement("tr");
      tr.dataset.id = c.id;
      if (state.selectedContacts.has(c.id)) tr.classList.add("row-selected");
      tr.innerHTML = cols.map(col => {
        const cls = col.cellClass ? ` class="${col.cellClass}"` : "";
        const style = col.cellStyle ? ` style="${col.cellStyle}"` : "";
        return `<td${cls}${style} data-col-id="${col.id}">${col.renderCell(c)}</td>`;
      }).join("");
      tr.addEventListener("click", (e) => {
        // Don't open edit modal when the user clicks a link / interactive cell.
        if (e.target.closest("a.phone-link, a.email-link, a.website-link, .log-call-btn, .row-select, .phone-type, .col-resize")) return;
        openContactModal(c);
      });
      const logBtn = tr.querySelector(".log-call-btn");
      if (logBtn) logBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openCallLogModal(c);
      });
      tbody.appendChild(tr);
    });
    refreshSelectionUI();
    // Power Dialer overlay hook: if a dial session is active, re-decorate
    // the current contact's row + re-insert the inline action row.
    if (window.PowerDialer && typeof window.PowerDialer.afterContactsRender === "function") {
      window.PowerDialer.afterContactsRender();
    }
  }

  // ---- Column resize (drag the right edge of a header to change its width) ----
  let _resizing = null;
  document.addEventListener("mousedown", (e) => {
    const handle = e.target.closest("#contacts-table .col-resize");
    if (!handle) return;
    e.preventDefault();
    e.stopPropagation();
    const th = handle.closest("th");
    const colId = th?.dataset.colId;
    if (!colId) return;
    const colEl = $("#contacts-table colgroup col[data-col-id='" + colId + "']");
    const startWidth = colEl ? colEl.offsetWidth || parseInt(colEl.style.width, 10) || 100 : 100;
    _resizing = { colId, startX: e.clientX, startWidth, colEl };
    document.body.classList.add("col-resizing");
  });
  document.addEventListener("mousemove", (e) => {
    if (!_resizing) return;
    const dx = e.clientX - _resizing.startX;
    const cols = allContactColumns();
    const min = (cols.find(c => c.id === _resizing.colId)?.minWidth) || 40;
    const newWidth = Math.max(min, _resizing.startWidth + dx);
    if (_resizing.colEl) _resizing.colEl.style.width = newWidth + "px";
    // Also expand/shrink the table so the column actually grows visually.
    const tbl = $("#contacts-table");
    if (tbl) {
      let total = 0;
      $$("colgroup col", tbl).forEach(col => {
        total += parseInt(col.style.width, 10) || 0;
      });
      tbl.style.width = total + "px";
    }
  });
  document.addEventListener("mouseup", () => {
    if (!_resizing) return;
    if (_resizing.colEl) {
      const w = parseInt(_resizing.colEl.style.width, 10);
      if (Number.isFinite(w) && w > 0) {
        state.contactColumnWidths = state.contactColumnWidths || {};
        state.contactColumnWidths[_resizing.colId] = w;
        saveColumnWidths();
      }
    }
    _resizing = null;
    // Mouseup on the resize handle bubbles a click — block sort from firing.
    _suppressNextHeaderClick = true;
    document.body.classList.remove("col-resizing");
  });

  // ---- Column reorder (drag a header to a new position) ----
  document.addEventListener("dragstart", (e) => {
    const th = e.target.closest("#contacts-table thead th[draggable='true']");
    if (!th) return;
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", th.dataset.colId || ""); } catch {}
    th.classList.add("col-dragging");
  });
  document.addEventListener("dragend", (e) => {
    const th = e.target.closest("#contacts-table thead th");
    if (th) th.classList.remove("col-dragging");
    $$("#contacts-table thead th.col-drop-target").forEach(el => el.classList.remove("col-drop-target"));
  });
  document.addEventListener("dragover", (e) => {
    const th = e.target.closest("#contacts-table thead th[draggable='true']");
    if (!th) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    $$("#contacts-table thead th.col-drop-target").forEach(el => el.classList.remove("col-drop-target"));
    th.classList.add("col-drop-target");
  });
  document.addEventListener("dragleave", (e) => {
    const th = e.target.closest("#contacts-table thead th");
    if (th) th.classList.remove("col-drop-target");
  });
  document.addEventListener("drop", (e) => {
    const target = e.target.closest("#contacts-table thead th[draggable='true']");
    if (!target) return;
    e.preventDefault();
    let srcId = "";
    try { srcId = e.dataTransfer.getData("text/plain"); } catch {}
    const dstId = target.dataset.colId;
    target.classList.remove("col-drop-target");
    if (!srcId || !dstId || srcId === dstId) return;
    const cols = getOrderedContactColumns();
    const middle = cols.filter(c => !c.anchored).map(c => c.id);
    const fromIdx = middle.indexOf(srcId);
    const toIdx   = middle.indexOf(dstId);
    if (fromIdx < 0 || toIdx < 0) return;
    middle.splice(toIdx, 0, middle.splice(fromIdx, 1)[0]);
    state.contactColumnOrder = middle;
    saveColumnOrder();
    // The drop fires a synthetic click on the target — don't let it sort.
    _suppressNextHeaderClick = true;
    renderContacts();
  });

  // ---- Custom Columns picker ----
  function openColumnPicker() {
    const list = $("#column-picker-list");
    if (!list) return;
    const cols = allContactColumns().filter(c => !c.anchored);
    const hidden = state.contactColumnHidden || new Set();
    const rowsHtml = cols.map(col => {
      const isVisible = !hidden.has(col.id);
      const deleteBtn = col.isCustom
        ? `<button type="button" class="column-picker-delete" data-custom-id="${col.customFieldId}" title="Delete this custom column" aria-label="Delete">×</button>`
        : "";
      const renameBtn = col.isCustom
        ? `<button type="button" class="column-picker-rename" data-custom-id="${col.customFieldId}" title="Rename" aria-label="Rename">✎</button>`
        : "";
      const customMark = col.isCustom ? `<span class="column-picker-custom-tag">custom</span>` : "";
      return (
        `<label class="column-picker-row">` +
          `<input type="checkbox" class="column-toggle" data-col-id="${col.id}"${isVisible ? " checked" : ""} />` +
          `<span class="column-picker-label">${escapeHtml(col.label || col.id)}${customMark}</span>` +
          renameBtn + deleteBtn +
        `</label>`
      );
    }).join("");
    const addBtn =
      `<button type="button" id="column-picker-add" class="column-picker-add">` +
        `<span class="cpa-plus">+</span> Add custom column` +
      `</button>`;
    list.innerHTML = rowsHtml + addBtn;
    $("#column-picker-backdrop")?.classList.remove("hidden");
    $("#column-picker")?.classList.remove("hidden");
  }
  function closeColumnPicker() {
    $("#column-picker")?.classList.add("hidden");
    $("#column-picker-backdrop")?.classList.add("hidden");
  }
  $("#custom-columns-btn")?.addEventListener("click", openColumnPicker);
  $("#column-picker-close")?.addEventListener("click", closeColumnPicker);
  $("#column-picker-done")?.addEventListener("click", closeColumnPicker);
  $("#column-picker-backdrop")?.addEventListener("click", closeColumnPicker);
  // ESC closes the picker.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#column-picker")?.classList.contains("hidden")) {
      closeColumnPicker();
    }
  });
  // Toggle a column's visibility.
  $("#column-picker-list")?.addEventListener("change", (e) => {
    const cb = e.target.closest(".column-toggle");
    if (!cb) return;
    const id = cb.dataset.colId;
    if (!id) return;
    state.contactColumnHidden = state.contactColumnHidden || new Set();
    if (cb.checked) state.contactColumnHidden.delete(id);
    else state.contactColumnHidden.add(id);
    saveColumnHidden();
    renderContacts();
  });

  // Add / rename / delete custom columns from inside the picker.
  $("#column-picker-list")?.addEventListener("click", async (e) => {
    // Add a new custom column
    if (e.target.closest("#column-picker-add")) {
      e.preventDefault();
      const label = window.prompt("Name this column (e.g. \"Notes\", \"Best time to call\", \"Pain point\"):");
      if (!label) return;
      const trimmed = label.trim();
      if (!trimmed) return;
      try {
        const res = await fetch("/api/custom-fields", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label: trimmed }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || "Failed.");
        state.customFields = [...(state.customFields || []), { id: body.id, label: body.label, position: body.position }];
        toast(`Added column "${body.label}".`);
        renderContacts();
        openColumnPicker();
      } catch (err) { toast(err.message, "error"); }
      return;
    }
    // Rename a custom column
    const renameBtn = e.target.closest(".column-picker-rename");
    if (renameBtn) {
      e.preventDefault();
      const fid = Number(renameBtn.dataset.customId);
      const field = (state.customFields || []).find(f => f.id === fid);
      const newLabel = window.prompt("New name:", field?.label || "");
      if (!newLabel) return;
      const trimmed = newLabel.trim();
      if (!trimmed || trimmed === field?.label) return;
      try {
        const res = await fetch(`/api/custom-fields/${fid}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label: trimmed }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || "Failed.");
        state.customFields = (state.customFields || []).map(f =>
          f.id === fid ? { ...f, label: trimmed } : f
        );
        renderContacts();
        openColumnPicker();
      } catch (err) { toast(err.message, "error"); }
      return;
    }
    // Delete a custom column
    const deleteBtn = e.target.closest(".column-picker-delete");
    if (deleteBtn) {
      e.preventDefault();
      const fid = Number(deleteBtn.dataset.customId);
      const field = (state.customFields || []).find(f => f.id === fid);
      const ok = window.confirm(
        `Delete the "${field?.label || 'custom'}" column?\n\n` +
        `Values you've entered for this column on individual contacts will be lost.`
      );
      if (!ok) return;
      try {
        const res = await fetch(`/api/custom-fields/${fid}`, { method: "DELETE" });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || "Failed.");
        state.customFields = (state.customFields || []).filter(f => f.id !== fid);
        // Also drop any cached value on already-loaded contacts so the UI
        // matches the server immediately.
        state.contacts.forEach(c => { if (c.custom_data) delete c.custom_data[String(fid)]; });
        renderContacts();
        openColumnPicker();
      } catch (err) { toast(err.message, "error"); }
      return;
    }
  });
  // Reset to default = show all columns, default order, default widths.
  $("#column-picker-reset")?.addEventListener("click", () => {
    state.contactColumnHidden = new Set();
    state.contactColumnOrder = null;
    state.contactColumnWidths = {};
    saveColumnHidden();
    saveColumnOrder();
    saveColumnWidths();
    renderContacts();
    openColumnPicker();  // refresh the checkboxes to reflect the reset
  });

  // ------- Selection (bulk action) state -------
  // Update the select-all checkbox + bottom bar to reflect current selection
  // against the visible (filtered) rows.
  function refreshSelectionUI() {
    const visibleIds = new Set(_visibleContacts.map(c => c.id));
    let visibleSelected = 0;
    for (const id of state.selectedContacts) {
      if (visibleIds.has(id)) visibleSelected++;
    }
    const total = _visibleContacts.length;
    const selectAll = $("#select-all-contacts");
    if (selectAll) {
      selectAll.checked = total > 0 && visibleSelected === total;
      selectAll.indeterminate = visibleSelected > 0 && visibleSelected < total;
    }
    const bar = $("#selection-bar");
    const count = state.selectedContacts.size;
    if (bar) {
      if (count > 0) {
        bar.classList.remove("hidden");
        $("#selection-count").textContent = count;
      } else {
        bar.classList.add("hidden");
      }
    }
  }

  function clearSelection() {
    state.selectedContacts.clear();
    // Uncheck every visible checkbox without re-rendering everything
    $$("#contacts-table .row-select:checked").forEach(cb => { cb.checked = false; });
    $$("#contacts-table tr.row-selected").forEach(tr => tr.classList.remove("row-selected"));
    refreshSelectionUI();
  }

  // ------- Companies -------
  // Snapshot of currently-visible (post-filter) companies so the select-all
  // checkbox and bulk actions know which IDs the user is looking at.
  let _visibleCompanies = [];
  function renderCompanies() {
    const tbody = $("#companies-table tbody");
    const q = state.search.toLowerCase();
    const rows = sortRows(
      state.companies.filter(co => {
        if (!q) return true;
        return [co.name, co.industry, co.location, co.website, co.notes]
          .join(" ").toLowerCase().includes(q);
      }),
      "companies",
    );
    _visibleCompanies = rows;
    // Drop selections for rows no longer visible.
    const liveIds = new Set(rows.map(r => r.id));
    for (const id of [...state.selectedCompanies]) {
      if (!liveIds.has(id)) state.selectedCompanies.delete(id);
    }
    tbody.innerHTML = "";
    rows.forEach(co => {
      const tr = document.createElement("tr");
      tr.dataset.id = co.id;
      const checked = state.selectedCompanies.has(co.id);
      if (checked) tr.classList.add("row-selected");
      tr.innerHTML = `
        <td class="col-select"><input type="checkbox" class="co-row-select" data-id="${co.id}"${checked ? " checked" : ""} aria-label="Select" /></td>
        <td><strong>${escapeHtml(co.name)}</strong></td>
        <td>${escapeHtml(co.industry || "")}</td>
        <td>${escapeHtml(co.location || "")}</td>
        <td>${co.website ? escapeHtml(co.website) : ""}</td>
        <td style="color:var(--text-dim)">${escapeHtml((co.notes || "").slice(0,60))}</td>
      `;
      tr.addEventListener("click", (e) => {
        // Clicking the checkbox/cell should toggle selection, not open the modal.
        if (e.target.closest(".col-select")) return;
        openCompanyModal(co);
      });
      tbody.appendChild(tr);
    });
    refreshCompaniesSelectionUI();
  }

  function refreshCompaniesSelectionUI() {
    const bar = $("#companies-selection-bar");
    const count = state.selectedCompanies.size;
    if (bar) {
      const countEl = $("#companies-selection-count");
      if (countEl) countEl.textContent = String(count);
      bar.classList.toggle("hidden", count === 0);
    }
    // Sync select-all header checkbox to the visible-row state.
    const selectAll = $("#select-all-companies");
    if (selectAll && _visibleCompanies.length) {
      const all = _visibleCompanies.every(c => state.selectedCompanies.has(c.id));
      const some = _visibleCompanies.some(c => state.selectedCompanies.has(c.id));
      selectAll.checked = all;
      selectAll.indeterminate = !all && some;
    } else if (selectAll) {
      selectAll.checked = false;
      selectAll.indeterminate = false;
    }
  }

  function clearCompaniesSelection() {
    state.selectedCompanies.clear();
    $$("#companies-table .co-row-select").forEach(cb => { cb.checked = false; });
    $$("#companies-table tr[data-id]").forEach(tr => tr.classList.remove("row-selected"));
    refreshCompaniesSelectionUI();
  }

  // ------- Deals (Kanban) -------
  function renderDeals() {
    const kb = $("#kanban");
    kb.innerHTML = "";
    const q = state.search.toLowerCase();
    const deals = state.deals.filter(d => {
      if (!q) return true;
      return [d.title, d.service, d.company_name, d.contact_name, d.notes]
        .join(" ").toLowerCase().includes(q);
    });
    state.meta.stages.forEach(stage => {
      const stageDeals = deals.filter(d => d.stage === stage);
      const total = stageDeals.reduce((acc, d) => acc + Number(d.value || 0), 0);
      const col = document.createElement("div");
      col.className = "kanban-col";
      col.dataset.stage = stage;
      col.innerHTML = `
        <div class="kanban-col-header">
          <div class="stage-name">${escapeHtml(stage)} <span style="color:var(--text-dim)">(${stageDeals.length})</span></div>
          <div class="stage-sum">${fmtMoney(total)}</div>
        </div>
        <div class="kanban-col-body"></div>
      `;
      const body = $(".kanban-col-body", col);
      stageDeals.forEach(d => {
        const card = document.createElement("div");
        card.className = "deal-card";
        card.draggable = true;
        card.dataset.id = d.id;
        card.innerHTML = `
          <div class="deal-card-title">${escapeHtml(d.title)}</div>
          <div class="deal-card-meta">
            <span class="tag ${serviceColor(d.service)}">${escapeHtml(d.service)}</span>
            <span>${escapeHtml(d.company_name || "")}</span>
            <span class="deal-card-value">${fmtMoney(d.value)}</span>
            ${d.expected_close ? `<span>Close: ${escapeHtml(d.expected_close)}</span>` : ""}
          </div>
        `;
        card.addEventListener("click", () => openDealModal(d));
        card.addEventListener("dragstart", e => {
          card.classList.add("dragging");
          e.dataTransfer.setData("text/plain", d.id);
          e.dataTransfer.effectAllowed = "move";
        });
        card.addEventListener("dragend", () => card.classList.remove("dragging"));
        body.appendChild(card);
      });
      col.addEventListener("dragover", e => {
        e.preventDefault();
        col.classList.add("drag-over");
      });
      col.addEventListener("dragleave", () => col.classList.remove("drag-over"));
      col.addEventListener("drop", async (e) => {
        e.preventDefault();
        col.classList.remove("drag-over");
        const id = Number(e.dataTransfer.getData("text/plain"));
        const deal = state.deals.find(d => d.id === id);
        if (!deal || deal.stage === stage) return;
        await api.put(`/api/deals/${id}`, { stage });
        deal.stage = stage;
        toast(`Moved "${deal.title}" → ${stage}`);
        renderDeals();
        renderDashboard();
      });
      kb.appendChild(col);
    });
  }

  // ------- Activities -------
  function renderActivities() {
    const tbody = $("#activities-table tbody");
    const q = state.search.toLowerCase();
    const rows = sortRows(
      state.activities.filter(a => {
        if (!q) return true;
        return [a.type, a.subject, a.contact_name, a.deal_title, a.notes]
          .join(" ").toLowerCase().includes(q);
      }),
      "activities",
    );
    tbody.innerHTML = "";
    rows.forEach(a => {
      const tr = document.createElement("tr");
      const tagColor = a.type === "voice_ai_call" ? "purple" : a.type === "call" ? "cyan" : a.type === "meeting" ? "orange" : "";
      const callDetails = [];
      if (a.outcome) callDetails.push(`<span class="tag ${a.outcome === "Answered" ? "green" : a.outcome === "Voicemail" ? "orange" : a.outcome === "Won" ? "green" : a.outcome === "Lost" ? "red" : ""}">${escapeHtml(a.outcome)}</span>`);
      if (a.duration_minutes) callDetails.push(`<span style="color:var(--text-dim);font-size:11px;">${a.duration_minutes} min</span>`);
      const callBadges = callDetails.length ? ` ${callDetails.join(" ")}` : "";
      tr.innerHTML = `
        <td><input type="checkbox" ${a.completed ? "checked" : ""} data-toggle="${a.id}"></td>
        <td><span class="tag ${tagColor}">${escapeHtml(a.type)}</span></td>
        <td><strong>${escapeHtml(a.subject)}</strong>${callBadges}</td>
        <td>${escapeHtml(a.due_date || "")}</td>
        <td>${escapeHtml(a.contact_name || "")}</td>
        <td>${escapeHtml(a.deal_title || "")}</td>
      `;
      tr.addEventListener("click", (e) => {
        if (e.target.dataset.toggle) return;
        openActivityModal(a);
      });
      const cb = $(`input[data-toggle="${a.id}"]`, tr);
      cb.addEventListener("click", async (e) => {
        e.stopPropagation();
        await api.put(`/api/activities/${a.id}`, { completed: cb.checked });
        a.completed = cb.checked ? 1 : 0;
        renderDashboard();
      });
      tbody.appendChild(tr);
    });
  }

  // ------- Modal system -------
  let modalContext = null; // { entity, id, collect }

  function openModal(title, bodyHtml, onSave, { id = null, onDelete = null } = {}) {
    $("#modal-title").textContent = title;
    $("#modal-body").innerHTML = bodyHtml;
    $("#modal-delete").classList.toggle("hidden", !onDelete);
    // Reset the Save button label every time in case a previous modal
    // (e.g. Log Call) renamed it.
    $("#modal-save").textContent = "Save";
    modalContext = { onSave, onDelete, id };
    $("#modal").classList.remove("hidden");
  }

  function closeModal() {
    $("#modal").classList.add("hidden");
    modalContext = null;
  }

  $("#modal-close").addEventListener("click", closeModal);
  $("#modal-cancel").addEventListener("click", closeModal);
  $("#modal").addEventListener("click", (e) => {
    if (e.target.id === "modal") closeModal();
  });
  $("#modal-save").addEventListener("click", async () => {
    if (!modalContext) return;
    try {
      await modalContext.onSave();
      closeModal();
      await loadAll();
      toast("Saved");
    } catch (err) {
      toast("Error: " + err.message, "error");
    }
  });
  $("#modal-delete").addEventListener("click", async () => {
    if (!modalContext || !modalContext.onDelete) return;
    if (!confirm("Delete this record?")) return;
    try {
      await modalContext.onDelete();
      closeModal();
      await loadAll();
      toast("Deleted");
    } catch (err) {
      toast("Error: " + err.message, "error");
    }
  });

  // ------- Modal builders -------
  function companyOptions(selected) {
    return `<option value="">—</option>` + state.companies.map(c =>
      `<option value="${c.id}" ${Number(selected) === c.id ? "selected" : ""}>${escapeHtml(c.name)}</option>`
    ).join("");
  }
  function contactOptions(selected) {
    return `<option value="">—</option>` + state.contacts.map(c =>
      `<option value="${c.id}" ${Number(selected) === c.id ? "selected" : ""}>${escapeHtml(c.first_name)} ${escapeHtml(c.last_name || "")}</option>`
    ).join("");
  }
  function dealOptions(selected) {
    return `<option value="">—</option>` + state.deals.map(d =>
      `<option value="${d.id}" ${Number(selected) === d.id ? "selected" : ""}>${escapeHtml(d.title)}</option>`
    ).join("");
  }
  function selectOptions(list, selected) {
    return list.map(s => `<option value="${escapeHtml(s)}" ${s === selected ? "selected" : ""}>${escapeHtml(s)}</option>`).join("");
  }

  function openContactModal(c = null) {
    const isNew = !c;
    c = c || {};
    const refBadge = c.ref_id != null
      ? `<div class="field full" style="margin-bottom:0;display:flex;flex-direction:row;align-items:center;justify-content:space-between;gap:10px">
           <div>
             <div style="font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.06em">Contact #</div>
             <div style="font-size:14px;color:var(--text);padding-top:4px">#${c.ref_id}</div>
           </div>
           <button type="button" class="btn" id="modal-log-call">📞 Log Call</button>
         </div>`
      : "";
    // Build list options + a free-form input via a datalist for autocomplete.
    const existingLists = [...new Set(state.contacts.map(contactList))].sort();
    const datalistOpts = existingLists.map(n => `<option value="${escapeHtml(n)}">`).join("");
    const defaultList = c.list_name || state.contactList || "Inbox";
    // User-defined custom fields appear under the built-in fields. Each one
    // is a textarea so it works for both short labels ("Best time to call")
    // and longer notes.
    const customFields = state.customFields || [];
    const customData = c.custom_data || {};
    const customSection = customFields.length
      ? `<div class="form-section-divider">Custom fields</div>` +
        customFields.map(f => {
          const val = customData[String(f.id)] || "";
          return (
            `<div class="field full">` +
              `<label>${escapeHtml(f.label)}</label>` +
              `<textarea data-custom-field-id="${f.id}" rows="2">${escapeHtml(val)}</textarea>` +
            `</div>`
          );
        }).join("")
      : "";

    // Website lives on the linked company, not the contact itself. We let
    // users edit it from here as a convenience — on save we PUT the company
    // alongside the contact PUT.
    const linkedCompany = state.companies.find(co => co.id === c.company_id) || null;
    const websiteHelp = linkedCompany
      ? `<div class="field-help">Saved on the linked company "${escapeHtml(linkedCompany.name)}"</div>`
      : `<div class="field-help">Pick a company above to enable Website editing.</div>`;
    const websiteField = `
      <div class="field full">
        <label>Website</label>
        <input id="f-website" placeholder="example.com"
               value="${escapeHtml(linkedCompany?.website || "")}"
               ${linkedCompany ? "" : "disabled"} />
        ${websiteHelp}
      </div>
    `;

    // Recent calls — read-only summary so the user can see what's already
    // been logged. Each row is clickable to open the activity modal for
    // editing. Only shown when there's at least one call.
    const calls = (state.activities || [])
      .filter(a => a.contact_id === c.id && a.type === "call")
      .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
    const callsSection = calls.length ? (
      `<div class="form-section-divider">` +
        `Recent calls (${calls.length})` +
      `</div>` +
      `<div class="field full">` +
        `<div class="contact-call-list" id="contact-call-list">` +
          calls.slice(0, 8).map(call => {
            const date = (call.due_date || call.created_at || "").slice(0, 10);
            const dur = call.duration_minutes ? `${call.duration_minutes}m` : "";
            const txt = (call.notes || "").trim();
            const head = [call.outcome, dur, date].filter(Boolean).join(" · ");
            return (
              `<button type="button" class="contact-call-row" data-activity-id="${call.id}" title="Edit this call">` +
                `<div class="contact-call-head">${escapeHtml(head || "Call")}</div>` +
                (txt ? `<div class="contact-call-body">${escapeHtml(txt)}</div>` : "") +
              `</button>`
            );
          }).join("") +
          (calls.length > 8 ? `<div class="contact-call-more">+ ${calls.length - 8} earlier call${calls.length - 8 === 1 ? "" : "s"}</div>` : "") +
        `</div>` +
      `</div>`
    ) : "";

    const body = `
      ${refBadge}
      <div class="form-grid">
        <div class="field"><label>First name</label><input id="f-first" value="${escapeHtml(c.first_name || "")}" /></div>
        <div class="field"><label>Last name</label><input id="f-last" value="${escapeHtml(c.last_name || "")}" /></div>
        <div class="field"><label>Email</label><input id="f-email" type="email" value="${escapeHtml(c.email || "")}" /></div>
        <div class="field"><label>Phone</label><input id="f-phone" value="${escapeHtml(c.phone || "")}" /></div>
        <div class="field"><label>Title</label><input id="f-title" value="${escapeHtml(c.title || "")}" /></div>
        <div class="field"><label>Company</label><select id="f-company">${companyOptions(c.company_id)}</select></div>
        ${websiteField}
        <div class="field"><label>Source</label><input id="f-source" value="${escapeHtml(c.source || "")}" /></div>
        <div class="field"><label>List</label>
          <input id="f-list" list="contact-list-suggestions" value="${escapeHtml(defaultList)}" placeholder="Inbox" />
          <datalist id="contact-list-suggestions">${datalistOpts}</datalist>
        </div>
        <div class="field full"><label>Tags (comma separated)</label><input id="f-tags" value="${escapeHtml(c.tags || "")}" /></div>
        <div class="field full"><label>Notes</label><textarea id="f-notes">${escapeHtml(c.notes || "")}</textarea></div>
        ${callsSection}
        ${customSection}
      </div>
    `;
    const collect = () => ({
      first_name: $("#f-first").value,
      last_name: $("#f-last").value,
      email: $("#f-email").value,
      phone: $("#f-phone").value,
      title: $("#f-title").value,
      company_id: $("#f-company").value || null,
      source: $("#f-source").value,
      list_name: $("#f-list").value,
      tags: $("#f-tags").value,
      notes: $("#f-notes").value,
    });
    // After the main save, walk the custom-field textareas and PUT each one.
    // Skip values that haven't changed, and skip the create flow (we don't
    // know the contact id yet — but the modal save flow returns it).
    const collectCustom = () => {
      const result = [];
      $$("textarea[data-custom-field-id]", $("#modal-body")).forEach(t => {
        result.push({ id: Number(t.dataset.customFieldId), value: t.value });
      });
      return result;
    };
    const saveContact = async () => {
      const payload = collect();
      let savedId = c.id;
      if (isNew) {
        const created = await api.post("/api/contacts", payload);
        savedId = created?.id;
      } else {
        await api.put(`/api/contacts/${c.id}`, payload);
      }
      // Save custom values (only if we have an id and any are non-empty
      // OR they changed).
      if (savedId) {
        const newCustoms = collectCustom();
        const prev = c.custom_data || {};
        for (const { id: fid, value } of newCustoms) {
          const before = prev[String(fid)] || "";
          if (before === value) continue;
          await fetch(`/api/contacts/${savedId}/custom/${fid}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ value }),
          });
        }
      }
      // Website lives on the linked company. If the user edited it, push
      // the new value back to the company. (Skip if no company linked, or
      // value didn't actually change.)
      const websiteEl = $("#f-website");
      const newCompanyId = Number($("#f-company").value) || null;
      const company = state.companies.find(co => co.id === newCompanyId) || null;
      if (websiteEl && !websiteEl.disabled && company) {
        const next = (websiteEl.value || "").trim();
        const before = (company.website || "").trim();
        if (next !== before) {
          await api.put(`/api/companies/${company.id}`, {
            name: company.name,
            industry: company.industry || "",
            website: next,
            location: company.location || "",
            notes: company.notes || "",
          });
        }
      }
      return { id: savedId };
    };
    openModal(isNew ? "New Contact" : "Edit Contact", body, saveContact,
      { id: c.id, onDelete: isNew ? null : () => api.del(`/api/contacts/${c.id}`) }
    );
    // Wire the Log Call button that's rendered inside the modal header area.
    const logBtn = $("#modal-log-call");
    if (logBtn) {
      logBtn.addEventListener("click", (e) => {
        e.preventDefault();
        closeModal();
        openCallLogModal(c);
      });
    }
    // Re-enable the Website field when the user picks a company.
    $("#f-company")?.addEventListener("change", (e) => {
      const newCo = state.companies.find(co => co.id === Number(e.target.value)) || null;
      const wEl = $("#f-website");
      const helpEl = wEl?.parentElement?.querySelector(".field-help");
      if (!wEl) return;
      if (newCo) {
        wEl.disabled = false;
        wEl.value = newCo.website || "";
        if (helpEl) helpEl.textContent = `Saved on the linked company "${newCo.name}"`;
      } else {
        wEl.disabled = true;
        wEl.value = "";
        if (helpEl) helpEl.textContent = "Pick a company above to enable Website editing.";
      }
    });
    // Click a row in the "Recent calls" list to open it for editing.
    $$(".contact-call-row", $("#modal-body")).forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const aid = Number(btn.dataset.activityId);
        const activity = (state.activities || []).find(a => a.id === aid);
        if (activity) {
          closeModal();
          openActivityModal(activity);
        }
      });
    });
  }

  // ------- Call log quick-entry modal -------
  const CALL_OUTCOMES = [
    "Answered",
    "Voicemail",
    "No answer",
    "Callback requested",
    "Busy",
    "Won",
    "Lost",
    "Other",
  ];

  function openCallLogModal(contact) {
    const name = `${contact.first_name || ""} ${contact.last_name || ""}`.trim() || "contact";
    const phone = contact.phone || "";
    const today = new Date().toISOString().slice(0, 10);
    // Default follow-up = 3 days from now.
    const followUp = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    const body = `
      <div class="form-grid">
        <div class="field full">
          <label>Contact</label>
          <div style="padding:8px 0;font-size:14px">
            <strong>${escapeHtml(name)}</strong>
            ${phone ? ` · <a class="phone-link" href="tel:${encodeURIComponent(phone)}">${escapeHtml(formatPhone(phone))}</a>` : ""}
          </div>
        </div>
        <div class="field">
          <label>Outcome</label>
          <select id="call-outcome">
            ${CALL_OUTCOMES.map(o => `<option value="${o}">${o}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label>Duration (min)</label>
          <input id="call-duration" type="number" min="0" step="1" value="0" />
        </div>
        <div class="field full">
          <label>Notes</label>
          <textarea id="call-notes" rows="4" placeholder="What was discussed?"></textarea>
        </div>
        <div class="field inline full" style="align-items:center">
          <input id="call-followup-toggle" type="checkbox" />
          <label for="call-followup-toggle" style="text-transform:none;letter-spacing:0;color:var(--text);font-size:13px">Schedule a follow-up task</label>
        </div>
        <div class="field" id="call-followup-wrap" style="display:none">
          <label>Follow-up date</label>
          <input id="call-followup-date" type="date" value="${followUp}" />
        </div>
        <div class="field" id="call-followup-subject-wrap" style="display:none">
          <label>Follow-up subject</label>
          <input id="call-followup-subject" type="text" value="Follow up with ${escapeHtml(name)}" />
        </div>
      </div>
    `;
    openModal("Log Call", body, async () => {
      const outcome = $("#call-outcome").value;
      const duration = parseInt($("#call-duration").value || "0", 10);
      const notesText = $("#call-notes").value.trim();
      // The call itself — completed, dated today.
      const subject = `Call with ${name}${outcome ? ` — ${outcome}` : ""}`;
      await api.post("/api/activities", {
        type: "call",
        subject,
        due_date: today,
        completed: true,
        contact_id: contact.id,
        outcome,
        duration_minutes: duration,
        notes: notesText,
      });
      // Optional follow-up task.
      if ($("#call-followup-toggle").checked) {
        await api.post("/api/activities", {
          type: "task",
          subject: $("#call-followup-subject").value || `Follow up with ${name}`,
          due_date: $("#call-followup-date").value,
          completed: false,
          contact_id: contact.id,
          notes: notesText ? `From call: ${notesText}` : "",
        });
      }
    });
    // Toggle the follow-up fields.
    $("#call-followup-toggle").addEventListener("change", (e) => {
      const show = e.target.checked ? "" : "none";
      $("#call-followup-wrap").style.display = show;
      $("#call-followup-subject-wrap").style.display = show;
    });
    // Change Save button label to "Save call"
    const saveBtn = $("#modal-save");
    if (saveBtn) saveBtn.textContent = "Save call";
  }

  function openCompanyModal(co = null) {
    const isNew = !co;
    co = co || {};
    const body = `
      <div class="form-grid">
        <div class="field full"><label>Company name</label><input id="f-name" value="${escapeHtml(co.name || "")}" /></div>
        <div class="field"><label>Industry</label><input id="f-industry" value="${escapeHtml(co.industry || "")}" /></div>
        <div class="field"><label>Location</label><input id="f-location" value="${escapeHtml(co.location || "")}" /></div>
        <div class="field full"><label>Website</label><input id="f-website" value="${escapeHtml(co.website || "")}" /></div>
        <div class="field full"><label>Notes</label><textarea id="f-notes">${escapeHtml(co.notes || "")}</textarea></div>
      </div>
    `;
    const collect = () => ({
      name: $("#f-name").value,
      industry: $("#f-industry").value,
      website: $("#f-website").value,
      location: $("#f-location").value,
      notes: $("#f-notes").value,
    });
    openModal(isNew ? "New Company" : "Edit Company", body,
      () => isNew ? api.post("/api/companies", collect()) : api.put(`/api/companies/${co.id}`, collect()),
      { id: co.id, onDelete: isNew ? null : () => api.del(`/api/companies/${co.id}`) }
    );
  }

  function openDealModal(d = null) {
    const isNew = !d;
    d = d || { stage: "Lead", service: state.meta.services[0], probability: 50 };
    const body = `
      <div class="form-grid">
        <div class="field full"><label>Deal title</label><input id="f-title" value="${escapeHtml(d.title || "")}" /></div>
        <div class="field"><label>Service</label><select id="f-service">${selectOptions(state.meta.services, d.service)}</select></div>
        <div class="field"><label>Stage</label><select id="f-stage">${selectOptions(state.meta.stages, d.stage)}</select></div>
        <div class="field"><label>Value (USD)</label><input id="f-value" type="number" step="0.01" value="${d.value || 0}" /></div>
        <div class="field"><label>Probability (%)</label><input id="f-prob" type="number" min="0" max="100" value="${d.probability || 0}" /></div>
        <div class="field"><label>Expected close</label><input id="f-close" type="date" value="${escapeHtml(d.expected_close || "")}" /></div>
        <div class="field"><label>Owner</label><input id="f-owner" value="${escapeHtml(d.owner || "")}" /></div>
        <div class="field"><label>Company</label><select id="f-company">${companyOptions(d.company_id)}</select></div>
        <div class="field"><label>Contact</label><select id="f-contact">${contactOptions(d.contact_id)}</select></div>
        <div class="field full"><label>Notes</label><textarea id="f-notes">${escapeHtml(d.notes || "")}</textarea></div>
      </div>
    `;
    const collect = () => ({
      title: $("#f-title").value,
      service: $("#f-service").value,
      stage: $("#f-stage").value,
      value: Number($("#f-value").value || 0),
      probability: Number($("#f-prob").value || 0),
      expected_close: $("#f-close").value,
      owner: $("#f-owner").value,
      company_id: $("#f-company").value || null,
      contact_id: $("#f-contact").value || null,
      notes: $("#f-notes").value,
    });
    openModal(isNew ? "New Deal" : "Edit Deal", body,
      () => isNew ? api.post("/api/deals", collect()) : api.put(`/api/deals/${d.id}`, collect()),
      { id: d.id, onDelete: isNew ? null : () => api.del(`/api/deals/${d.id}`) }
    );
  }

  function openActivityModal(a = null) {
    const isNew = !a;
    a = a || { type: "task", completed: 0 };
    const types = ["task", "call", "email", "meeting", "note", "voice_ai_call"];
    const body = `
      <div class="form-grid">
        <div class="field"><label>Type</label><select id="f-type">${selectOptions(types, a.type)}</select></div>
        <div class="field"><label>Due date</label><input id="f-due" type="date" value="${escapeHtml(a.due_date || "")}" /></div>
        <div class="field full"><label>Subject</label><input id="f-subject" value="${escapeHtml(a.subject || "")}" /></div>
        <div class="field"><label>Outcome</label><select id="f-outcome">
          <option value=""${!a.outcome ? " selected" : ""}>—</option>
          ${CALL_OUTCOMES.map(o => `<option value="${o}"${a.outcome === o ? " selected" : ""}>${o}</option>`).join("")}
        </select></div>
        <div class="field"><label>Duration (min)</label><input id="f-duration" type="number" min="0" step="1" value="${a.duration_minutes || ""}" /></div>
        <div class="field"><label>Contact</label><select id="f-contact">${contactOptions(a.contact_id)}</select></div>
        <div class="field"><label>Deal</label><select id="f-deal">${dealOptions(a.deal_id)}</select></div>
        <div class="field full"><label>Notes</label><textarea id="f-notes">${escapeHtml(a.notes || "")}</textarea></div>
        <div class="field inline full"><input id="f-done" type="checkbox" ${a.completed ? "checked" : ""}/><label for="f-done">Completed</label></div>
      </div>
    `;
    const collect = () => ({
      type: $("#f-type").value,
      subject: $("#f-subject").value,
      due_date: $("#f-due").value,
      contact_id: $("#f-contact").value || null,
      deal_id: $("#f-deal").value || null,
      notes: $("#f-notes").value,
      outcome: $("#f-outcome").value,
      duration_minutes: $("#f-duration").value,
      completed: $("#f-done").checked,
    });
    openModal(isNew ? "New Activity" : "Edit Activity", body,
      () => isNew ? api.post("/api/activities", collect()) : api.put(`/api/activities/${a.id}`, collect()),
      { id: a.id, onDelete: isNew ? null : () => api.del(`/api/activities/${a.id}`) }
    );
  }

  // ------- Mobile sidebar -------
  const sidebar = document.querySelector(".sidebar");
  const scrim = $("#sidebar-scrim");
  const menuToggle = $("#menu-toggle");
  function openSidebar() {
    sidebar.classList.add("open");
    scrim.classList.add("visible");
    document.body.classList.add("no-scroll");
  }
  function closeSidebar() {
    sidebar.classList.remove("open");
    scrim.classList.remove("visible");
    document.body.classList.remove("no-scroll");
  }
  menuToggle?.addEventListener("click", () => {
    if (sidebar.classList.contains("open")) closeSidebar();
    else openSidebar();
  });
  scrim?.addEventListener("click", closeSidebar);

  // ------- Project switcher button -------
  $("#project-switcher-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = $("#project-switcher-menu");
    if (menu.hasAttribute("hidden")) menu.removeAttribute("hidden");
    else menu.setAttribute("hidden", "");
  });
  document.addEventListener("click", (e) => {
    const menu = $("#project-switcher-menu");
    if (!menu) return;
    if (!menu.contains(e.target) && !$("#project-switcher-btn")?.contains(e.target)) {
      menu.setAttribute("hidden", "");
    }
  });

  // ------- Sortable column headers -------
  document.addEventListener("click", (e) => {
    // Clicks on the resize grabber must not trigger sort.
    if (e.target.closest(".col-resize")) return;
    // If the user just finished dragging a column, swallow the synthetic click.
    if (_suppressNextHeaderClick) {
      _suppressNextHeaderClick = false;
      return;
    }
    const th = e.target.closest(".data-table.sortable th[data-sort]");
    if (!th) return;
    const table = th.closest("table");
    const entity = table?.dataset.entity;
    if (!entity) return;
    const column = th.dataset.sort;
    const type = th.dataset.type || "string";
    const cur = state.sort[entity] || {};
    const direction = (cur.column === column && cur.direction === "asc") ? "desc" : "asc";
    state.sort[entity] = { column, direction, type };
    render();
  });
  let _suppressNextHeaderClick = false;

  // ------- Event wiring -------
  $$(".nav-item").forEach(b => b.addEventListener("click", () => {
    // Sub-items (Free / Pro under Lead Generator, or Profile / Billing
    // under Settings) carry an extra attribute that tells us which
    // sub-mode to activate.
    if (b.dataset.leadgenMode) {
      state.leadgenMode = b.dataset.leadgenMode;
    }
    if (b.dataset.settingsMode) {
      state.settingsMode = b.dataset.settingsMode;
    }
    if (b.dataset.gameMode) {
      state.gameMode = b.dataset.gameMode;
    }
    if (b.dataset.scriptMode) {
      state.scriptMode = b.dataset.scriptMode;
    }
    switchView(b.dataset.view);
    closeSidebar();
  }));

  // Collapsible "Lead Generator" section. Clicking the header toggles its
  // children. Accordion behavior: opening one collapses the others.
  const _NAV_SECTIONS = [
    { id: "leadgen-section-toggle",  children: "leadgen-section-children" },
    { id: "settings-section-toggle", children: "settings-section-children" },
    { id: "scripts-section-toggle",  children: "scripts-section-children" },
    { id: "games-section-toggle",    children: "games-section-children" },
  ];
  function setNavSectionOpen(toggleId, open) {
    _NAV_SECTIONS.forEach(s => {
      const t = $("#" + s.id);
      const c = $("#" + s.children);
      if (!t || !c) return;
      const shouldOpen = (s.id === toggleId) ? !!open : false;
      t.setAttribute("aria-expanded", String(shouldOpen));
      c.classList.toggle("collapsed", !shouldOpen);
    });
  }
  _NAV_SECTIONS.forEach(s => {
    $("#" + s.id)?.addEventListener("click", () => {
      const t = $("#" + s.id);
      const wasExpanded = t.getAttribute("aria-expanded") === "true";
      setNavSectionOpen(s.id, !wasExpanded);
    });
  });

  // Scripts → Web Design: inner toggle between No-website and Existing-website variants.
  $$(".scripts-tab[data-webdesign-tab]").forEach(tab => {
    tab.addEventListener("click", () => {
      const which = tab.dataset.webdesignTab;
      if (!which) return;
      $$(".scripts-tab[data-webdesign-tab]").forEach(t =>
        t.classList.toggle("active", t.dataset.webdesignTab === which));
      $$(".script-subpane[data-webdesign-pane]").forEach(p =>
        p.classList.toggle("hidden", p.dataset.webdesignPane !== which));
    });
  });

  // --- Mirror buttons in contacts-row-actions ---------------------
  // Forward clicks to the canonical topbar / topbar-mirror buttons so
  // there's one handler per action. The canonical buttons stay in the
  // topbar (Import/Export) because per-view JS toggles their visibility
  // and dataset.entity for Companies / Deals / Activities; the row
  // mirrors only show on the Contacts page.
  document.getElementById("import-btn-row")?.addEventListener("click", () => {
    document.getElementById("import-btn")?.click();
  });
  document.getElementById("export-btn-row")?.addEventListener("click", () => {
    document.getElementById("export-btn")?.click();
  });
  document.getElementById("new-btn-desktop")?.addEventListener("click", () => {
    document.getElementById("new-btn")?.click();
  });

  // --- Contacts toolbar overflow menu (mobile) ---------------------
  // The kebab toggles a dropdown. Each item carries data-fire="<button-id>"
  // and forwards the click to the original (hidden on mobile) button so
  // every action has exactly one event-handling path, regardless of
  // whether it was triggered from the visible button or the menu item.
  (function wireContactsOverflowMenu() {
    const btn   = document.getElementById("contacts-overflow-btn");
    const panel = document.getElementById("contacts-overflow-panel");
    if (!btn || !panel) return;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = panel.hasAttribute("hidden");
      if (open) panel.removeAttribute("hidden");
      else      panel.setAttribute("hidden", "");
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    });
    // Close on outside click
    document.addEventListener("click", (e) => {
      if (panel.hasAttribute("hidden")) return;
      if (e.target.closest("#contacts-overflow-menu")) return;
      panel.setAttribute("hidden", "");
      btn.setAttribute("aria-expanded", "false");
    });
    // Forward item clicks to the matching toolbar button
    panel.addEventListener("click", (e) => {
      const item = e.target.closest("[data-fire]");
      if (!item) return;
      const target = document.getElementById(item.dataset.fire);
      panel.setAttribute("hidden", "");
      btn.setAttribute("aria-expanded", "false");
      if (target) target.click();
    });

    // Two-way sync the kebab search input with the (hidden on mobile)
    // topbar #search input so the existing input-event filter logic
    // fires regardless of which input the user typed into.
    const overflowSearch = document.getElementById("overflow-search-input");
    const topbarSearch   = document.getElementById("search");
    if (overflowSearch && topbarSearch) {
      // Seed initial value
      overflowSearch.value = topbarSearch.value || "";
      overflowSearch.addEventListener("input", () => {
        topbarSearch.value = overflowSearch.value;
        // Re-fire the input event so any existing listeners run.
        topbarSearch.dispatchEvent(new Event("input", { bubbles: true }));
      });
      // Keep them in sync the other way too (in case desktop user types
      // in topbar then resizes / opens kebab).
      topbarSearch.addEventListener("input", () => {
        if (overflowSearch.value !== topbarSearch.value) {
          overflowSearch.value = topbarSearch.value;
        }
      });
    }
  })();

  $("#new-btn").addEventListener("click", () => {
    switch (state.view) {
      case "contacts": return openContactModal();
      case "companies": return openCompanyModal();
      case "deals": return openDealModal();
      case "activities": return openActivityModal();
      case "users": return openCreateUserModal();
      default: return openDealModal(); // dashboard defaults to new deal
    }
  });

  // -------- Admin Panel: Create user modal --------
  function openCreateUserModal() {
    const modal = $("#create-user-modal");
    if (!modal) return;
    // Reset fields each time so a previous draft doesn't linger.
    ["#cu-username", "#cu-password", "#cu-first", "#cu-last", "#cu-email", "#cu-phone"]
      .forEach(sel => { const el = $(sel); if (el) el.value = ""; });
    const gf = $("#cu-grandfather");
    if (gf) gf.checked = true;
    modal.classList.remove("hidden");
    // Focus the first field so the admin can start typing immediately.
    setTimeout(() => $("#cu-username")?.focus(), 30);
  }
  function closeCreateUserModal() {
    $("#create-user-modal")?.classList.add("hidden");
  }
  $("#create-user-close")?.addEventListener("click", closeCreateUserModal);
  $("#create-user-cancel")?.addEventListener("click", closeCreateUserModal);
  // Click backdrop to close (but not when clicking the card itself).
  $("#create-user-modal")?.addEventListener("click", (e) => {
    if (e.target.id === "create-user-modal") closeCreateUserModal();
  });

  $("#search").addEventListener("input", (e) => {
    state.search = e.target.value;
    render();
  });

  // ------- CSV export -------
  $("#export-btn").addEventListener("click", () => {
    const entity = $("#export-btn").dataset.entity || "contacts";
    // For Contacts, scope export to the active list filter so each list
    // can be exported separately.
    let url = `/api/${entity}.csv`;
    if (entity === "contacts" && state.contactList) {
      url += `?list=${encodeURIComponent(state.contactList)}`;
    }
    window.location.href = url;
  });

  // ------- CSV import (contacts) -------
  // Shared upload pipeline used by both the file picker and drag-and-drop.
  async function uploadContactsCSV(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".csv") && file.type !== "text/csv") {
      toast("Please pick a .csv file", "error");
      return;
    }
    const defaultList = state.contactList || "Google Maps";
    const listName = window.prompt(
      "Which list should these contacts go into?\n" +
      "(e.g. \"Google Maps\", \"LinkedIn Scrape\", \"Trade Show 2026\")",
      defaultList,
    );
    if (listName === null) return;
    const form = new FormData();
    form.append("file", file);
    form.append("list_name", listName.trim() || "Inbox");
    try {
      const res = await fetch("/api/contacts/import", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Import failed.");
      const msg = `Imported ${body.created} contact${body.created === 1 ? "" : "s"} into "${listName.trim() || "Inbox"}"`
        + (body.skipped ? `, skipped ${body.skipped} (duplicate or empty)` : "");
      toast(msg);
      if (body.errors?.length) console.warn("CSV import errors:", body.errors);
      state.contactList = listName.trim() || "Inbox";
      await loadAll();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  // ------- Identify line types (mobile vs landline) — 100% local, free -------
  // Uses Google's libphonenumber on the server. No API calls, no signup.
  // For US numbers libphonenumber returns "fixed-line or mobile" most of the
  // time — those show as ? and you can click the badge to manually classify.
  $("#line-type-btn")?.addEventListener("click", async () => {
    const targetList = state.contactList;
    const eligible = state.contacts.filter(c => {
      if (!c.phone || !String(c.phone).trim()) return false;
      if (targetList && contactList(c) !== targetList) return false;
      return !c.phone_type;
    });
    const total = eligible.length;
    let payload = { list_name: targetList, refresh: false };
    if (total === 0) {
      const refresh = window.confirm(
        "Every contact in this view already has a line type. Re-classify all of them?"
      );
      if (!refresh) return;
      payload.refresh = true;
    }
    await runLineTypeLookup(payload);
  });

  // Chunk lookups into small batches. Each batch should comfortably finish
  // inside the gunicorn worker timeout. With NPA-NXX scrape rate-limited to
  // ~2/sec, a batch of 25 unique-prefix contacts finishes in ~12 seconds;
  // re-runs over already-cached prefixes are basically instant.
  const _LOOKUP_BATCH_SIZE = 25;

  async function _safeFetchJson(url, options) {
    const res = await fetch(url, options);
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); }
    catch {
      // Non-JSON response — almost always a gateway timeout / 502 / 504,
      // or the session expired and got redirected to the login page.
      const sample = (text || "").trim().slice(0, 80);
      if (res.status === 502 || res.status === 504) {
        throw new Error(`The upstream service timed out (${res.status}). Give it a moment and try again.`);
      }
      if (sample.startsWith("<!doctype") || sample.toLowerCase().includes("<html")) {
        throw new Error(`Server returned HTML instead of data (likely a timeout or login redirect). Try again.`);
      }
      throw new Error(`Unexpected response (status ${res.status}).`);
    }
    if (!res.ok) {
      throw new Error(body.error || `Request failed (status ${res.status}).`);
    }
    return body;
  }

  async function runLineTypeLookup(payload) {
    const btn = $("#line-type-btn");
    const original = btn ? btn.innerHTML : "";
    if (btn) btn.disabled = true;
    const setBtn = (text) => {
      if (!btn) return;
      btn.innerHTML = `<span class="btn-full">${text}</span><span class="btn-short">…</span>`;
    };
    setBtn("Identifying…");

    let totalLookedUp = 0;
    let totalSkipped = 0;
    const totals = { mobile: 0, landline: 0, voip: 0, tollfree: 0, premium: 0, invalid: 0, unknown: 0 };
    const startedAt = Date.now();
    let iteration = 0;
    let libraryAvailable = true;

    try {
      while (true) {
        iteration++;
        const body = await _safeFetchJson("/api/contacts/lookup-line-types", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, limit: _LOOKUP_BATCH_SIZE }),
        });
        if (body.library_available === false) {
          libraryAvailable = false;
          break;
        }
        totalLookedUp += body.looked_up || 0;
        totalSkipped  += body.skipped  || 0;
        for (const k in (body.breakdown || {})) {
          totals[k] = (totals[k] || 0) + body.breakdown[k];
        }
        const remaining = body.remaining ?? 0;
        // Update button live so the user sees progress.
        const totalPlanned = totalLookedUp + remaining;
        if (totalPlanned > 0) {
          setBtn(`Identifying… ${totalLookedUp}/${totalPlanned}`);
        }
        // Stop conditions: nothing left, or we made zero progress this batch
        // (which would otherwise infinite-loop).
        if (remaining === 0) break;
        if ((body.looked_up || 0) === 0) break;
        // Hard safety cap.
        if (iteration > 500) break;
        // Briefly yield so UI repaints between batches.
        await new Promise(r => setTimeout(r, 50));
      }

      if (!libraryAvailable) {
        toast("phonenumbers library missing on server — pip install phonenumbers", "error");
        return;
      }

      const parts = [];
      if (totals.mobile)   parts.push(`📱 ${totals.mobile} mobile`);
      if (totals.landline) parts.push(`☎ ${totals.landline} landline`);
      if (totals.voip)     parts.push(`🖧 ${totals.voip} VoIP`);
      if (totals.tollfree) parts.push(`🆓 ${totals.tollfree} toll-free`);
      if (totals.unknown)  parts.push(`? ${totals.unknown} ambiguous`);
      if (totals.invalid)  parts.push(`✕ ${totals.invalid} invalid`);
      let msg = `Classified ${totalLookedUp} number${totalLookedUp === 1 ? "" : "s"}`;
      if (parts.length) msg += `: ${parts.join(", ")}`;
      if (totals.unknown) msg += ` — tap a ? badge to manually mark mobile vs landline`;
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      if (elapsed >= 30) msg += ` (${elapsed}s)`;
      toast(msg);
      await loadAll();
    } catch (err) {
      // Surface partial progress in the error so they can pick up where it stopped.
      const tail = totalLookedUp > 0
        ? ` (${totalLookedUp} already classified — click again to keep going)`
        : "";
      toast(err.message + tail, "error");
      await loadAll();  // refresh so partial progress is visible
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = original;
      }
    }
  }

  // Verify Mobiles — paid Twilio Lookup on the Mobile + Unknown subset.
  // Smart spend: skips Landline/VoIP/Tollfree (those tags are already reliable
  // from the free libphonenumber lookup; almost no business ports a landline
  // to a cell). Two-step UX: dry-run for cost preview, then real run.
  $("#verify-mobiles-btn")?.addEventListener("click", async () => {
    const btn = $("#verify-mobiles-btn");
    const original = btn.innerHTML;
    try {
      btn.disabled = true;
      btn.innerHTML = '<span class="btn-full">Checking…</span><span class="btn-short">…</span>';
      // Step 1: dry-run to count + estimate cost.
      const probe = await _safeFetchJson("/api/contacts/verify-mobiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dry_run: true }),
      });
      const n = probe.would_check;
      const cost = probe.estimated_cost_usd;
      if (!n) {
        toast("Nothing to verify — all contacts in this project are already classified as Landline / Toll-Free / Premium (where NPA-NXX is reliable).");
        return;
      }
      const ok = window.confirm(
        `Verify ${n} contact${n === 1 ? "" : "s"} (Mobile + Unknown) via Twilio?\n\n` +
        `Estimated cost: $${cost.toFixed(2)} ` +
        `(${n} × $0.005)\n\n` +
        `Twilio's real-time line-type data catches numbers that were ported ` +
        `from cell → business PBX. Landline/VoIP/Toll-free tags are skipped ` +
        `since they're already reliable.`
      );
      if (!ok) return;
      // Step 2: real run.
      btn.innerHTML = '<span class="btn-full">Verifying…</span><span class="btn-short">⏳</span>';
      const res = await _safeFetchJson("/api/contacts/verify-mobiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const parts = [];
      if (res.breakdown?.mobile)   parts.push(`📱 ${res.breakdown.mobile} mobile`);
      if (res.breakdown?.landline) parts.push(`☎ ${res.breakdown.landline} landline`);
      if (res.breakdown?.voip)     parts.push(`🖧 ${res.breakdown.voip} VoIP`);
      if (res.breakdown?.tollfree) parts.push(`🆓 ${res.breakdown.tollfree} toll-free`);
      if (res.breakdown?.unknown)  parts.push(`? ${res.breakdown.unknown} unknown`);
      let msg = `Verified ${res.checked} via Twilio`;
      if (parts.length) msg += `: ${parts.join(", ")}`;
      if (res.updated)  msg += ` · ${res.updated} re-tagged`;
      if (res.errors)   msg += ` · ${res.errors} errors`;
      msg += ` · cost $${res.estimated_cost_usd.toFixed(2)}`;
      toast(msg);
      await loadAll();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  });

  // Click a phone-type badge to cycle through manual classifications.
  // Order: ? → 📱 mobile → ☎ landline → 🖧 voip → ? (clear)
  const PHONE_TYPE_CYCLE = [null, "mobile", "landline", "voip"];
  document.body.addEventListener("click", async (e) => {
    const badge = e.target.closest(".phone-type.clickable");
    if (!badge) return;
    e.stopPropagation();
    const tr = badge.closest("tr[data-id]");
    if (!tr) return;
    const cid = Number(tr.dataset.id);
    const contact = state.contacts.find(c => c.id === cid);
    if (!contact) return;
    const cur = contact.phone_type || null;
    // If current type isn't in the cycle (e.g. tollfree, invalid), reset to ?
    let idx = PHONE_TYPE_CYCLE.indexOf(cur);
    if (idx < 0) idx = 0;
    const next = PHONE_TYPE_CYCLE[(idx + 1) % PHONE_TYPE_CYCLE.length];
    try {
      const res = await fetch(`/api/contacts/${cid}/phone-type`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone_type: next }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed.");
      contact.phone_type = next;
      // If user manually sets it, clear the auto-detected carrier label.
      contact.phone_carrier = null;
      renderContacts();
    } catch (err) {
      toast(err.message, "error");
    }
  });

  // ------- Row checkbox / select-all / bulk action bar -------
  // Both listeners use event delegation since the header is re-rendered
  // every time the contact view re-renders.
  document.body.addEventListener("change", (e) => {
    // Select-all in the header — toggles every visible row.
    if (e.target.id === "select-all-contacts") {
      const checked = e.target.checked;
      _visibleContacts.forEach(c => {
        if (checked) state.selectedContacts.add(c.id);
        else state.selectedContacts.delete(c.id);
      });
      $$("#contacts-table .row-select").forEach(cb => {
        const id = Number(cb.dataset.id);
        const want = state.selectedContacts.has(id);
        if (cb.checked !== want) cb.checked = want;
        cb.closest("tr[data-id]")?.classList.toggle("row-selected", want);
      });
      refreshSelectionUI();
      return;
    }
    // Per-row checkbox.
    const cb = e.target.closest(".row-select");
    if (!cb) return;
    const id = Number(cb.dataset.id);
    const tr = cb.closest("tr[data-id]");
    if (cb.checked) {
      state.selectedContacts.add(id);
      tr?.classList.add("row-selected");
    } else {
      state.selectedContacts.delete(id);
      tr?.classList.remove("row-selected");
    }
    refreshSelectionUI();
  });

  // Bulk action bar — actions apply ONLY to selected contacts.
  $("#selection-bar")?.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-bulk]");
    if (!btn) return;
    const action = btn.dataset.bulk;
    const ids = [...state.selectedContacts];
    if (action !== "clear" && ids.length === 0) {
      toast("No contacts selected.", "error");
      return;
    }
    if (action === "clear") {
      clearSelection();
      return;
    }
    if (action === "pipeline") {
      await bulkActionPipeline(ids);
    } else if (action === "classify") {
      await bulkActionClassify(ids);
    } else if (action === "move-list") {
      await bulkActionMoveList(ids);
    } else if (action === "delete") {
      await bulkActionDelete(ids);
    }
    // (Power Dial moved out of bulk actions — now a sidebar section at
    //  view-powerdialer with a list picker. Cleaner one-entry-point UX.)
  });

  // -------- Companies bulk-select + bulk-delete --------
  document.body.addEventListener("change", (e) => {
    // Select-all in the Companies header.
    if (e.target.id === "select-all-companies") {
      const checked = e.target.checked;
      _visibleCompanies.forEach(c => {
        if (checked) state.selectedCompanies.add(c.id);
        else state.selectedCompanies.delete(c.id);
      });
      $$("#companies-table .co-row-select").forEach(cb => {
        const id = Number(cb.dataset.id);
        const want = state.selectedCompanies.has(id);
        if (cb.checked !== want) cb.checked = want;
        cb.closest("tr[data-id]")?.classList.toggle("row-selected", want);
      });
      refreshCompaniesSelectionUI();
      return;
    }
    // Per-row company checkbox.
    const cb = e.target.closest("#companies-table .co-row-select");
    if (!cb) return;
    const id = Number(cb.dataset.id);
    const tr = cb.closest("tr[data-id]");
    if (cb.checked) {
      state.selectedCompanies.add(id);
      tr?.classList.add("row-selected");
    } else {
      state.selectedCompanies.delete(id);
      tr?.classList.remove("row-selected");
    }
    refreshCompaniesSelectionUI();
  });

  // Companies bulk-action bar.
  $("#companies-selection-bar")?.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-co-bulk]");
    if (!btn) return;
    const action = btn.dataset.coBulk;
    const ids = [...state.selectedCompanies];
    if (action === "clear") { clearCompaniesSelection(); return; }
    if (ids.length === 0) { toast("No companies selected.", "error"); return; }
    if (action === "delete") {
      const word = window.prompt(
        `Permanently delete ${ids.length} compan${ids.length === 1 ? "y" : "ies"}? ` +
        `Their contacts will keep their data but lose the company link. ` +
        `\n\nType DELETE to confirm.`
      );
      if (word !== "DELETE") {
        if (word != null) toast("Cancelled — must type DELETE in caps.", "info");
        return;
      }
      try {
        const res = await fetch("/api/companies/bulk-delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || "Delete failed.");
        toast(`Deleted ${body.deleted} compan${body.deleted === 1 ? "y" : "ies"}`);
        state.selectedCompanies.clear();
        await loadAll();
      } catch (err) {
        toast(err.message, "error");
      }
    }
  });

  async function bulkActionPipeline(ids) {
    const services = state.meta.services || [];
    const service = window.prompt(
      `Create a Lead-stage deal for each of the ${ids.length} selected contact${ids.length === 1 ? "" : "s"}.\n\n` +
      `Service for these deals (one of: ${services.join(", ")}):`,
      services[0] || "Web Design",
    );
    if (service === null) return;
    const valueStr = window.prompt("Default deal value in dollars (0 if you don't know yet):", "0");
    if (valueStr === null) return;
    try {
      const res = await fetch("/api/contacts/bulk-pipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contact_ids: ids,
          service: service.trim(),
          value: Number(valueStr) || 0,
          stage: "Lead",
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed.");
      const msg = `Created ${body.created} deal${body.created === 1 ? "" : "s"}` +
        (body.skipped ? `, skipped ${body.skipped} (already in pipeline)` : "");
      toast(msg);
      clearSelection();
      await loadAll();
    } catch (err) { toast(err.message, "error"); }
  }

  async function bulkActionClassify(ids) {
    const choice = window.prompt(
      `Mark the ${ids.length} selected contact${ids.length === 1 ? "" : "s"} as which line type?\n\n` +
      `  m — 📱 Mobile\n  l — ☎ Landline\n  v — 🖧 VoIP\n  t — 🆓 Toll-free\n  c — Clear`,
      "m"
    );
    if (choice === null) return;
    const map = { m: "mobile", l: "landline", v: "voip", t: "tollfree", c: null };
    const c = (choice || "").trim().toLowerCase();
    if (!(c in map)) { toast("Unknown choice.", "error"); return; }
    const phone_type = map[c];
    try {
      const res = await fetch("/api/contacts/bulk-classify-phone-type", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_ids: ids, phone_type }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed.");
      toast(`Marked ${body.updated} contact${body.updated === 1 ? "" : "s"} as ${phone_type || "unclassified"}.`);
      clearSelection();
      await loadAll();
    } catch (err) { toast(err.message, "error"); }
  }

  async function bulkActionMoveList(ids) {
    const existing = [...new Set(state.contacts.map(c => contactList(c)))].sort();
    const target = window.prompt(
      `Move ${ids.length} contact${ids.length === 1 ? "" : "s"} to which list?\n\n` +
      `Existing lists: ${existing.join(", ") || "(none yet)"}\n\n` +
      `Type a list name (new or existing):`,
      "Hot Leads"
    );
    if (target === null) return;
    const list_name = target.trim();
    if (!list_name) { toast("List name can't be empty.", "error"); return; }
    try {
      const res = await fetch("/api/contacts/bulk-move-list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_ids: ids, list_name }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed.");
      toast(`Moved ${body.updated} contact${body.updated === 1 ? "" : "s"} to "${list_name}".`);
      clearSelection();
      await loadAll();
    } catch (err) { toast(err.message, "error"); }
  }

  async function bulkActionDelete(ids) {
    const ok = window.confirm(
      `Permanently delete ${ids.length} contact${ids.length === 1 ? "" : "s"}?\n\n` +
      `This also removes their deals and activities. This can't be undone.`
    );
    if (!ok) return;
    try {
      const res = await fetch("/api/contacts/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_ids: ids }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed.");
      toast(`Deleted ${body.deleted} contact${body.deleted === 1 ? "" : "s"}.`);
      clearSelection();
      await loadAll();
    } catch (err) { toast(err.message, "error"); }
  }

  $("#import-btn").addEventListener("click", () => $("#import-file").click());
  $("#import-file").addEventListener("change", async (e) => {
    await uploadContactsCSV(e.target.files[0]);
    e.target.value = "";
  });

  // Drag-and-drop CSV onto the Contacts view (works even if the OS file
  // picker is broken — drag a file from Finder onto the page).
  const contactsView = $("#view-contacts");
  if (contactsView) {
    ["dragenter", "dragover"].forEach(evt => {
      contactsView.addEventListener(evt, (e) => {
        if (state.view !== "contacts") return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        contactsView.classList.add("drop-active");
      });
    });
    contactsView.addEventListener("dragleave", (e) => {
      // Only remove highlight when leaving the view itself, not a child.
      if (e.target === contactsView) {
        contactsView.classList.remove("drop-active");
      }
    });
    contactsView.addEventListener("drop", async (e) => {
      e.preventDefault();
      contactsView.classList.remove("drop-active");
      if (state.view !== "contacts") return;
      const files = [...(e.dataTransfer?.files || [])];
      const csv = files.find(f =>
        f.name.toLowerCase().endsWith(".csv") || f.type === "text/csv"
      );
      if (!csv) {
        toast("Drop a .csv file to import contacts", "error");
        return;
      }
      await uploadContactsCSV(csv);
    });
    // Prevent the browser from navigating to the file when dropped outside
    // the drop zone (default behavior opens the file in a new tab).
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => e.preventDefault());
  }

  // ------- Settings form handlers -------
  $("#profile-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const res = await fetch("/api/me", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          first_name: $("#s-first").value,
          last_name: $("#s-last").value,
          email: $("#s-email").value,
          phone: $("#s-phone").value,
          username: $("#s-username").value,
          // country is no longer set from Settings — the Lead Generator's
          // own dropdown sets it and the search endpoint persists it.
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Save failed.");
      toast("Profile saved");
      const nameEl = $("#user-name");
      if (nameEl) nameEl.textContent = body.username;
    } catch (err) {
      toast(err.message, "error");
    }
  });

  // -------- Support form --------
  $("#support-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const subject = $("#support-subject").value.trim();
    const message = $("#support-message").value.trim();
    if (!message) {
      toast("Please type a message before sending.", "error");
      return;
    }
    const btn = $("#support-submit");
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = "Sending…";
    try {
      const res = await fetch("/api/support/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, message }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Couldn't send your message.");
      toast("Message sent — We will get back to you soon.");
      $("#support-subject").value = "";
      $("#support-message").value = "";
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  $("#password-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const newPw = $("#s-new-pw").value;
    const confirmPw = $("#s-confirm-pw").value;
    if (newPw !== confirmPw) {
      toast("New passwords don't match.", "error");
      return;
    }
    try {
      const res = await fetch("/api/me/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          current_password: $("#s-current-pw").value,
          new_password: newPw,
          confirm_password: confirmPw,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Password change failed.");
      toast("Password updated");
      $("#s-current-pw").value = "";
      $("#s-new-pw").value = "";
      $("#s-confirm-pw").value = "";
    } catch (err) {
      toast(err.message, "error");
    }
  });

  // ------- Free Game (VelosiRunner) -------
  // Chrome-style "no internet" dino game, retheme'd to Velosify colors.
  // Starts when the user opens the Free Game view, stops on view change.
  const FreeGame = (function () {
    let canvas = null, ctx = null;
    let raf = 0;
    let started = false;
    let running = false;
    let gameOver = false;
    let lastFrame = 0;
    let speed = 6;             // px/frame at 60fps; ramps up over time
    const GROUND_Y = 180;      // ground line (px from top) inside 800x220 canvas
    const GRAVITY = 0.7;
    let score = 0;
    let hi = parseInt(localStorage.getItem("velosify_runner_hi") || "0", 10) || 0;
    let lastMilestoneSounded = 0;  // most recent score multiple of 100 that got a chime
    let frame = 0;             // frame counter for animation
    const dino = { x: 60, y: GROUND_Y - 44, w: 44, h: 44, vy: 0, ducking: false, jumpQueued: false };
    let obstacles = [];        // {x, w, h, type: 'cactus'|'cactus2'|'bird'}
    let clouds = [];           // bg clouds
    let nextObstacleIn = 60;   // frames until next spawn
    let stars = [];
    // ---- audio ----
    let audioCtx = null;
    let muted = false;
    try { muted = localStorage.getItem("runner-muted") === "1"; } catch {}
    function ensureAudio() {
      if (muted) return;
      if (!audioCtx) {
        try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
      }
      if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    }
    // Tiny WebAudio synth — single oscillator with attack/decay envelope.
    function tone(freq, duration, type, gain) {
      if (muted || !audioCtx) return;
      const osc = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      osc.type = type || "sine";
      osc.frequency.value = freq;
      g.gain.value = 0;
      const now = audioCtx.currentTime;
      g.gain.linearRampToValueAtTime(gain ?? 0.10, now + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, now + duration);
      osc.connect(g).connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now + duration + 0.02);
    }
    function toggleMute() {
      muted = !muted;
      try { localStorage.setItem("runner-muted", muted ? "1" : "0"); } catch {}
      const btn = document.getElementById("runner-mute");
      if (btn) btn.textContent = muted ? "🔇" : "🔊";
      if (!muted) ensureAudio();
    }

    function init() {
      canvas = document.getElementById("freegame-canvas");
      if (!canvas) return false;
      ctx = canvas.getContext("2d");
      // Scatter some background stars matching the Velosify nebula vibe.
      stars = [];
      for (let i = 0; i < 28; i++) {
        stars.push({
          x: Math.random() * canvas.width,
          y: Math.random() * (GROUND_Y - 20),
          r: Math.random() * 1.2 + 0.3,
          tw: Math.random() * Math.PI * 2,
        });
      }
      clouds = [
        { x: 600, y: 40, speed: 0.4 },
        { x: 320, y: 70, speed: 0.25 },
      ];
      bindKeys();
      // Wire the mute button (idempotent — clones the node so repeated init
      // calls don't stack listeners).
      const muteBtn = document.getElementById("runner-mute");
      if (muteBtn) {
        muteBtn.textContent = muted ? "🔇" : "🔊";
        const fresh = muteBtn.cloneNode(true);
        muteBtn.parentNode.replaceChild(fresh, muteBtn);
        fresh.addEventListener("click", toggleMute);
      }
      draw();        // paint the idle frame
      updateScores();
      showOverlay("VelosiRunner", "Press Space to start");
      return true;
    }

    function bindKeys() {
      // Idempotent — replace handler on each start.
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      document.addEventListener("keydown", onKeyDown);
      document.addEventListener("keyup", onKeyUp);
      // Tap-to-jump on mobile.
      canvas.addEventListener("click", onTap);
      canvas.addEventListener("touchstart", onTap, { passive: true });
    }

    function onKeyDown(e) {
      if (state.view !== "freegame") return;
      if (state.gameMode !== "runner") return;
      if (e.code === "Space" || e.code === "ArrowUp") {
        e.preventDefault();
        if (!started || gameOver) restart();
        else if (dino.y >= GROUND_Y - dino.h) {
          dino.vy = -12.5;       // jump impulse
          dino.jumpQueued = false;
          tone(660, 0.10, "triangle", 0.08);
        }
      } else if (e.code === "ArrowDown") {
        e.preventDefault();
        if (started && !gameOver) dino.ducking = true;
      }
    }
    function onKeyUp(e) {
      if (e.code === "ArrowDown") dino.ducking = false;
    }
    function onTap() {
      if (state.view !== "freegame") return;
      if (!started || gameOver) restart();
      else if (dino.y >= GROUND_Y - dino.h) {
        dino.vy = -12.5;
        tone(660, 0.10, "triangle", 0.08);
      }
    }

    function showOverlay(title, sub) {
      const ov = document.getElementById("freegame-overlay");
      const t = document.getElementById("freegame-overlay-title");
      const s = document.getElementById("freegame-overlay-sub");
      if (t) t.textContent = title;
      if (s) s.textContent = sub;
      if (ov) ov.classList.remove("hidden");
    }
    function hideOverlay() {
      document.getElementById("freegame-overlay")?.classList.add("hidden");
    }

    function restart() {
      score = 0;
      lastMilestoneSounded = 0;
      speed = 6;
      frame = 0;
      obstacles = [];
      nextObstacleIn = 50;
      dino.y = GROUND_Y - dino.h;
      dino.vy = 0;
      dino.ducking = false;
      gameOver = false;
      started = true;
      running = true;
      hideOverlay();
      ensureAudio();                // create/resume on first user gesture
      // Two-note "start" chord.
      tone(523, 0.12, "triangle", 0.08);
      setTimeout(() => tone(784, 0.14, "triangle", 0.08), 80);
      lastFrame = performance.now();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(loop);
    }

    function loop(ts) {
      if (state.view !== "freegame") { running = false; return; }
      const dt = Math.min(60, ts - lastFrame);
      lastFrame = ts;
      // Step at a fixed ~16.67ms; if dt is much higher (tab inactive),
      // clamp so we don't teleport.
      const steps = Math.max(1, Math.round(dt / 16.67));
      for (let i = 0; i < steps && !gameOver; i++) step();
      draw();
      if (running && !gameOver) raf = requestAnimationFrame(loop);
      else if (gameOver) {
        const beatLocalHi = score > hi;
        if (beatLocalHi) {
          hi = score;
          localStorage.setItem("velosify_runner_hi", String(hi));
        }
        updateScores();
        showOverlay("Game over", `Score ${pad(score)} · High ${pad(hi)} · Press Space to retry`);
        // Submit the score; the server only persists if it's a new
        // server-side high. Refresh the leaderboard either way so the user
        // sees the freshest standings immediately after a run.
        submitScore(score).finally(() => loadLeaderboard());
      }
    }

    function step() {
      frame++;
      // Score: 1 point per ~6 frames (tunes feel). Update the on-screen
      // counter live so the user can see how close they are to their high
      // score mid-run.
      if (frame % 6 === 0) {
        score++;
        updateScores();
        // Tiny celebratory chime every 100 points.
        if (score > 0 && score % 100 === 0 && score !== lastMilestoneSounded) {
          lastMilestoneSounded = score;
          tone(880, 0.08, "triangle", 0.08);
          setTimeout(() => tone(1175, 0.10, "triangle", 0.08), 60);
        }
      }
      // Speed ramps up gently with score.
      speed = 6 + Math.min(8, score / 120);

      // Dino physics.
      dino.vy += GRAVITY;
      dino.y += dino.vy;
      if (dino.y >= GROUND_Y - dino.h) {
        dino.y = GROUND_Y - dino.h;
        dino.vy = 0;
      }

      // Spawn obstacles.
      nextObstacleIn--;
      if (nextObstacleIn <= 0) {
        spawnObstacle();
        // Random spacing scales with speed so cacti come faster as you go.
        nextObstacleIn = Math.max(30, Math.floor(70 - speed * 2 + Math.random() * 50));
      }

      // Move obstacles + cull off-screen.
      for (const o of obstacles) o.x -= speed;
      obstacles = obstacles.filter(o => o.x + o.w > -10);

      // Move clouds slowly.
      for (const c of clouds) {
        c.x -= c.speed;
        if (c.x < -60) { c.x = canvas.width + 30; c.y = 30 + Math.random() * 60; }
      }

      // Collision.
      const dHitbox = dinoHitbox();
      for (const o of obstacles) {
        if (rectIntersect(dHitbox, o)) {
          gameOver = true;
          running = false;
          // Falling sawtooth "you died" sound.
          tone(220, 0.30, "sawtooth", 0.12);
          setTimeout(() => tone(165, 0.40, "sawtooth", 0.10), 120);
          return;
        }
      }
    }

    function dinoHitbox() {
      const h = dino.ducking ? 26 : dino.h;
      const y = dino.y + (dino.h - h);
      return { x: dino.x + 4, y: y + 2, w: dino.w - 8, h: h - 4 };
    }

    function spawnObstacle() {
      const r = Math.random();
      if (score > 200 && r < 0.2) {
        // Pterodactyl-style flyer at random height.
        const y = GROUND_Y - 60 - Math.random() * 30;
        obstacles.push({ x: canvas.width + 20, y, w: 36, h: 22, type: "bird", flap: 0 });
      } else if (r < 0.45) {
        obstacles.push({ x: canvas.width + 20, y: GROUND_Y - 36, w: 18, h: 36, type: "cactus" });
      } else if (r < 0.75) {
        obstacles.push({ x: canvas.width + 20, y: GROUND_Y - 50, w: 24, h: 50, type: "cactusBig" });
      } else {
        obstacles.push({ x: canvas.width + 20, y: GROUND_Y - 36, w: 36, h: 36, type: "cactusGroup" });
      }
    }

    function rectIntersect(a, b) {
      return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    }

    // Format scores with thousands separators (e.g. 1,455). Used everywhere
    // the dino game prints a number — keep the name `pad` since it's called
    // by both the live counter and the leaderboard.
    function pad(n) {
      return Number(n || 0).toLocaleString("en-US");
    }

    function updateScores() {
      const s = document.getElementById("freegame-score");
      const h = document.getElementById("freegame-hi");
      if (s) {
        s.textContent = pad(score);
        // Light up the live score as it gets close to / passes the
        // current high score so the player feels the chase.
        s.classList.toggle("freegame-score-near", hi > 0 && score >= hi - 30 && score < hi);
        s.classList.toggle("freegame-score-beat", hi > 0 && score >= hi);
      }
      if (h) h.textContent = pad(hi);
    }

    // ---------- Drawing ----------
    function draw() {
      if (!ctx) return;
      const W = canvas.width, H = canvas.height;
      // Background gradient (dark Velosify).
      const grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, "#0a0a18");
      grad.addColorStop(1, "#1a0c2e");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);

      // Stars (twinkle).
      for (const st of stars) {
        st.tw += 0.04;
        const a = 0.4 + Math.sin(st.tw) * 0.3;
        ctx.fillStyle = `rgba(233, 213, 255, ${a.toFixed(2)})`;
        ctx.beginPath();
        ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2);
        ctx.fill();
      }

      // Clouds.
      ctx.fillStyle = "rgba(192, 132, 252, 0.18)";
      for (const c of clouds) {
        drawCloud(c.x, c.y);
      }

      // Ground (neon line w/ subtle glow).
      ctx.strokeStyle = "rgba(192, 132, 252, 0.85)";
      ctx.lineWidth = 1.6;
      ctx.shadowColor = "rgba(192, 132, 252, 0.7)";
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.moveTo(0, GROUND_Y + 2);
      ctx.lineTo(W, GROUND_Y + 2);
      ctx.stroke();
      // Ground "speckles" scrolling with the world.
      ctx.fillStyle = "rgba(192, 132, 252, 0.55)";
      const offset = (frame * speed) % 30;
      for (let x = -offset; x < W; x += 30) {
        ctx.fillRect(x, GROUND_Y + 8, 6, 1);
        ctx.fillRect(x + 14, GROUND_Y + 12, 3, 1);
      }
      ctx.shadowBlur = 0;

      // Obstacles.
      for (const o of obstacles) drawObstacle(o);

      // Dino (lightning bolt avatar fits Velosify, but a classic dino reads
      // better — we'll go with a chunky neon dino silhouette).
      drawDino();
    }

    function drawCloud(x, y) {
      ctx.beginPath();
      ctx.ellipse(x, y, 18, 6, 0, 0, Math.PI * 2);
      ctx.ellipse(x + 14, y - 3, 14, 6, 0, 0, Math.PI * 2);
      ctx.ellipse(x + 26, y, 16, 6, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    function drawDino() {
      const x = dino.x, y = dino.y;
      ctx.save();
      ctx.shadowColor = "rgba(240, 171, 252, 0.8)";
      ctx.shadowBlur = 8;
      ctx.fillStyle = "#f0abfc";
      const grounded = dino.y >= GROUND_Y - dino.h;
      const legPhase = Math.floor(frame / 5) % 2;

      if (dino.ducking) {
        // ----- Crouching pose -----
        // Lower stance, body stretched horizontally so the dino reads as
        // "ducking under something" instead of "shrunk."
        const duckH = 26;
        const yOffset = dino.h - duckH;     // 18
        const bx = x, by = y + yOffset;
        // Long body: tail to head, lower stripe
        ctx.fillRect(bx, by + 6, 44, 12);
        // Head bumped slightly above the body at the front
        ctx.fillRect(bx + 28, by + 2, 18, 10);
        // Snout sticks out further forward
        ctx.fillRect(bx + 42, by + 5, 6, 7);
        // Tail tip
        ctx.fillRect(bx - 2, by + 9, 4, 6);
        // Two distinct stubby legs underneath, with a running cycle
        const legTop = by + 18;
        const legW = 5, footW = 7, footH = 3;
        const leftLegX = bx + 14;
        const rightLegX = bx + 26;
        if (legPhase === 0) {
          ctx.fillRect(leftLegX, legTop, legW, 8);
          ctx.fillRect(leftLegX, legTop + 5, footW, footH);
          ctx.fillRect(rightLegX, legTop, legW, 5);
          ctx.fillRect(rightLegX, legTop + 2, footW, footH);
        } else {
          ctx.fillRect(leftLegX, legTop, legW, 5);
          ctx.fillRect(leftLegX, legTop + 2, footW, footH);
          ctx.fillRect(rightLegX, legTop, legW, 8);
          ctx.fillRect(rightLegX, legTop + 5, footW, footH);
        }
        // Eye on the head
        ctx.shadowBlur = 0;
        ctx.fillStyle = "#0a0a18";
        ctx.fillRect(bx + 40, by + 5, 3, 3);
        ctx.restore();
        return;
      }

      // ----- Standing pose -----
      const h = dino.h;
      const bx = x, by = y;
      // Body — stops 12px above the bottom so the legs sit BELOW the
      // body and read as separate appendages (not just stubs).
      const bodyBottom = by + h - 12;
      ctx.fillRect(bx + 8, by + 14, 28, bodyBottom - (by + 14));
      // Head
      ctx.fillRect(bx + 22, by, 22, 22);
      // Snout
      ctx.fillRect(bx + 38, by + 4, 8, 12);
      // Tail
      ctx.fillRect(bx, by + 18, 12, 8);

      // Legs — separate left + right legs with a clear gap and a
      // horizontal foot so the running gait is readable.
      const legTop = bodyBottom;
      const legW = 5;
      const legFullH = 12;
      const legLiftH = 7;
      const footW = 8;
      const footH = 3;
      const leftLegX = bx + 12;
      const rightLegX = bx + 24;
      if (grounded) {
        if (legPhase === 0) {
          ctx.fillRect(leftLegX, legTop, legW, legFullH);
          ctx.fillRect(leftLegX, legTop + legFullH - footH, footW, footH);
          ctx.fillRect(rightLegX, legTop, legW, legLiftH);
          ctx.fillRect(rightLegX, legTop + legLiftH - footH, footW, footH);
        } else {
          ctx.fillRect(leftLegX, legTop, legW, legLiftH);
          ctx.fillRect(leftLegX, legTop + legLiftH - footH, footW, footH);
          ctx.fillRect(rightLegX, legTop, legW, legFullH);
          ctx.fillRect(rightLegX, legTop + legFullH - footH, footW, footH);
        }
      } else {
        // Jumping — both legs tucked, slightly forward
        ctx.fillRect(leftLegX, legTop, legW, 8);
        ctx.fillRect(leftLegX, legTop + 5, footW, footH);
        ctx.fillRect(rightLegX, legTop, legW, 8);
        ctx.fillRect(rightLegX, legTop + 5, footW, footH);
      }
      // Eye
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#0a0a18";
      ctx.fillRect(bx + 36, by + 4, 3, 3);
      ctx.restore();
    }

    function drawObstacle(o) {
      ctx.save();
      ctx.shadowColor = "rgba(34, 211, 238, 0.6)";
      ctx.shadowBlur = 6;
      ctx.fillStyle = "#22d3ee";
      if (o.type === "bird") {
        o.flap = (o.flap || 0) + 0.18;
        const up = Math.sin(o.flap) > 0;
        // Body
        ctx.fillRect(o.x + 8, o.y + 8, 22, 6);
        // Beak
        ctx.fillRect(o.x + 28, o.y + 10, 6, 3);
        // Wings
        if (up) {
          ctx.fillRect(o.x + 12, o.y, 14, 6);
        } else {
          ctx.fillRect(o.x + 12, o.y + 14, 14, 6);
        }
      } else if (o.type === "cactus") {
        ctx.fillRect(o.x + 6, o.y, 6, o.h);
        ctx.fillRect(o.x, o.y + 8, 4, 14);
        ctx.fillRect(o.x + 14, o.y + 4, 4, 12);
      } else if (o.type === "cactusBig") {
        ctx.fillRect(o.x + 8, o.y, 8, o.h);
        ctx.fillRect(o.x, o.y + 12, 6, 18);
        ctx.fillRect(o.x + 18, o.y + 6, 6, 16);
      } else if (o.type === "cactusGroup") {
        ctx.fillRect(o.x + 4, o.y + 4, 6, o.h - 4);
        ctx.fillRect(o.x + 14, o.y, 6, o.h);
        ctx.fillRect(o.x + 24, o.y + 6, 6, o.h - 6);
      }
      ctx.restore();
    }

    function start() {
      if (!init()) return;
      // Just initialize; actual game waits for Space (so the user has time
      // to read the overlay).
      running = false;
      gameOver = false;
      started = false;
      cancelAnimationFrame(raf);
      draw();
      loadLeaderboard();
      // Bind the "refresh" button (idempotent — replace handler each time).
      const refreshBtn = document.getElementById("freegame-refresh");
      if (refreshBtn) {
        refreshBtn.onclick = () => loadLeaderboard();
      }
    }
    function stop() {
      running = false;
      cancelAnimationFrame(raf);
    }

    async function submitScore(s) {
      if (!s || s <= 0) return null;
      try {
        const res = await fetch("/api/freegame/score", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ score: s }),
        });
        if (!res.ok) return null;
        const j = await res.json();
        // If we improved the *server* high score, also bump the local hi
        // (it might already be ≥ ours from a different device).
        if (j && typeof j.high_score === "number" && j.high_score > hi) {
          hi = j.high_score;
          localStorage.setItem("velosify_runner_hi", String(hi));
          updateScores();
        }
        return j;
      } catch {
        return null;
      }
    }

    async function loadLeaderboard() {
      const body = document.getElementById("freegame-leaderboard-body");
      if (!body) return;
      try {
        const res = await fetch("/api/freegame/leaderboard");
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        const rows = [...(data.leaders || [])];
        // If the user isn't in the top N, append a divider + their row so
        // they can always see where they stand.
        let appendMe = data.me && !rows.some(r => r.is_me);
        body.innerHTML = "";
        if (rows.length === 0) {
          body.innerHTML = '<tr><td colspan="4" class="freegame-empty">No scores yet — be the first.</td></tr>';
          return;
        }
        const frag = document.createDocumentFragment();
        for (const r of rows) frag.appendChild(buildRow(r));
        if (appendMe) {
          const sep = document.createElement("tr");
          sep.className = "freegame-leaderboard-sep";
          sep.innerHTML = '<td colspan="4">…</td>';
          frag.appendChild(sep);
          frag.appendChild(buildRow(data.me));
        }
        body.appendChild(frag);
      } catch (err) {
        body.innerHTML = '<tr><td colspan="4" class="freegame-empty">Couldn\'t load leaderboard.</td></tr>';
      }
    }

    function buildRow(r) {
      const tr = document.createElement("tr");
      if (r.is_me) tr.classList.add("freegame-me-row");
      const rankCell = document.createElement("td");
      rankCell.className = "rank-col";
      // Medal for top 3, plain number after.
      const medals = { 1: "🥇", 2: "🥈", 3: "🥉" };
      rankCell.textContent = medals[r.rank] || `#${r.rank}`;
      tr.appendChild(rankCell);
      const player = document.createElement("td");
      const name = r.username || r.display_name;
      player.innerHTML = r.is_me
        ? `<strong>${escapeHtml(name)}</strong> <span class="freegame-you">you</span>`
        : escapeHtml(name);
      tr.appendChild(player);
      const score = document.createElement("td");
      score.className = "score-col";
      score.textContent = pad(r.score);
      tr.appendChild(score);
      const when = document.createElement("td");
      when.className = "when-col";
      when.textContent = formatWhen(r.achieved_at);
      tr.appendChild(when);
      return tr;
    }

    function escapeHtml(s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    function formatWhen(iso) {
      if (!iso) return "—";
      const d = new Date(iso);
      if (isNaN(d)) return "—";
      const diffMs = Date.now() - d.getTime();
      const diffMin = Math.round(diffMs / 60000);
      if (diffMin < 1) return "just now";
      if (diffMin < 60) return diffMin + "m ago";
      const diffHr = Math.round(diffMin / 60);
      if (diffHr < 24) return diffHr + "h ago";
      const diffDay = Math.round(diffHr / 24);
      if (diffDay < 30) return diffDay + "d ago";
      return d.toLocaleDateString();
    }

    return { start, stop };
  })();


  // -------- Velosify Blackjack — 10-hand session vs. dealer --------
  // Vegas Strip rules: 6-deck shoe, blackjack pays 3:2, dealer stands on
  // soft 17, double on any two, split once (any pair), surrender allowed.
  // Insurance offered when dealer shows an Ace.
  const BlackjackGame = (function () {
    const SUITS = ["♠", "♥", "♦", "♣"];
    const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
    const STARTING_BANKROLL = 10000;
    const HANDS_PER_SESSION = 10;
    const BEST_KEY = "velosify.blackjack.best";

    // ---- DOM refs (resolved on start()) ----
    let els = {};
    let bound = false;

    // ---- Game state ----
    let shoe = [];
    let bankroll = STARTING_BANKROLL;
    let handNumber = 1;
    let currentBet = 0;
    let playerHands = [];      // [{cards, bet, doubled, surrendered, done, blackjack}]
    let activeHandIdx = 0;
    let dealerHand = [];
    let dealerHoleHidden = true;
    let phase = "betting";     // "betting" | "playing" | "insurance" | "dealer" | "result" | "session-end"
    let insuranceBet = 0;
    let sessionDone = false;

    function fmt(n) { return "$" + Math.round(n).toLocaleString(); }
    function rankValue(r) {
      if (r === "A") return 11;
      if (r === "K" || r === "Q" || r === "J" || r === "10") return 10;
      return parseInt(r, 10);
    }
    function buildShoe() {
      const cards = [];
      for (let d = 0; d < 6; d++) {
        for (const s of SUITS) for (const r of RANKS) cards.push({ rank: r, suit: s });
      }
      // Fisher-Yates shuffle
      for (let i = cards.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [cards[i], cards[j]] = [cards[j], cards[i]];
      }
      return cards;
    }
    function dealCard() {
      // Auto-reshuffle when the shoe runs low (deep into a 10-hand session this
      // is extremely unlikely with 312 cards, but defensive is cheap).
      if (shoe.length < 20) shoe = buildShoe();
      return shoe.pop();
    }
    function handValue(cards) {
      let total = 0, aces = 0;
      for (const c of cards) {
        total += rankValue(c.rank);
        if (c.rank === "A") aces++;
      }
      while (total > 21 && aces > 0) { total -= 10; aces--; }
      return total;
    }
    function isSoft(cards) {
      let total = 0, aces = 0;
      for (const c of cards) {
        total += rankValue(c.rank);
        if (c.rank === "A") aces++;
      }
      while (total > 21 && aces > 0) { total -= 10; aces--; }
      // Soft = there's still an ace counted as 11.
      return aces > 0 && total <= 21 && cards.some(c => c.rank === "A");
    }
    function isBlackjack(cards) { return cards.length === 2 && handValue(cards) === 21; }
    function isBust(cards) { return handValue(cards) > 21; }

    function loadBest() {
      try {
        const v = parseInt(localStorage.getItem(BEST_KEY) || "0", 10);
        return isFinite(v) && v > 0 ? v : STARTING_BANKROLL;
      } catch { return STARTING_BANKROLL; }
    }
    function saveBest(v) {
      try { localStorage.setItem(BEST_KEY, String(v)); } catch {}
    }

    // ---- Rendering ----
    function cardHTML(c, faceDown) {
      if (faceDown) return `<div class="bj-card-face bj-card-back" aria-label="Face-down card"></div>`;
      const red = (c.suit === "♥" || c.suit === "♦");
      return `<div class="bj-card-face ${red ? "bj-card-red" : "bj-card-black"}">
        <div class="bj-card-corner bj-card-tl">${c.rank}<span>${c.suit}</span></div>
        <div class="bj-card-suit">${c.suit}</div>
        <div class="bj-card-corner bj-card-br">${c.rank}<span>${c.suit}</span></div>
      </div>`;
    }
    // True while the bankroll number is counting up post-hand. render()
    // skips writing the bankroll text during this window so the animation
    // can drive it directly.
    let bankrollAnimating = false;
    function animateBankroll(from, to) {
      if (!els.bankroll) return;
      bankrollAnimating = true;
      els.bankroll.classList.add("bj-bankroll-rising");
      const startTime = performance.now();
      const duration = 650;
      function frame(now) {
        const t = Math.min(1, (now - startTime) / duration);
        const eased = 1 - Math.pow(1 - t, 3);
        const v = Math.round(from + (to - from) * eased);
        els.bankroll.textContent = fmt(v);
        if (t < 1) {
          requestAnimationFrame(frame);
        } else {
          els.bankroll.textContent = fmt(to);
          els.bankroll.classList.remove("bj-bankroll-rising");
          bankrollAnimating = false;
        }
      }
      requestAnimationFrame(frame);
    }
    // When true, render() does NOT recreate card DOM elements. Used during
    // animated dealing/hitting/dealer-turn flows where each card is appended
    // incrementally so existing CSS animations don't re-fire on re-renders.
    // The .bj-hand wrapper classes and totals still get refreshed via
    // refreshHandsMeta() in those phases.
    let cardsLocked = false;
    function classesForHand(h, i) {
      return "bj-hand" + (i === activeHandIdx && phase === "playing" ? " active" : "")
                       + (h.surrendered ? " surrendered" : "")
                       + (isBust(h.cards) ? " bust" : "")
                       + (h.result === "win" ? " win" : "")
                       + (h.result === "lose" ? " lose" : "")
                       + (h.result === "push" ? " push" : "");
    }
    function metaTextForHand(h) {
      return `Bet ${fmt(h.bet)}${h.cards.length ? ` · ${handValue(h.cards)}` : ""}${h.result ? ` · ${h.result.toUpperCase()}` : ""}`;
    }
    // Rebuild dealer + player cards from the current data model. Used on
    // fresh state (newSession, between hands) and explicit relocks.
    function rebuildAllCards() {
      // Dealer cards: index 0 is the HOLE card (face down while hidden),
      // index 1 is the up card. Match the dealing order.
      const dShow = dealerHand.map((c, i) => cardHTML(c, dealerHoleHidden && i === 0));
      els.dealerCards.innerHTML = dShow.join("");
      els.playerHands.innerHTML = "";
      playerHands.forEach((h, i) => {
        const wrap = document.createElement("div");
        wrap.className = classesForHand(h, i);
        wrap.innerHTML = `
          <div class="bj-hand-cards">${h.cards.map(c => cardHTML(c, false)).join("")}</div>
          <div class="bj-hand-meta">${metaTextForHand(h)}</div>
        `;
        els.playerHands.appendChild(wrap);
      });
    }
    // Refresh only the meta state on existing hand wrappers (classes +
    // total text). Used when cards are locked — bets/results change
    // but the card DOM has been managed incrementally.
    function refreshHandsMeta() {
      els.playerHands.querySelectorAll(".bj-hand").forEach((wrap, i) => {
        const h = playerHands[i];
        if (!h) return;
        wrap.className = classesForHand(h, i);
        const meta = wrap.querySelector(".bj-hand-meta");
        if (meta) meta.textContent = metaTextForHand(h);
      });
    }
    function refreshDealerTotal() {
      // While the hole is hidden, show only the up card's value (index 1).
      els.dealerTotal.textContent = dealerHand.length
        ? (dealerHoleHidden
            ? (dealerHand.length > 1 ? ` (${rankValue(dealerHand[1].rank)})` : "")
            : ` (${handValue(dealerHand)})`)
        : "";
    }
    // Append a single card element to a container with the slide-in
    // dealing animation. Returns the new element.
    function appendCardWithAnimation(container, card, faceDown) {
      const tmp = document.createElement("div");
      tmp.innerHTML = cardHTML(card, faceDown);
      const el = tmp.firstElementChild;
      el.classList.add("bj-card-dealing");
      container.appendChild(el);
      return el;
    }
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    function render() {
      if (!els.bankroll) return;
      if (!bankrollAnimating) els.bankroll.textContent = fmt(bankroll);
      els.handCount.textContent = `${handNumber} / ${HANDS_PER_SESSION}`;
      els.best.textContent = fmt(loadBest());
      els.betAmount.textContent = Math.round(currentBet).toLocaleString();

      if (cardsLocked) {
        refreshHandsMeta();
        refreshDealerTotal();
      } else {
        rebuildAllCards();
        refreshDealerTotal();
      }

      els.playerTotal.textContent = (phase === "playing" && playerHands[activeHandIdx])
        ? ` (${handValue(playerHands[activeHandIdx].cards)})` : "";

      // Toggle control rows. The bet row stays visible after a hand
      // ends ("result" phase) so the player can click a chip to auto-
      // advance into the next hand — no "Next Hand" button needed.
      els.betRow.hidden       = !(phase === "betting" || phase === "result");
      els.actionRow.hidden    = phase !== "playing";
      els.insuranceRow.hidden = phase !== "insurance";

      // Chip availability — chips only work during betting; result-phase
      // chips are disabled because the user must click the table to clear
      // the previous hand first. Clear stays usable whenever there's a bet
      // on the table to refund.
      els.chips.forEach(b => {
        const v = b.dataset.chip;
        if (phase !== "betting") { b.disabled = true; return; }
        if (v === "clear")       { b.disabled = currentBet <= 0; return; }
        if (v === "max")         { b.disabled = bankroll <= 0; return; }
        b.disabled = bankroll < parseInt(v, 10);
      });
      // Action buttons enabled state
      if (phase === "playing") {
        const h = playerHands[activeHandIdx];
        const can = !!h && !h.done;
        const twoCards = can && h.cards.length === 2;
        // Split-ace hands get exactly one card each and can't hit or
        // double — they can only resplit (if dealt another ace) or stand.
        // The hand is left "active" (done=false) only when resplit is
        // legal, so the only useful actions here are Split or Stand.
        const splitAceHand = can && h.splitFromAce;
        els.hitBtn.disabled = !can || splitAceHand;
        els.standBtn.disabled = !can;
        els.doubleBtn.disabled = !twoCards || splitAceHand || bankroll < h.bet;
        // Split allowed up to 4 hands total. For split-ace hands, the
        // hand is left "active" only when its second card is also an ace
        // (RSA), so the normal can/!h.done guard already gates it; we
        // additionally require pair + bankroll + under the 4-hand cap.
        els.splitBtn.disabled = !(twoCards
                                  && rankValue(h.cards[0].rank) === rankValue(h.cards[1].rank)
                                  && playerHands.length < 4
                                  && bankroll >= h.bet);
        els.surrenderBtn.disabled = !twoCards || playerHands.length > 1;
      }
      if (phase === "session-end") {
        els.chips.forEach(b => b.disabled = true);
      }
      // The message either reads as plain status text OR turns into the
      // big "Deal Cards" CTA pill when there's a live bet waiting to play.
      renderMessage();
    }
    // Pending status text — set from non-render call sites (e.g. result
    // summary after a hand). render() may overwrite this with the Deal
    // Cards CTA when there's a live bet to play.
    let pendingMessage = "Place your bet to begin.";
    function setMessage(text) {
      pendingMessage = text;
      if (els.message) renderMessage();
    }
    function renderMessage() {
      if (!els.message) return;
      els.message.classList.remove("bj-message-cta", "bj-message-clear");
      els.message.onclick = null;
      // "Deal Cards" — plain centered text shown while there's a live
      // bet waiting to play. No pill, no border, just glowing white text.
      if (phase === "betting" && currentBet > 0) {
        els.message.classList.add("bj-message-cta");
        els.message.innerHTML = `<span class="bj-deal-cta-text">Deal Cards</span>`;
        els.message.onclick = deal;
        return;
      }
      // Result phase — show the outcome line; the whole message is the
      // "Click to clear" affordance. Clicking it advances to the next hand.
      if (phase === "result") {
        els.message.classList.add("bj-message-clear");
        els.message.textContent = pendingMessage;
        els.message.onclick = clearAndAdvance;
        return;
      }
      // Session over — the entire centered message is the affordance to
      // start a fresh 10-hand session. There's no "New Session" button
      // anymore; this IS the button.
      if (phase === "session-end") {
        els.message.classList.add("bj-message-clear");
        els.message.textContent = pendingMessage;
        els.message.onclick = newSession;
        return;
      }
      els.message.textContent = pendingMessage;
    }

    // ---- Game flow ----
    function newSession() {
      shoe = buildShoe();
      bankroll = STARTING_BANKROLL;
      handNumber = 1;
      sessionDone = false;
      resetHandState();
      cardsLocked = false;       // fresh state → render rebuilds cards
      phase = "betting";
      setMessage("Place your bet to begin.");
      render();
    }
    function resetHandState() {
      currentBet = 0;
      playerHands = [];
      activeHandIdx = 0;
      dealerHand = [];
      dealerHoleHidden = true;
      insuranceBet = 0;
      cardsLocked = false;       // empty cards → safe to let render rebuild
    }
    function addBet(amount) {
      if (sessionDone) return;
      // Result phase requires the user to click the table first ("Click
      // to clear") before they can bet — see clearAndAdvance().
      if (phase !== "betting") return;
      // Bet money is taken off the bankroll the moment you stack chips.
      // Clear refunds whatever's currently on the table; Max sweeps the
      // remaining bankroll onto the table.
      let delta = 0;
      if (amount === "max") {
        delta = bankroll;
      } else if (amount === "clear") {
        delta = -currentBet;
      } else {
        const n = parseInt(amount, 10);
        delta = Math.max(0, Math.min(n, bankroll));
      }
      currentBet += delta;
      bankroll -= delta;
      render();
    }
    // Animated initial deal. Sequence (≈420ms per beat):
    //   1) Player card 1 face up
    //   2) Dealer hole card face down  (dealerHand[0])
    //   3) Player card 2 face up
    //   4) Dealer up card face up      (dealerHand[1])
    // Then runs the standard BJ / insurance / peek checks.
    async function deal() {
      if (phase !== "betting" || currentBet <= 0) return;
      // Bankroll was already debited as chips went on the table.
      phase = "dealing";
      cardsLocked = true;
      activeHandIdx = 0;
      // Reset hand state and DOM containers.
      playerHands = [{ cards: [], bet: currentBet, doubled: false, surrendered: false, done: false, result: null }];
      dealerHand = [];
      dealerHoleHidden = true;
      els.dealerCards.innerHTML = "";
      els.playerHands.innerHTML = "";
      // Build the player hand wrapper (empty bj-hand-cards inside).
      const wrap = document.createElement("div");
      wrap.className = classesForHand(playerHands[0], 0);
      wrap.innerHTML = `<div class="bj-hand-cards"></div><div class="bj-hand-meta">${metaTextForHand(playerHands[0])}</div>`;
      els.playerHands.appendChild(wrap);
      const playerCardsEl = wrap.querySelector(".bj-hand-cards");
      // Hide bet row + show the in-game UI before the first card lands.
      pendingMessage = "Dealing…";
      render();

      // 1) Player gets card 1 face up
      const c1 = dealCard();
      playerHands[0].cards.push(c1);
      appendCardWithAnimation(playerCardsEl, c1, false);
      refreshHandsMeta();
      await sleep(420);

      // 2) Dealer hole card — face DOWN. dealerHand[0] = hole.
      const c2 = dealCard();
      dealerHand.push(c2);
      appendCardWithAnimation(els.dealerCards, c2, true);
      refreshDealerTotal();
      await sleep(420);

      // 3) Player card 2 face up
      const c3 = dealCard();
      playerHands[0].cards.push(c3);
      appendCardWithAnimation(playerCardsEl, c3, false);
      refreshHandsMeta();
      await sleep(420);

      // 4) Dealer up card face up. dealerHand[1] = up card.
      const c4 = dealCard();
      dealerHand.push(c4);
      appendCardWithAnimation(els.dealerCards, c4, false);
      refreshDealerTotal();
      await sleep(420);

      // Now run the standard initial-deal logic. Dealer index convention
      // is now [0] = hole, [1] = up card.
      const playerBJ = isBlackjack(playerHands[0].cards);
      const dealerUpAce = dealerHand[1].rank === "A";
      const dealerUpTen = rankValue(dealerHand[1].rank) === 10;

      // Insurance offered when dealer shows Ace AND player has enough $
      if (dealerUpAce && !playerBJ && bankroll >= Math.floor(currentBet / 2)) {
        phase = "insurance";
        insuranceBet = Math.floor(currentBet / 2);
        // Write the whole label as one text node — the button uses
        // inline-flex with gap, so nested spans would get gap-spaced.
        if (els.insuranceYesBtn) {
          els.insuranceYesBtn.textContent = `Yes ($${insuranceBet.toLocaleString()})`;
        }
        setMessage("Dealer shows Ace — take insurance?");
        render();
        return;
      }

      // If dealer shows Ace OR 10-value, peek for blackjack.
      if (dealerUpAce || dealerUpTen) {
        if (isBlackjack(dealerHand)) {
          await revealHoleCardWithSuspense(400);
          resolveAfterDeal(playerBJ);
          return;
        }
      }

      if (playerBJ) {
        // Player BJ, dealer doesn't have one → 3:2 immediate pay
        playerHands[0].done = true;
        await revealHoleCardWithSuspense(250);
        const winnings = currentBet + Math.floor(currentBet * 1.5);
        const startBankroll = bankroll;
        bankroll += winnings;
        playerHands[0].result = "win";
        if (bankroll > startBankroll) animateBankroll(startBankroll, bankroll);
        setMessage(`Blackjack! Pays 3:2 — you win ${fmt(Math.floor(currentBet * 1.5))}. Click to clear.`);
        // Hand's resolved — the bet is no longer "on the table" so the
        // bet display zeroes out (was visually adding to the bankroll).
        currentBet = 0;
        phase = "result";
        render();
        return;
      }
      phase = "playing";
      setMessage("Your action.");
      render();
    }
    // Find the dealer's hole card element (index 0 in the DOM) and flip
    // it face-up with a quick rotation animation. Used during the dealer
    // turn and on initial-deal blackjack resolution.
    async function revealHoleCardWithSuspense(suspenseMs = 700) {
      if (!dealerHoleHidden || dealerHand.length < 1) return;
      await sleep(suspenseMs);
      dealerHoleHidden = false;
      const holeEl = els.dealerCards.querySelector(".bj-card-face");
      if (holeEl) {
        const tmp = document.createElement("div");
        tmp.innerHTML = cardHTML(dealerHand[0], false);
        const newEl = tmp.firstElementChild;
        newEl.classList.add("bj-card-flipping");
        els.dealerCards.replaceChild(newEl, holeEl);
      }
      refreshDealerTotal();
      await sleep(550);
    }
    function resolveAfterDeal(playerBJ) {
      // Called when dealer has blackjack on the initial deal
      if (playerBJ) {
        bankroll += currentBet;  // push: return bet
        playerHands[0].result = "push";
        setMessage("Both blackjack — push. Bet returned.");
      } else {
        playerHands[0].result = "lose";
        setMessage("Dealer blackjack. You lose.");
      }
      currentBet = 0;
      phase = "result";
      render();
    }
    async function insuranceYes() {
      if (phase !== "insurance") return;
      bankroll -= insuranceBet;
      if (isBlackjack(dealerHand)) {
        await revealHoleCardWithSuspense(450);
        bankroll += insuranceBet * 3;   // Insurance pays 2:1
        playerHands[0].result = "lose";
        setMessage("Dealer blackjack — insurance pays 2:1. Net: bet lost, insurance won. Click to clear.");
        currentBet = 0;
        phase = "result";
        render();
        return;
      }
      setMessage(`Insurance lost. Your action.`);
      insuranceBet = 0;
      phase = "playing";
      render();
    }
    async function insuranceNo() {
      if (phase !== "insurance") return;
      if (isBlackjack(dealerHand)) {
        await revealHoleCardWithSuspense(450);
        playerHands[0].result = "lose";
        setMessage("Dealer blackjack. You lose. Click to clear.");
        currentBet = 0;
        phase = "result";
        render();
        return;
      }
      setMessage("Your action.");
      insuranceBet = 0;
      phase = "playing";
      render();
    }
    // Append a card to the active player hand's DOM container.
    function appendPlayerCard(card) {
      const wrap = els.playerHands.children[activeHandIdx];
      const cardsEl = wrap?.querySelector(".bj-hand-cards");
      if (cardsEl) appendCardWithAnimation(cardsEl, card, false);
    }
    async function hit() {
      if (phase !== "playing") return;
      const h = playerHands[activeHandIdx];
      const card = dealCard();
      h.cards.push(card);
      appendPlayerCard(card);
      refreshHandsMeta();
      await sleep(360);
      if (isBust(h.cards)) {
        h.done = true;
        h.result = "lose";
        advanceOrDealer();
      } else if (handValue(h.cards) === 21) {
        h.done = true;
        advanceOrDealer();
      } else {
        render();
      }
    }
    function stand() {
      if (phase !== "playing") return;
      playerHands[activeHandIdx].done = true;
      advanceOrDealer();
    }
    async function doubleDown() {
      if (phase !== "playing") return;
      const h = playerHands[activeHandIdx];
      if (h.cards.length !== 2 || bankroll < h.bet) return;
      bankroll -= h.bet;
      h.bet *= 2;
      h.doubled = true;
      const card = dealCard();
      h.cards.push(card);
      h.done = true;
      appendPlayerCard(card);
      refreshHandsMeta();
      await sleep(420);
      if (isBust(h.cards)) h.result = "lose";
      advanceOrDealer();
    }
    // Split rules:
    //   - Up to 4 hands total on the table (Vegas standard).
    //   - Re-Split Aces allowed (RSA): if you split aces and one of the new
    //     cards is another ace, you can split that hand again, until you
    //     hit the 4-hand cap.
    //   - Split-ace hands get 1 card each and otherwise can't act (no hit,
    //     no double, no surrender). They stay "active" only if resplit is
    //     possible; otherwise auto-advance.
    function split() {
      if (phase !== "playing") return;
      const h = playerHands[activeHandIdx];
      if (h.cards.length !== 2) return;
      if (rankValue(h.cards[0].rank) !== rankValue(h.cards[1].rank)) return;
      if (playerHands.length >= 4) return;
      if (bankroll < h.bet) return;
      bankroll -= h.bet;
      const c1 = h.cards[0], c2 = h.cards[1];
      const splitFromAce = (c1.rank === "A");
      const newHand = (starter) => ({
        cards: [starter, dealCard()],
        bet: h.bet,
        doubled: false,
        surrendered: false,
        done: false,
        result: null,
        splitFromAce,
      });
      const newHand1 = newHand(c1);
      const newHand2 = newHand(c2);
      // Replace the active hand with both new hands at the same position
      // so other hands (if any) keep their order.
      playerHands.splice(activeHandIdx, 1, newHand1, newHand2);
      // For split aces, mark each new hand done UNLESS its second card is
      // another ace AND we can still split further (RSA + 4-hand cap +
      // bankroll). Those stay open for the user to choose split vs stand.
      if (splitFromAce) {
        for (const nh of [newHand1, newHand2]) {
          const canResplit =
            nh.cards[1].rank === "A"
            && playerHands.length < 4
            && bankroll >= nh.bet;
          nh.done = !canResplit;
        }
      }
      // Rebuild the player hands DOM so the new wrappers appear and the
      // freshly-dealt cards animate in. Other hands' cards will re-animate
      // too — minor cost, but split is a relatively rare action.
      cardsLocked = false;
      render();
      cardsLocked = true;
      els.playerHands.querySelectorAll(".bj-card-face").forEach(el => el.classList.add("bj-card-dealing"));
      // If every hand is "done" (split-ace branch with no resplittable
      // hands), auto-advance after the deal animation settles.
      if (playerHands.every(ph => ph.done)) {
        setTimeout(advanceOrDealer, 420);
      }
    }
    function surrender() {
      if (phase !== "playing") return;
      const h = playerHands[activeHandIdx];
      if (h.cards.length !== 2 || playerHands.length > 1) return;
      h.surrendered = true;
      h.done = true;
      h.result = "lose";
      bankroll += Math.floor(h.bet / 2);  // get half back
      advanceOrDealer();
    }
    async function advanceOrDealer() {
      while (activeHandIdx < playerHands.length && playerHands[activeHandIdx].done) {
        activeHandIdx++;
      }
      if (activeHandIdx < playerHands.length) {
        render();
        return;
      }
      // All player hands done — run dealer if any hand is still live.
      const anyLive = playerHands.some(h => !isBust(h.cards) && !h.surrendered);
      if (!anyLive) {
        finishHand();
        return;
      }
      phase = "dealer";
      setMessage("Dealer's turn…");
      render();
      // Dealer reveals the hole card with suspense, then draws to 17+.
      await revealHoleCardWithSuspense(700);
      // Vegas Strip H17 — dealer must hit on any 17 that includes an
      // ace counted as 11 (soft 17). Hard 17+ stays.
      while (handValue(dealerHand) < 17
             || (handValue(dealerHand) === 17 && isSoft(dealerHand))) {
        await sleep(700);    // longer pause for tension between draws
        const card = dealCard();
        dealerHand.push(card);
        appendCardWithAnimation(els.dealerCards, card, false);
        refreshDealerTotal();
        await sleep(420);
      }
      await sleep(450);
      finishHand();
    }
    function finishHand() {
      const startBankroll = bankroll;   // pre-resolution snapshot (for animation)
      const dTotal = handValue(dealerHand);
      const dBust = dTotal > 21;
      let summary = [];
      for (const h of playerHands) {
        if (h.surrendered) {
          summary.push(`Surrendered ${fmt(Math.ceil(h.bet / 2))}`);
          continue;
        }
        if (isBust(h.cards)) {
          summary.push(`Bust −${fmt(h.bet)}`);
          continue;
        }
        const pTotal = handValue(h.cards);
        if (dBust || pTotal > dTotal) {
          // Other wins pay 1:1 (player blackjack already paid 3:2 above).
          bankroll += h.bet * 2;           // return bet + winnings
          h.result = "win";
          summary.push(`Won ${fmt(h.bet)}`);
        } else if (pTotal === dTotal) {
          bankroll += h.bet;               // push: return bet
          h.result = "push";
          summary.push("Push");
        } else {
          // Loss: bankroll already lost the bet at chip-stack time — no
          // change here, no animation. Silent.
          h.result = "lose";
          summary.push(`Lost ${fmt(h.bet)}`);
        }
      }
      // Track best session bankroll
      if (bankroll > loadBest()) saveBest(bankroll);
      // Wipe currentBet so the bet display zeroes out — pushes/wins were
      // crediting the bankroll while the bet still read on screen, which
      // looked like the player had double their bankroll.
      currentBet = 0;
      const sessionOver = handNumber >= HANDS_PER_SESSION || bankroll <= 0;
      const headline = `${summary.join(" · ")}. Dealer ${dBust ? "bust" : dTotal}.`;
      if (sessionOver) {
        // Skip the intermediate "result" phase — go straight to session-end
        // so the user sees ONE message instead of two screens (hand result
        // followed by a separate session-over screen). Message stays terse:
        // the bust + Lost amount + dealer total are already legible in the
        // dealer/player rows, so we don't repeat them in the headline.
        phase = "session-end";
        setMessage(`Final bankroll ${fmt(bankroll)}. Click to start new session.`);
        submitScore(bankroll).then(loadLeaderboard).catch(() => {});
      } else {
        phase = "result";
        setMessage(`${headline} Click to clear.`);
      }
      // Animate bankroll up on win or push. On loss the bankroll didn't
      // change (debit happened at bet-place time), so no animation fires.
      if (bankroll > startBankroll) {
        animateBankroll(startBankroll, bankroll);
      }
      render();
    }
    // "Click to clear" — fires when the user clicks the result message.
    // Wipes the felt and transitions to the next hand's betting phase.
    function clearAndAdvance() {
      if (phase !== "result") return;
      if (handNumber >= HANDS_PER_SESSION || bankroll <= 0) {
        sessionDone = true;
        phase = "session-end";
        if (bankroll > loadBest()) saveBest(bankroll);
        submitScore(bankroll).then(loadLeaderboard).catch(() => {});
        // The "New Session" button is gone — the message itself becomes
        // the affordance. renderMessage() wires the click → newSession.
        setMessage(`Final bankroll ${fmt(bankroll)}. Click to start new session.`);
        return;
      }
      handNumber++;
      resetHandState();
      phase = "betting";
      pendingMessage = `Hand ${handNumber} of ${HANDS_PER_SESSION}. Place your bet to begin.`;
      render();
    }
    // Legacy no-op stub kept so stale bindings can't blow up.
    function nextHand() { clearAndAdvance(); }

    // ---- All-time server leaderboard (top final bankrolls) ----
    async function submitScore(score) {
      try {
        await fetch("/api/blackjack/score", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ score: Math.max(0, Math.floor(score)) }),
        });
      } catch {}
    }
    async function loadLeaderboard() {
      const tbody = document.getElementById("bj-leaderboard-body");
      if (!tbody) return;
      try {
        const r = await fetch("/api/blackjack/leaderboard", { credentials: "same-origin" });
        if (!r.ok) {
          tbody.innerHTML = `<tr><td colspan="4" class="freegame-empty">Leaderboard unavailable.</td></tr>`;
          return;
        }
        const j = await r.json();
        renderLeaderboard(j.leaders || [], j.me || null);
      } catch {
        tbody.innerHTML = `<tr><td colspan="4" class="freegame-empty">Network error.</td></tr>`;
      }
    }
    function renderLeaderboard(leaders, me) {
      const tbody = document.getElementById("bj-leaderboard-body");
      if (!tbody) return;
      if (!leaders.length) {
        tbody.innerHTML = `<tr><td colspan="4" class="freegame-empty">No scores yet — be the first.</td></tr>`;
        return;
      }
      const medal = (rank) => rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `#${rank}`;
      const ago = (iso) => {
        if (!iso) return "—";
        const t = new Date(iso);
        const diff = Date.now() - t.getTime();
        const m = Math.floor(diff / 60000);
        if (m < 1) return "just now";
        if (m < 60) return `${m}m ago`;
        const h = Math.floor(m / 60);
        if (h < 24) return `${h}h ago`;
        const d = Math.floor(h / 24);
        if (d < 30) return `${d}d ago`;
        return t.toLocaleDateString();
      };
      // Match the VelosiRunner leaderboard styling exactly — same row
      // highlight class (freegame-me-row), same "you" pill class
      // (freegame-you), name wrapped in <strong> for the me row. Keeps
      // the two leaderboards visually consistent across the Games tab.
      const renderName = (L) => L.is_me
        ? `<strong>${escapeHtml(L.username)}</strong> <span class="freegame-you">you</span>`
        : escapeHtml(L.username);
      const rows = leaders.map(L => `
        <tr${L.is_me ? ' class="freegame-me-row"' : ""}>
          <td class="rank-col">${medal(L.rank)}</td>
          <td>${renderName(L)}</td>
          <td class="score-col">$${Number(L.score).toLocaleString()}</td>
          <td class="when-col">${escapeHtml(ago(L.achieved_at))}</td>
        </tr>
      `).join("");
      let tail = "";
      if (me && !leaders.some(L => L.is_me)) {
        tail = `
          <tr class="freegame-leaderboard-sep"><td colspan="4">…</td></tr>
          <tr class="freegame-me-row">
            <td class="rank-col">#${me.rank}</td>
            <td><strong>${escapeHtml(me.username)}</strong> <span class="freegame-you">you</span></td>
            <td class="score-col">$${Number(me.score).toLocaleString()}</td>
            <td class="when-col">${escapeHtml(ago(me.achieved_at))}</td>
          </tr>
        `;
      }
      tbody.innerHTML = rows + tail;
    }

    function start() {
      els = {
        bankroll: document.getElementById("bj-bankroll"),
        handCount: document.getElementById("bj-hand-count"),
        best: document.getElementById("bj-best"),
        betAmount: document.getElementById("bj-bet-amount"),
        dealerCards: document.getElementById("bj-dealer-cards"),
        dealerTotal: document.getElementById("bj-dealer-total"),
        playerHands: document.getElementById("bj-player-hands"),
        playerTotal: document.getElementById("bj-player-total"),
        message: document.getElementById("bj-message"),
        betRow: document.getElementById("bj-bet-row"),
        actionRow: document.getElementById("bj-action-row"),
        insuranceRow: document.getElementById("bj-insurance-row"),
        hitBtn: document.getElementById("bj-hit"),
        standBtn: document.getElementById("bj-stand"),
        doubleBtn: document.getElementById("bj-double"),
        splitBtn: document.getElementById("bj-split"),
        surrenderBtn: document.getElementById("bj-surrender"),
        insuranceYesBtn: document.getElementById("bj-insurance-yes"),
        chips: Array.from(document.querySelectorAll(".bj-chip")),
      };
      if (!els.bankroll) return;
      if (!bound) {
        els.chips.forEach(b => b.addEventListener("click", () => addBet(b.dataset.chip)));
        els.hitBtn?.addEventListener("click", hit);
        els.standBtn?.addEventListener("click", stand);
        els.doubleBtn?.addEventListener("click", doubleDown);
        els.splitBtn?.addEventListener("click", split);
        els.surrenderBtn?.addEventListener("click", surrender);
        document.getElementById("bj-insurance-yes")?.addEventListener("click", insuranceYes);
        document.getElementById("bj-insurance-no")?.addEventListener("click", insuranceNo);
        // bj-new-session button removed — session-end message itself is
        // the affordance (renderMessage wires onclick → newSession).
        document.getElementById("bj-leaderboard-refresh")?.addEventListener("click", loadLeaderboard);
        bound = true;
      }
      if (!shoe.length) newSession();
      else render();
      loadLeaderboard();
    }
    function stop() { /* event-driven, nothing to tear down */ }
    return { start, stop };
  })();

  // -------- Velosify Chess (you vs the computer) --------
  // Uses chess.js (loaded via CDN in index.html) for legal-move generation,
  // check/checkmate, castling, en passant, and promotion. The AI is a
  // simple minimax with material evaluation — beatable on purpose.
  const ChessGame = (function () {
    // White uses outlined glyphs, black uses filled. Same color in CSS;
    // the outline-vs-fill difference is what reads as "white vs black".
    // Staunty piece set — Lichess's chunky/bold Staunton variant.
    // Picked over Cburnett (which is thinner/more delicate) because the
    // user wanted a bolder look closer to a chunky cartoony reference
    // board. Loaded from jsdelivr so we don't have to vendor 12 piece
    // files locally. If we ever want to swap visual styles, just change
    // the last URL segment — lichess hosts ~25 sets at this path.
    const PIECE_CDN = "https://cdn.jsdelivr.net/gh/lichess-org/lila@master/public/piece/staunty";
    const PIECE_FILE = {
      wK: "wK.svg", wQ: "wQ.svg", wR: "wR.svg", wB: "wB.svg", wN: "wN.svg", wP: "wP.svg",
      bK: "bK.svg", bQ: "bQ.svg", bR: "bR.svg", bB: "bB.svg", bN: "bN.svg", bP: "bP.svg",
    };
    // Centipawn-ish piece values for the AI eval.
    const VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };
    // Tiny positional nudges — encourage center control + piece development
    // without making the engine actually good. Indexed [rank][file] from white's view.
    const PAWN_TABLE = [
      [0,0,0,0,0,0,0,0],
      [50,50,50,50,50,50,50,50],
      [10,10,20,30,30,20,10,10],
      [5,5,10,25,25,10,5,5],
      [0,0,0,20,20,0,0,0],
      [5,-5,-10,0,0,-10,-5,5],
      [5,10,10,-20,-20,10,10,5],
      [0,0,0,0,0,0,0,0],
    ];
    const KNIGHT_TABLE = [
      [-50,-40,-30,-30,-30,-30,-40,-50],
      [-40,-20,0,0,0,0,-20,-40],
      [-30,0,10,15,15,10,0,-30],
      [-30,5,15,20,20,15,5,-30],
      [-30,0,15,20,20,15,0,-30],
      [-30,5,10,15,15,10,5,-30],
      [-40,-20,0,5,5,0,-20,-40],
      [-50,-40,-30,-30,-30,-30,-40,-50],
    ];
    function tableAt(t, sq, color) {
      // sq is algebraic like "e4"; rank 0 = top of board from white's view
      const file = sq.charCodeAt(0) - 97;
      const rank = 8 - parseInt(sq[1], 10);
      return color === "w" ? t[rank][file] : t[7 - rank][file];
    }
    function evaluate(g) {
      // From white's perspective. Positive = white winning.
      const board = g.board();
      let score = 0;
      for (let r = 0; r < 8; r++) {
        for (let f = 0; f < 8; f++) {
          const p = board[r][f];
          if (!p) continue;
          const sq = String.fromCharCode(97 + f) + (8 - r);
          let v = VALUE[p.type];
          if (p.type === "p") v += tableAt(PAWN_TABLE, sq, p.color);
          if (p.type === "n") v += tableAt(KNIGHT_TABLE, sq, p.color);
          score += p.color === "w" ? v : -v;
        }
      }
      return score;
    }
    function shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    }
    // Minimax with alpha-beta. The AI plays black; deeper = stronger.
    function minimax(g, depth, alpha, beta, maximizing) {
      if (depth === 0 || g.game_over()) return evaluate(g);
      const moves = shuffle(g.moves());
      if (maximizing) {
        let best = -Infinity;
        for (const m of moves) {
          g.move(m);
          const score = minimax(g, depth - 1, alpha, beta, false);
          g.undo();
          best = Math.max(best, score);
          alpha = Math.max(alpha, score);
          if (beta <= alpha) break;
        }
        return best;
      } else {
        let best = Infinity;
        for (const m of moves) {
          g.move(m);
          const score = minimax(g, depth - 1, alpha, beta, true);
          g.undo();
          best = Math.min(best, score);
          beta = Math.min(beta, score);
          if (beta <= alpha) break;
        }
        return best;
      }
    }
    function pickAIMove(g, difficulty) {
      const moves = shuffle(g.moves({ verbose: true }));
      if (!moves.length) return null;
      // EASY: 55% chance to play a random move outright (blunders). Otherwise
      // pick the best capture available, or fall back to random. Roughly the
      // strength of a casual beginner — captures pieces when offered, hangs
      // its own pieces sometimes, doesn't plan ahead.
      if (difficulty === "easy") {
        if (Math.random() < 0.55) return moves[0];
        const captures = moves.filter(m => m.captured);
        if (captures.length) {
          captures.sort((a, b) => VALUE[b.captured] - VALUE[a.captured]);
          return captures[0];
        }
        return moves[0];
      }
      // MEDIUM (depth 2) / HARD (depth 3) — minimax, AI minimizes (plays black).
      const depth = difficulty === "hard" ? 3 : 2;
      let best = moves[0];
      let bestScore = Infinity;
      for (const m of moves) {
        g.move(m);
        const score = minimax(g, depth - 1, -Infinity, Infinity, true);
        g.undo();
        if (score < bestScore) { bestScore = score; best = m; }
      }
      return best;
    }
    /* Suggest a strong move for the player (white side). Mirrors pickAIMove
       but maximizes (the eval is from white's perspective inside minimax).
       Runs at depth 2 — same strength as the Medium AI — which is enough
       to spot tactics one move deep without making this beginner-friendly
       game suddenly feel like an engine. Returns a verbose move or null
       if the position is terminal or it's not the player's turn. */
    function suggestPlayerMove(g) {
      if (g.game_over() || g.turn() !== "w") return null;
      const moves = shuffle(g.moves({ verbose: true }));
      if (!moves.length) return null;
      const depth = 2;
      let best = moves[0];
      let bestScore = -Infinity;
      for (const m of moves) {
        g.move(m);
        // After our move it's black to move, which is the MINIMIZING side
        // in our minimax convention, so the recursive call passes
        // maximizing=false.
        const score = minimax(g, depth - 1, -Infinity, Infinity, false);
        g.undo();
        if (score > bestScore) { bestScore = score; best = m; }
      }
      return best;
    }

    // Cached DOM refs and state
    let game = null;            // chess.js instance
    let boardEl = null;
    let statusEl = null;
    let historyEl = null;
    let capturedYouEl = null;
    let capturedCpuEl = null;
    let undoBtn = null;
    let hintBtn = null;
    let selected = null;        // currently-selected square, e.g. "e2"
    let legalForSelected = [];  // verbose move objects for highlight
    let lastMove = null;        // {from, to} for highlight
    // Hint state: when the user clicks the hint button we run a fresh
    // search from the white side and stash the best move as {from, to}
    // so render() can paint the two squares with a separate "hint"
    // highlight. Cleared the moment the player actually moves (so it
    // never lingers into the next position).
    let hintMove = null;
    // Slide/hop animation queued for the next render — set by player
    // and AI move handlers, consumed once and cleared by render(). The
    // animation classes (chess-piece-slide / chess-piece-hop) compute
    // their starting transform from CSS vars --dx/--dy that we set just
    // before adding the class, so any move distance + direction works.
    let pendingAnim = null; // {from: "e2", to: "e4", piece: "p"|"n"|...}
    let aiThinking = false;
    let difficulty = "easy";

    function squareId(file, rank) {
      // file 0-7 = a-h, rank 0-7 = 8-1 (so display top-to-bottom matches white's view)
      return String.fromCharCode(97 + file) + (8 - rank);
    }
    function pieceFileName(piece) {
      if (!piece) return "";
      return PIECE_FILE[(piece.color === "w" ? "w" : "b") + piece.type.toUpperCase()];
    }
    function buildBoard() {
      if (!boardEl) return;
      boardEl.innerHTML = "";
      for (let r = 0; r < 8; r++) {
        for (let f = 0; f < 8; f++) {
          const sq = document.createElement("div");
          const isLight = (r + f) % 2 === 0;
          sq.className = "chess-sq " + (isLight ? "light" : "dark");
          sq.dataset.square = squareId(f, r);
          sq.addEventListener("click", onSquareClick);
          boardEl.appendChild(sq);
        }
      }
    }
    function render() {
      if (!game || !boardEl) return;
      const board = game.board();
      // Find the king in check (if any) for the red highlight
      let checkSquare = null;
      if (game.in_check()) {
        const turn = game.turn();
        for (let r = 0; r < 8; r++) {
          for (let f = 0; f < 8; f++) {
            const p = board[r][f];
            if (p && p.type === "k" && p.color === turn) {
              checkSquare = squareId(f, r);
            }
          }
        }
      }
      const sqs = boardEl.querySelectorAll(".chess-sq");
      sqs.forEach(sqEl => {
        const sqId = sqEl.dataset.square;
        sqEl.classList.remove("selected", "legal", "capture", "last-from", "last-to", "check", "hint-from", "hint-to");
        sqEl.innerHTML = "";
        // Piece glyph
        const file = sqId.charCodeAt(0) - 97;
        const rank = 8 - parseInt(sqId[1], 10);
        const piece = board[rank][file];
        if (piece) {
          const img = document.createElement("img");
          img.className = "chess-piece " + (piece.color === "w" ? "white" : "black");
          img.src = PIECE_CDN + "/" + pieceFileName(piece);
          img.alt = (piece.color === "w" ? "White " : "Black ") + piece.type;
          img.draggable = false;
          sqEl.appendChild(img);
        }
        if (sqId === selected) sqEl.classList.add("selected");
        if (lastMove && sqId === lastMove.from) sqEl.classList.add("last-from");
        if (lastMove && sqId === lastMove.to)   sqEl.classList.add("last-to");
        if (sqId === checkSquare)               sqEl.classList.add("check");
        // Hint highlights — only painted while a hint is "live" (the user
        // clicked Hint and hasn't moved yet). Two distinct classes so the
        // CSS can use different glow intensities for from vs to.
        if (hintMove && sqId === hintMove.from) sqEl.classList.add("hint-from");
        if (hintMove && sqId === hintMove.to)   sqEl.classList.add("hint-to");
        const legal = legalForSelected.find(m => m.to === sqId);
        if (legal) {
          sqEl.classList.add("legal");
          if (legal.captured) sqEl.classList.add("capture");
        }
      });
      // Apply slide/hop animation to the just-moved piece. We measure
      // both squares now (after render rebuilt them), compute the
      // pixel delta from `to` back to `from`, set CSS vars on the
      // piece, and add the animation class. The keyframes interpolate
      // from translate(dx, dy) -> translate(0, 0), so the piece appears
      // to start at its prior square and slide to its new one. Knights
      // get a different keyframe with a vertical arc to feel like a hop.
      if (pendingAnim && pendingAnim.from && pendingAnim.to) {
        const fromEl = boardEl.querySelector(`.chess-sq[data-square="${pendingAnim.from}"]`);
        const toEl   = boardEl.querySelector(`.chess-sq[data-square="${pendingAnim.to}"]`);
        const pieceEl = toEl?.querySelector(".chess-piece");
        if (fromEl && toEl && pieceEl) {
          const fr = fromEl.getBoundingClientRect();
          const tr = toEl.getBoundingClientRect();
          pieceEl.style.setProperty("--dx", `${fr.left - tr.left}px`);
          pieceEl.style.setProperty("--dy", `${fr.top  - tr.top }px`);
          pieceEl.classList.add(pendingAnim.piece === "n"
            ? "chess-piece-hop"
            : "chess-piece-slide");
        }
        pendingAnim = null;
      }
      renderStatus();
      renderHistory();
      renderCaptured();
      if (undoBtn) undoBtn.disabled = game.history().length === 0 || aiThinking;
      // Hint only makes sense on the player's own turn.
      if (hintBtn) hintBtn.disabled = aiThinking || game.game_over() || game.turn() !== "w";
    }
    function renderStatus() {
      if (!statusEl) return;
      statusEl.classList.remove("win", "lose", "draw", "check");
      if (game.in_checkmate()) {
        const youWon = game.turn() === "b";  // black to move = white delivered mate
        statusEl.textContent = youWon ? "Checkmate — you win!" : "Checkmate — computer wins.";
        statusEl.classList.add(youWon ? "win" : "lose");
        return;
      }
      if (game.in_stalemate()) { statusEl.textContent = "Stalemate — it's a draw."; statusEl.classList.add("draw"); return; }
      if (game.in_threefold_repetition()) { statusEl.textContent = "Draw by threefold repetition."; statusEl.classList.add("draw"); return; }
      if (game.insufficient_material()) { statusEl.textContent = "Draw — insufficient material."; statusEl.classList.add("draw"); return; }
      if (game.in_draw()) { statusEl.textContent = "Draw."; statusEl.classList.add("draw"); return; }
      if (aiThinking) { statusEl.textContent = "Computer thinking…"; return; }
      const yourTurn = game.turn() === "w";
      let text = yourTurn ? "Your turn (white)." : "Computer's turn.";
      if (game.in_check()) {
        text = yourTurn ? "You're in check!" : "Check on the computer!";
        statusEl.classList.add("check");
      }
      statusEl.textContent = text;
    }
    function renderHistory() {
      if (!historyEl) return;
      const moves = game.history();
      const pairs = [];
      for (let i = 0; i < moves.length; i += 2) {
        pairs.push((moves[i] || "") + (moves[i + 1] ? "  " + moves[i + 1] : ""));
      }
      historyEl.innerHTML = pairs.map(p => `<li>${p}</li>`).join("");
      historyEl.scrollTop = historyEl.scrollHeight;
    }
    function renderCaptured() {
      if (!capturedYouEl || !capturedCpuEl) return;
      const byYou = [];   // pieces white captured (black pieces)
      const byCpu = [];   // pieces black captured (white pieces)
      for (const m of game.history({ verbose: true })) {
        if (!m.captured) continue;
        const glyph = GLYPHS[(m.color === "w" ? "b" : "w") + m.captured.toUpperCase()];
        (m.color === "w" ? byYou : byCpu).push(glyph);
      }
      capturedYouEl.textContent = byYou.join(" ");
      capturedCpuEl.textContent = byCpu.join(" ");
    }
    function onSquareClick(e) {
      if (aiThinking || !game) return;
      if (game.game_over()) return;
      if (game.turn() !== "w") return;
      const sq = e.currentTarget.dataset.square;
      const piece = game.get(sq);
      if (selected) {
        const move = legalForSelected.find(m => m.to === sq);
        if (move) {
          // Auto-promote to queen for the user (simplest UX).
          const played = game.move({ from: selected, to: sq, promotion: "q" });
          lastMove = { from: selected, to: sq };
          if (played) pendingAnim = { from: played.from, to: played.to, piece: played.piece };
          selected = null;
          legalForSelected = [];
          // The position changed — the prior hint is stale, drop it.
          hintMove = null;
          render();
          if (!game.game_over()) scheduleAI();
          return;
        }
        // Clicked elsewhere: either pick a new piece or deselect
        if (piece && piece.color === "w") {
          selected = sq;
          legalForSelected = game.moves({ square: sq, verbose: true });
        } else {
          selected = null;
          legalForSelected = [];
        }
        render();
        return;
      }
      if (piece && piece.color === "w") {
        selected = sq;
        legalForSelected = game.moves({ square: sq, verbose: true });
        render();
      }
    }
    // Track when the AI was last scheduled and the pending timer handle
    // so a watchdog can detect timers that died (background tab throttle,
    // setTimeout dropped, etc.) and so stop() can cancel a pending move
    // when the user leaves the chess pane.
    let aiScheduledAt = 0;
    let aiTimerHandle = null;
    function doAIMove() {
      // Executes one AI move synchronously. Wrapped in try/finally so
      // aiThinking can NEVER get stuck at true — if the engine throws,
      // we still reset state and let the watchdog retry next tick.
      try {
        if (!game) return;
        const picked = pickAIMove(game, difficulty);
        let played = null;
        const tryMove = (m) => {
          if (!m) return false;
          try {
            const r = game.move(m);
            if (r) { played = r; return true; }
          } catch (_) { /* fall through and try the next move */ }
          return false;
        };
        if (!tryMove(picked)) {
          for (const m of game.moves({ verbose: true })) {
            if (tryMove(m)) break;
          }
        }
        if (played) {
          lastMove = { from: played.from, to: played.to };
          pendingAnim = { from: played.from, to: played.to, piece: played.piece };
        }
      } catch (_) {
        // Swallow — watchdog will retry on the next tick if still owed.
      } finally {
        aiThinking = false;
        aiTimerHandle = null;
        render();
      }
    }
    function scheduleAI() {
      aiThinking = true;
      aiScheduledAt = Date.now();
      render();
      if (aiTimerHandle) clearTimeout(aiTimerHandle);
      // Small delay so the move feels deliberate. setTimeout is
      // unreliable on backgrounded tabs — the watchdog below catches
      // any timers that don't fire in a reasonable window.
      aiTimerHandle = setTimeout(doAIMove, 350);
    }
    // Watchdog: every second, check that the engine is making progress.
    // Two failure modes covered:
    //   1) aiThinking=true for >3s -> the scheduled setTimeout was dropped
    //      (tab backgrounded, throttled, etc.). Force the move now.
    //   2) aiThinking=false, black to move, game not over -> the previous
    //      AI move was never scheduled at all. Schedule one.
    // Cheap to run (no work when it's white's turn or game is over).
    setInterval(() => {
      if (!game) return;
      if (game.game_over()) return;
      const blackToMove = game.turn() === "b";
      if (aiThinking && Date.now() - aiScheduledAt > 3000) {
        if (aiTimerHandle) { clearTimeout(aiTimerHandle); aiTimerHandle = null; }
        doAIMove();
        return;
      }
      if (!aiThinking && blackToMove) {
        scheduleAI();
      }
    }, 1000);
    // When the user returns to the tab, kick a watchdog pass immediately
    // instead of waiting up to a second for the interval. This is the
    // common "I tabbed away mid-game and came back" recovery path.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden || !game || game.game_over()) return;
      if (!aiThinking && game.turn() === "b") scheduleAI();
      else if (aiThinking && Date.now() - aiScheduledAt > 3000) {
        if (aiTimerHandle) { clearTimeout(aiTimerHandle); aiTimerHandle = null; }
        doAIMove();
      }
    });
    function newGame() {
      if (typeof window.Chess !== "function") {
        if (statusEl) statusEl.textContent = "Chess engine failed to load — refresh the page.";
        return;
      }
      game = new window.Chess();
      selected = null;
      legalForSelected = [];
      lastMove = null;
      hintMove = null;
      aiThinking = false;
      render();
    }
    function undoLastPair() {
      if (!game || aiThinking) return;
      if (game.history().length === 0) return;
      // Undo computer's move then user's so it's the user's turn again.
      game.undo();
      if (game.turn() === "b") game.undo();
      selected = null;
      legalForSelected = [];
      hintMove = null;
      const hist = game.history({ verbose: true });
      lastMove = hist.length ? { from: hist[hist.length - 1].from, to: hist[hist.length - 1].to } : null;
      render();
    }
    /* Player-facing hint button: run the suggestPlayerMove search, stash
       the best move so render() highlights it, and let the user decide
       whether to play it. Click Hint twice and you toggle it off — handy
       if the highlight gets in the way of looking at the position. */
    function showHint() {
      if (!game || aiThinking) return;
      if (game.game_over()) return;
      if (game.turn() !== "w") return;
      if (hintMove) { hintMove = null; render(); return; }
      const m = suggestPlayerMove(game);
      if (m) hintMove = { from: m.from, to: m.to };
      render();
    }

    let bound = false;
    function start() {
      boardEl       = document.getElementById("chess-board");
      statusEl      = document.getElementById("chess-status");
      historyEl     = document.getElementById("chess-history-list");
      capturedYouEl = document.getElementById("chess-captured-by-you");
      capturedCpuEl = document.getElementById("chess-captured-by-cpu");
      undoBtn       = document.getElementById("chess-undo");
      hintBtn       = document.getElementById("chess-hint");
      if (!boardEl) return;
      if (!bound) {
        document.getElementById("chess-new")?.addEventListener("click", newGame);
        undoBtn?.addEventListener("click", undoLastPair);
        hintBtn?.addEventListener("click", showHint);
        document.getElementById("chess-difficulty")?.addEventListener("change", (e) => {
          difficulty = e.target.value;
        });
        bound = true;
      }
      // (Re)build the board if empty (handles cold start + view changes).
      if (boardEl.children.length === 0) buildBoard();
      if (!game) newGame();
      else {
        render();
        // Watchdog: if we're returning to the pane and the position says
        // "black to move" with no AI thinking and the game isn't over,
        // the previous AI timer probably died (route change, tab swap,
        // soft reload, etc.). Kick a fresh AI move so the game doesn't
        // sit forever on "Computer's turn."
        if (game.turn() === "b" && !aiThinking && !game.game_over()) {
          scheduleAI();
        }
      }
    }
    function stop() {
      // Cancel any pending AI move so it doesn't fire after the user
      // navigated away. The watchdog re-arms on next start() / focus.
      if (aiTimerHandle) { clearTimeout(aiTimerHandle); aiTimerHandle = null; }
      aiThinking = false;
    }
    return { start, stop };
  })();

  // Honor deep-link URL params before the first load. The /billing page's
  // "Manage billing" link sends users here with ?view=settings&panel=billing
  // so they land directly on the Settings → Billing pane instead of the
  // raw Stripe Portal.
  (function applyInitialDeepLink() {
    try {
      const params = new URLSearchParams(window.location.search);
      const view = (params.get("view") || "").trim();
      const panel = (params.get("panel") || "").trim();
      if (!view) return;
      if (view === "settings") {
        if (panel === "billing" || panel === "profile" || panel === "api-keys" || panel === "team") {
          state.settingsMode = panel;
        }
      }
      switchView(view);
      // Strip the params from the address bar so refreshes don't re-trigger
      // and the URL stays clean.
      const clean = window.location.pathname + window.location.hash;
      window.history.replaceState({}, "", clean);
    } catch {
      // No-op — bad params shouldn't block the rest of the boot.
    }
  })();

  // Initial load
  loadAll().catch(e => toast("Failed to load: " + e.message, "error"));

})();


/* ===========================================================================
   POWER DIALER v3  (overlay on the Contacts table — window.PowerDialer)
   ===========================================================================
   The dedicated section is GONE. Now:
     1. ⚡ Power Dialer button in the Contacts toolbar opens a modal
     2. The modal explains Twilio + zero-markup + has Activate (lightning)
     3. Activate kicks off a session over the currently-visible contacts
     4. The Contacts table itself becomes the dialing UI — the current
        contact's row is highlighted purple, and a temporary action row
        is inserted directly beneath it (call button, outcomes, notes,
        skip/stop/prev). Other rows stay normal — no overlap.
=========================================================================== */
(function powerDialerOverlay() {
  // Bail early if the activator button isn't present (legacy templates).
  const activateBtn = document.getElementById("pd-activate-btn");
  if (!activateBtn) return;

  const $ = (id) => document.getElementById(id);

  // --- Keyboard mappings & outcome metadata --------------------------
  // Outcome string MUST match the backend's DIAL_OUTCOMES tuple — note
  // "callback_later" not "callback" (mismatch caused silent 400s and
  // notes never made it into the contact column).
  const KEY_OUTCOME = {
    "1": "no_answer",
    "2": "voicemail",
    "3": "gatekeeper",
    "4": "booked",
    "5": "not_interested",
    "6": "bad_number",
    "7": "wrong_person",
    "8": "callback_later",
  };
  // Inverse — outcome → key (for the kbd badge on each button)
  const OUTCOME_KEY = Object.fromEntries(Object.entries(KEY_OUTCOME).map(([k, v]) => [v, k]));
  // Full labels — outcome buttons auto-grow to fit content, so the long
  // ones ("Not Interested", "Wrong Person") sit comfortably.
  const OUTCOME_META = {
    no_answer:      { emoji: "🔕", label: "No Answer",      short: "No Answer"      },
    voicemail:      { emoji: "📨", label: "Voicemail",      short: "Voicemail"      },
    gatekeeper:     { emoji: "🛡️", label: "Gatekeeper",    short: "Gatekeeper"     },
    booked:         { emoji: "✅", label: "Booked",         short: "Booked"         },
    not_interested: { emoji: "🚫", label: "Not Interested", short: "Not Interested" },
    bad_number:     { emoji: "❌", label: "Bad Number",     short: "Bad Number"     },
    wrong_person:   { emoji: "👤", label: "Wrong Person",   short: "Wrong Person"   },
    callback_later: { emoji: "⏰", label: "Callback",       short: "Callback"       },
  };
  // Display order: 4 = green (booked) leads, 8 = blue (callback) is hot,
  // then the neutral / negative outcomes.
  const OUTCOME_ORDER = ["booked", "callback_later", "gatekeeper", "voicemail", "no_answer", "not_interested", "wrong_person", "bad_number"];

  // --- Session state -------------------------------------------------
  let session = null;          // { id, contactQueue:[ids], currentIndex }
  let outcomeByContactId = {}; // id → outcome string
  let uiState = "idle";        // "idle" | "ringing"
  let costThisSession = 0;     // cumulative est. USD spend
  let attemptStartTs = 0;      // ms when the most recent call started

  // --- Modal / button wiring ----------------------------------------
  activateBtn.addEventListener("click", () => openModal());

  $("pd-modal-close")?.addEventListener("click", () => closeModal());
  $("pd-modal-cancel")?.addEventListener("click", () => closeModal());

  document.addEventListener("click", (e) => {
    if (e.target?.id === "pd-modal") closeModal();
  });

  function openModal() {
    // If a session is already active, the button doubles as End Session.
    if (isActive()) { deactivate(); return; }

    const modal = $("pd-modal");
    if (!modal) return;
    refreshModalQueueInfo();
    refreshModalConfigStatus();
    refreshModalCallerIdForm();
    modal.classList.remove("hidden");
    // Trap focus on the Activate button so Space/Enter activates immediately.
    setTimeout(() => $("pd-modal-activate")?.focus(), 60);
  }

  function closeModal() {
    $("pd-modal")?.classList.add("hidden");
  }

  function refreshModalQueueInfo() {
    const ids = visibleDialableContactIds();
    $("pd-modal-queue-count").textContent = ids.length;
    $("pd-modal-queue-plural").textContent = ids.length === 1 ? "" : "s";
    const activate = $("pd-modal-activate");
    if (activate) activate.disabled = ids.length === 0;
    const sub = $("pd-modal-queue-sub");
    if (sub) {
      sub.textContent = ids.length === 0
        ? "No dialable contacts in your current view. Filter to a list with phone numbers, then re-open Power Dialer."
        : "Use the line-type and list filters in Contacts to narrow the queue before activating.";
    }
  }

  /**
   * Read the contact IDs currently visible in the Contacts table.
   * Respects all the user's filters & sort order.
   * Skips rows that have no phone number (those can't be dialed).
   *
   * We scan every <td> of each row for a phone-like string so we don't
   * care which column number "Phone" lives in — column order changes if
   * the user reorders columns or hides any.
   */
  function visibleDialableContactIds() {
    const tbody = document.querySelector("#contacts-table tbody");
    if (!tbody) return [];
    const ids = [];
    tbody.querySelectorAll("tr[data-id]").forEach((tr) => {
      const id = parseInt(tr.dataset.id, 10);
      if (!Number.isFinite(id)) return;
      // Look for any cell containing 7+ digits → that's a phone number.
      // Strip non-digits to handle "+1 (315) 732-9350" style formatting.
      const rowText = tr.textContent || "";
      const digits = rowText.replace(/[^\d]/g, "");
      if (digits.length < 7) return; // junk / placeholder / no phone
      ids.push(id);
    });
    return ids;
  }

  // --- Modal config dots --------------------------------------------
  // Green = configured. Red = missing. Grey only shows during the
  // ~100ms initial fetch before we hear from the server.
  async function refreshModalConfigStatus() {
    const tDot = $("pd-cfg-twilio-dot-modal");
    const pDot = $("pd-cfg-phone-dot-modal");
    const pLbl = $("pd-cfg-phone-label-modal");
    const tLbl = $("pd-cfg-twilio-label-modal");
    try {
      const r = await fetch("/api/dial/config-status", { credentials: "same-origin" });
      if (!r.ok) {
        if (tDot) { tDot.classList.remove("good"); tDot.classList.add("bad"); }
        if (pDot) { pDot.classList.remove("good"); pDot.classList.add("bad"); }
        return;
      }
      const j = await r.json();
      if (tDot) {
        tDot.classList.remove("good", "bad");
        tDot.classList.add(j.twilio_ready ? "good" : "bad");
      }
      if (pDot) {
        pDot.classList.remove("good", "bad");
        pDot.classList.add(j.phone_ready ? "good" : "bad");
      }
      if (pLbl) pLbl.textContent = j.phone_ready
        ? `Power Dial Phone · ${j.power_dial_phone || "set"}`
        : "Power Dial Phone (not set)";
      if (tLbl) tLbl.textContent = j.twilio_ready ? "Twilio credentials" : "Twilio credentials (not set)";
    } catch {
      if (tDot) { tDot.classList.remove("good"); tDot.classList.add("bad"); }
      if (pDot) { pDot.classList.remove("good"); pDot.classList.add("bad"); }
    }
  }

  // --- Inline Power Dial Phone form (mirrors Settings → API Keys) ---
  // The /api/me/caller-id endpoint is the same one Settings uses, so the
  // value stays in sync between both. After any save/remove we flush the
  // Twilio status cache and re-run refreshModalConfigStatus so the green
  // dot lights up the instant the number is set — no page reload needed.
  async function refreshModalCallerIdForm() {
    const statusEl = $("pd-modal-caller-id-status");
    const editBtn  = $("pd-modal-caller-id-edit-btn");
    const removeBtn = $("pd-modal-caller-id-remove-btn");
    const editPane = $("pd-modal-caller-id-edit");
    const input    = $("pd-modal-caller-id-input");
    if (!statusEl) return;
    statusEl.textContent = "Loading…";
    statusEl.className = "api-key-status";
    if (editPane) editPane.hidden = true;
    try {
      const r = await fetch("/api/me/caller-id", { credentials: "same-origin" });
      if (!r.ok) throw new Error();
      const j = await r.json();
      const set = !!j.caller_id;
      if (set) {
        statusEl.textContent = `Set · ${j.caller_id}`;
        statusEl.classList.add("good");
        if (editBtn) editBtn.textContent = "Replace";
        if (removeBtn) removeBtn.hidden = false;
        if (input) input.value = j.caller_id;
      } else {
        statusEl.textContent = j.fallback_phone
          ? `Not set · falling back to ${j.fallback_phone}`
          : "Not set";
        statusEl.classList.add("warn");
        if (editBtn) editBtn.textContent = "Set number";
        if (removeBtn) removeBtn.hidden = true;
        if (input) input.value = "";
      }
    } catch {
      statusEl.textContent = "Couldn't load";
      statusEl.classList.add("bad");
    }
  }

  $("pd-modal-caller-id-edit-btn")?.addEventListener("click", () => {
    const pane = $("pd-modal-caller-id-edit");
    if (pane) pane.hidden = false;
    setTimeout(() => $("pd-modal-caller-id-input")?.focus(), 30);
  });
  $("pd-modal-caller-id-cancel")?.addEventListener("click", () => {
    const pane = $("pd-modal-caller-id-edit");
    if (pane) pane.hidden = true;
  });
  $("pd-modal-caller-id-save")?.addEventListener("click", async () => {
    const input = $("pd-modal-caller-id-input");
    const v = (input?.value || "").trim();
    if (!v) { alert("Enter a phone number (e.g. +13135551234)."); return; }
    const saveBtn = $("pd-modal-caller-id-save");
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving…"; }
    try {
      // Backend uses PUT (not POST) for this endpoint — POST returns 405.
      const r = await fetch("/api/me/caller-id", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caller_id: v }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Save failed");
      // Live-update the dots + form
      _twilioStatusCache = null;
      await Promise.all([refreshModalConfigStatus(), refreshModalCallerIdForm()]);
    } catch (err) {
      alert(err.message || "Couldn't save that number.");
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Save"; }
    }
  });
  $("pd-modal-caller-id-remove-btn")?.addEventListener("click", async () => {
    if (!confirm("Remove your Power Dial caller ID? Will fall back to your profile phone.")) return;
    try {
      await fetch("/api/me/caller-id", { method: "DELETE", credentials: "same-origin" });
      _twilioStatusCache = null;
      await Promise.all([refreshModalConfigStatus(), refreshModalCallerIdForm()]);
    } catch {
      alert("Couldn't remove the number — try again.");
    }
  });

  // --- Activate button -----------------------------------------------
  $("pd-modal-activate")?.addEventListener("click", () => activate());

  async function activate() {
    const ids = visibleDialableContactIds();
    if (!ids.length) return;

    const btn = $("pd-modal-activate");
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="pd-bolt" aria-hidden="true">⚡</span> <span>Start</span>'; }

    try {
      const r = await fetch("/api/dial/start", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_ids: ids }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Failed to start session");
      // Backend shape: { session: { id, total, current_index, ... }, skipped_no_phone }
      const serverSession = j.session || {};
      const serverSessionId = serverSession.id;
      if (!serverSessionId) {
        throw new Error("Backend didn't return a session id — start payload: " + JSON.stringify(j).slice(0, 200));
      }
      session = {
        id: serverSessionId,
        contactQueue: ids.slice(),
        currentIndex: 0,
        startedAt: Date.now(),
        bookedCount: 0,
      };
      if (j.skipped_no_phone) {
        console.info(`Power Dialer: ${j.skipped_no_phone} contact(s) skipped (no phone).`);
      }
      outcomeByContactId = {};
      costThisSession = 0;
      uiState = "idle";
      // Flip the toolbar button into "live" mode so it doubles as End Session.
      activateBtn.setAttribute("data-pd-active", "1");
      activateBtn.querySelector(".btn-full").textContent = "End Session";
      activateBtn.title = "End the current Power Dialer session";
      // Show the live banner above the contacts table.
      showBanner();
      closeModal();
      // Decorate the contacts table.
      decorate();
      // Scroll the current contact's row into view.
      requestAnimationFrame(scrollCurrentRowIntoView);
    } catch (err) {
      alert(err.message || "Failed to start Power Dialer session.");
      if (btn) { btn.disabled = false; btn.innerHTML = '<span class="pd-bolt" aria-hidden="true">⚡</span> <span>Start</span>'; }
    }
  }

  function isActive() { return !!session; }

  async function deactivate() {
    if (!session) return cleanupUI();
    try {
      await fetch(`/api/dial/${session.id}/end`, {
        method: "POST",
        credentials: "same-origin",
      });
    } catch {}
    cleanupUI();
    // Refresh contacts so any per-call notes show up.
    if (typeof window.refreshContactsOnly === "function") {
      window.refreshContactsOnly();
    }
  }

  function cleanupUI() {
    session = null;
    outcomeByContactId = {};
    uiState = "idle";
    costThisSession = 0;
    activateBtn.removeAttribute("data-pd-active");
    activateBtn.querySelector(".btn-full").textContent = "Power Dialer";
    activateBtn.title = "Power Dialer — bridge-call through your contacts at speed";
    hideBanner();
    undecorate();
  }

  // --- Live banner ---------------------------------------------------
  // Spacer element kept around to reserve the banner's slot in the
  // layout while it's pinned. Created lazily.
  let _bannerSpacer = null;

  function showBanner() {
    const b = $("pd-banner");
    if (!b) return;
    b.hidden = false;
    // Put the banner in-flow at the top of #view-contacts so its natural
    // position sits between the topbar and the list-picker row.
    const view = document.getElementById("view-contacts");
    if (view && b.parentNode !== view) {
      view.insertBefore(b, view.firstChild);
    }
    // Ensure a spacer is in place RIGHT AFTER the banner — when we pin
    // the banner to fixed, the spacer takes over its layout slot so
    // nothing jumps up.
    if (!_bannerSpacer) {
      _bannerSpacer = document.createElement("div");
      _bannerSpacer.className = "pd-banner-spacer";
    }
    if (b.nextSibling !== _bannerSpacer) {
      b.parentNode.insertBefore(_bannerSpacer, b.nextSibling);
    }
    updateBanner();
    _installBannerScrollWatcher();
  }

  function hideBanner() {
    const b = $("pd-banner");
    if (b) {
      b.hidden = true;
      b.classList.remove("pd-banner-pinned");
    }
    if (_bannerSpacer) _bannerSpacer.classList.remove("pd-banner-spacer-on");
    _uninstallBannerScrollWatcher();
  }

  // --- Scroll-pin behavior ------------------------------------------
  // Banner starts in-flow. Once the user scrolls past it, we flip it
  // to position:fixed so it follows the viewport top. When they scroll
  // back up, we restore it. The spacer reserves its slot during the
  // pinned state so the table doesn't jump.
  let _bannerScrollFn = null;
  let _bannerNaturalTop = 0;
  function _installBannerScrollWatcher() {
    if (_bannerScrollFn) return;
    const b = $("pd-banner");
    if (!b) return;
    // Cache the banner's natural offsetTop while it's UNPINNED.
    _bannerNaturalTop = b.getBoundingClientRect().top + window.scrollY;
    _bannerScrollFn = () => {
      const b2 = $("pd-banner");
      if (!b2 || b2.hidden) return;
      const shouldPin = window.scrollY > _bannerNaturalTop - 14;
      const isPinned = b2.classList.contains("pd-banner-pinned");
      if (shouldPin && !isPinned) {
        // Re-measure spacer height BEFORE pinning so it matches exactly.
        if (_bannerSpacer) {
          _bannerSpacer.style.height = b2.offsetHeight + "px";
          _bannerSpacer.classList.add("pd-banner-spacer-on");
        }
        b2.classList.add("pd-banner-pinned");
      } else if (!shouldPin && isPinned) {
        b2.classList.remove("pd-banner-pinned");
        if (_bannerSpacer) {
          _bannerSpacer.classList.remove("pd-banner-spacer-on");
          _bannerSpacer.style.height = "";
        }
      }
    };
    window.addEventListener("scroll", _bannerScrollFn, { passive: true });
    window.addEventListener("resize", _bannerScrollFn, { passive: true });
    // Run once to catch already-scrolled state on session restart.
    requestAnimationFrame(_bannerScrollFn);
  }
  function _uninstallBannerScrollWatcher() {
    if (!_bannerScrollFn) return;
    window.removeEventListener("scroll", _bannerScrollFn);
    window.removeEventListener("resize", _bannerScrollFn);
    _bannerScrollFn = null;
  }

  function updateBanner() {
    if (!session) return;
    const total = session.contactQueue.length;
    const pos = Math.min(session.currentIndex + 1, total);
    $("pd-position").textContent = pos;
    $("pd-total").textContent = total;
    $("pd-progress-fill").style.width = `${Math.round((session.currentIndex / Math.max(1, total)) * 100)}%`;
    $("pd-cost-value").textContent = `$${costThisSession.toFixed(2)}`;
    // Title — show current list name if any
    const t = $("pd-banner-title");
    if (t) t.textContent = `Dialing ${total} contact${total === 1 ? "" : "s"}`;
  }

  // (Banner's End Session button removed — toolbar activator + ⏹ STOP cover it.)

  // --- Contacts table decoration ------------------------------------
  /**
   * Add the .pd-current-row highlight to the current contact's row
   * and insert a temporary <tr.pd-inline-action-row> directly beneath it
   * carrying the call/outcome/notes/transport controls.
   */
  function decorate() {
    if (!session) return;
    const tbody = document.querySelector("#contacts-table tbody");
    if (!tbody) return;

    // Remove any prior decoration first
    undecorateRowsOnly();

    const currentId = session.contactQueue[session.currentIndex];

    // Walk through queue to mark completed rows
    session.contactQueue.forEach((cid, idx) => {
      const tr = tbody.querySelector(`tr[data-id="${cid}"]`);
      if (!tr) return;
      if (idx < session.currentIndex) tr.classList.add("pd-completed-row");
      if (idx === session.currentIndex) tr.classList.add("pd-current-row");
    });

    const currentTr = tbody.querySelector(`tr[data-id="${currentId}"]`);
    if (!currentTr) return;

    // How many columns in the contacts table?
    const colCount = currentTr.querySelectorAll("td").length || 6;

    const actionRow = document.createElement("tr");
    actionRow.className = "pd-inline-action-row";
    actionRow.id = "pd-inline-action-row";
    actionRow.innerHTML = `<td colspan="${colCount}">${buildActionPanelHtml()}</td>`;

    currentTr.insertAdjacentElement("afterend", actionRow);

    // Restore any draft notes the user was typing for this contact
    const draftKey = `pd_notes_${session.id}_${currentId}`;
    const draft = sessionStorage.getItem(draftKey) || "";
    const ta = $("pd-inline-notes");
    if (ta) ta.value = draft;
    updateBanner();
  }

  function undecorate() {
    undecorateRowsOnly();
    document.getElementById("pd-inline-action-row")?.remove();
  }

  function undecorateRowsOnly() {
    document.querySelectorAll("#contacts-table tr.pd-current-row").forEach((tr) => tr.classList.remove("pd-current-row"));
    document.querySelectorAll("#contacts-table tr.pd-completed-row").forEach((tr) => tr.classList.remove("pd-completed-row"));
    document.getElementById("pd-inline-action-row")?.remove();
  }

  function scrollCurrentRowIntoView() {
    if (!session) return;
    const cid = session.contactQueue[session.currentIndex];
    const tr = document.querySelector(`#contacts-table tr[data-id="${cid}"]`);
    tr?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  /**
   * Build the HTML for the action panel that lives inside the inline row.
   * Vertical stack:
   *   1. Transport controls: PREV / CALL / SKIP / STOP
   *   2. 8-outcome single-row grid
   *   3. Notes textarea
   *   4. Keyboard hints
   */
  function buildActionPanelHtml() {
    const canGoPrevious = (session?.currentIndex ?? 0) > 0;
    const ringing = uiState === "ringing";

    const callBtn = ringing
      ? `<button type="button" class="pd-inline-transport pd-inline-call pd-inline-ringing" disabled>
           <span>📞 Ringing…</span>
         </button>`
      : `<button type="button" class="pd-inline-transport pd-inline-call" id="pd-call-btn">
           <span>📞 Call</span><span class="pd-call-kbd">Space</span>
         </button>`;

    const outcomes = OUTCOME_ORDER.map((oc) => {
      const meta = OUTCOME_META[oc];
      const k = OUTCOME_KEY[oc];
      // Numbers removed from the visible button (keyboard shortcut still works
      // via the global keydown listener). Icon sits to the LEFT of the label.
      return `<button type="button" class="pd-inline-outcome-btn" data-outcome="${oc}" title="${meta.label} (press ${k})">
        <span class="pd-oc-emoji">${meta.emoji}</span>
        <span class="pd-oc-label">${meta.short}</span>
      </button>`;
    }).join("");

    // Layout: ONE flex row with [Call] [⏮ PREV] [⏹ STOP] [⏭ NEXT] [8 outcomes...]
    // Stop button is always red. Outcomes are compact (icon + short label).
    // Wraps to multiple rows on narrow viewports.
    return `
      <div class="pd-inline-panel">
        <div class="pd-inline-controls">
          ${callBtn}
          <button type="button" class="pd-inline-transport pd-inline-prev" id="pd-prev-btn" ${canGoPrevious ? "" : "disabled"} title="Previous contact (← or ↑)">⏮</button>
          <button type="button" class="pd-inline-transport pd-inline-stop" id="pd-stop-btn" title="End session (Esc)">⏹</button>
          <button type="button" class="pd-inline-transport pd-inline-skip" id="pd-skip-btn" title="Skip (S, → or ↓)">⏭</button>
          <div class="pd-inline-divider" aria-hidden="true"></div>
          ${outcomes}
        </div>
        <textarea class="pd-inline-notes" id="pd-inline-notes" placeholder="Quick notes — what they said, follow-up, etc. (saved with the outcome)"></textarea>
        <div class="pd-inline-hint">
          <span><kbd>Space</kbd> Call</span>
          <span><kbd>1-8</kbd> Outcome</span>
          <span><kbd>← ↑</kbd> Prev</span>
          <span><kbd>→ ↓</kbd> Next</span>
          <span><kbd>Esc</kbd> End</span>
        </div>
      </div>`;
  }

  // --- Event delegation for the inline action row -------------------
  // CRITICAL: stopPropagation + preventDefault. Without these, the click
  // bubbles up to the Contacts table row delegation which opens the
  // contact-edit modal — and on macOS, clicking a tel: link in that
  // modal flow can hand off to FaceTime (which is what the user was
  // seeing: "it tries to dial from my computer").
  document.addEventListener("click", (e) => {
    if (!session) return;
    const t = e.target.closest("button");
    if (!t) return;
    if (!t.closest("#pd-inline-action-row")) return;
    e.stopPropagation();
    e.preventDefault();
    if (t.id === "pd-call-btn")  { placeCall(); return; }
    if (t.id === "pd-skip-btn")  { skipContact(); return; }
    if (t.id === "pd-stop-btn")  { deactivate(); return; }
    if (t.id === "pd-prev-btn")  { goPrevious(); return; }
    const oc = t.dataset.outcome;
    if (oc) recordOutcome(oc);
  }, true); // capture phase — beats other row-level handlers

  // Save notes draft as user types
  document.addEventListener("input", (e) => {
    if (!session) return;
    if (e.target?.id !== "pd-inline-notes") return;
    const cid = session.contactQueue[session.currentIndex];
    if (cid) sessionStorage.setItem(`pd_notes_${session.id}_${cid}`, e.target.value);
  });

  // --- Keyboard shortcuts -------------------------------------------
  // Esc always works (even from the notes textarea). Everything else
  // only fires when focus isn't in a text input.
  document.addEventListener("keydown", (e) => {
    if (!session) return;
    const inField = e.target.matches("input, textarea, select, [contenteditable=true]");
    if (e.key === "Escape") { e.preventDefault(); deactivate(); return; }
    if (inField) return;
    if (e.key === " " || e.code === "Space") { e.preventDefault(); if (uiState === "idle") placeCall(); return; }
    if (e.key.toLowerCase() === "s") { e.preventDefault(); skipContact(); return; }
    // Arrow keys: ← / ↑ = Previous, → / ↓ = Next (skip)
    if (e.key === "ArrowLeft"  || e.key === "ArrowUp")   { e.preventDefault(); goPrevious(); return; }
    if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); skipContact(); return; }
    const oc = KEY_OUTCOME[e.key];
    if (oc) { e.preventDefault(); recordOutcome(oc); }
  });

  // --- Call lifecycle ------------------------------------------------
  let _twilioStatusCache = null;
  async function ensureTwilioReady() {
    if (_twilioStatusCache) return _twilioStatusCache;
    try {
      const r = await fetch("/api/dial/config-status", { credentials: "same-origin" });
      if (!r.ok) {
        // Backend errored. Don't block the user — assume config IS ready
        // and let the actual /call endpoint return a clear error if not.
        _twilioStatusCache = { twilio_ready: true, phone_ready: true, _unknown: true };
      } else {
        _twilioStatusCache = await r.json();
      }
    } catch {
      _twilioStatusCache = { twilio_ready: true, phone_ready: true, _unknown: true };
    }
    return _twilioStatusCache;
  }

  async function placeCall() {
    if (!session) return;
    const cid = session.contactQueue[session.currentIndex];
    if (!cid) return;

    // Pre-flight: bail with a clear message if Twilio isn't wired up.
    // Without this the backend returns a 400, the user sees "nothing
    // happens" — and on some browsers a stray click handler had been
    // handing off to FaceTime/system dialer instead.
    const cfg = await ensureTwilioReady();
    if (!cfg.twilio_ready || !cfg.phone_ready) {
      const missing = [];
      if (!cfg.twilio_ready) missing.push("Twilio Account SID + Auth Token");
      if (!cfg.phone_ready)  missing.push("Power Dial Phone (your personal cell)");
      alert(
        `Power Dialer can't ring you — missing config:\n\n` +
        `  • ${missing.join("\n  • ")}\n\n` +
        `Open Settings → API Keys to add your Twilio credentials, then ` +
        `Settings → Profile to set your Power Dial Phone.`
      );
      return;
    }

    uiState = "ringing";
    decorate(); // re-render to show "Ringing…"
    attemptStartTs = Date.now();
    try {
      const r = await fetch(`/api/dial/${session.id}/call`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_id: cid }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || j.message || `Twilio rejected the call (HTTP ${r.status})`);
      // Stay in "ringing" — the user will press an outcome key when the call ends.
    } catch (err) {
      uiState = "idle";
      // Invalidate the cache so a fixed config gets picked up on retry.
      _twilioStatusCache = null;
      alert(
        (err.message || "Couldn't place that call.") +
        "\n\nCheck your Twilio config in Settings → API Keys, " +
        "and make sure your Twilio account has at least $20 loaded " +
        "(trial accounts can't bridge calls)."
      );
      decorate();
    }
  }

  async function recordOutcome(outcome) {
    if (!session) return;
    const cid = session.contactQueue[session.currentIndex];
    if (!cid) return;
    const notes = ($("pd-inline-notes")?.value || "").trim();
    const duration = uiState === "ringing"
      ? Math.max(1, Math.round((Date.now() - attemptStartTs) / 1000))
      : 0;

    outcomeByContactId[cid] = outcome;
    if (outcome === "booked") session.bookedCount = (session.bookedCount || 0) + 1;
    // Rough Twilio US bridge cost: $0.014/min × 2 legs
    if (duration > 0) {
      costThisSession += (duration / 60) * 0.014 * 2;
    }

    // Clean up note draft
    sessionStorage.removeItem(`pd_notes_${session.id}_${cid}`);

    let serverError = null;
    try {
      const r = await fetch(`/api/dial/${session.id}/outcome`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_id: cid, outcome, duration_sec: duration, notes }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        serverError = j.error || `HTTP ${r.status}`;
      }
    } catch (err) {
      serverError = err.message || "Network error";
    }
    if (serverError) {
      console.error("Power Dialer outcome failed:", serverError);
      alert(`Couldn't save outcome: ${serverError}\n\nThe call advanced but the note didn't sync.`);
    }

    // Refresh the contact row in-place so notes appear immediately
    if (typeof window.refreshContactsOnly === "function") {
      // Async — it'll trigger renderContacts which will re-call decorate()
      window.refreshContactsOnly();
    }

    // If the user just recorded an outcome on the LAST contact in the
    // queue, the session is naturally complete — show the summary and
    // end. Skip + Next still just clamp; only outcomes can trigger the
    // natural finish.
    if (session.currentIndex >= session.contactQueue.length - 1) {
      finishSession();
      return;
    }
    advance();
  }

  async function skipContact() {
    if (!session) return;
    const cid = session.contactQueue[session.currentIndex];
    if (!cid) return;
    sessionStorage.removeItem(`pd_notes_${session.id}_${cid}`);
    try {
      const r = await fetch(`/api/dial/${session.id}/outcome`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_id: cid, outcome: "skipped", duration_sec: 0, notes: "" }),
      });
      if (!r.ok) console.warn("Power Dialer skip failed:", r.status);
    } catch (err) {
      console.warn("Power Dialer skip network error:", err);
    }
    advance();
  }

  /**
   * Move to the next contact. CLAMPS at the last contact — pressing
   * Next (or Skip) at the bottom of the queue keeps you on the last
   * contact instead of falling off into a blank state. Natural
   * "queue completion" happens via recordOutcomeAndAdvance, which
   * knows to finishSession() after the LAST outcome is recorded.
   */
  function advance() {
    uiState = "idle";
    attemptStartTs = 0;
    if (!session) return;
    const last = session.contactQueue.length - 1;
    if (session.currentIndex >= last) {
      // Already on the last contact — clamp, just redecorate.
      session.currentIndex = last;
      decorate();
      return;
    }
    session.currentIndex += 1;
    decorate();
    requestAnimationFrame(scrollCurrentRowIntoView);
  }

  /**
   * Move to the previous contact. CLAMPS at index 0 — pressing
   * Previous at the top of the queue keeps you on the first
   * contact instead of going off-screen.
   *
   * Decrement is done SYNCHRONOUSLY before the fetch to prevent
   * a race: if the user double-taps Previous while the first fetch
   * is still awaiting, the second click used to see the stale
   * (not-yet-decremented) currentIndex, slip past the guard, and
   * push currentIndex into negative territory → contactQueue[-1]
   * = undefined → no row to highlight → UI vanished.
   */
  async function goPrevious() {
    if (!session) return;
    if (session.currentIndex <= 0) {
      // At the first contact already — clamp, redecorate as a no-op.
      session.currentIndex = 0;
      decorate();
      return;
    }
    session.currentIndex -= 1;
    const cid = session.contactQueue[session.currentIndex];
    if (cid) delete outcomeByContactId[cid];
    uiState = "idle";
    decorate();
    requestAnimationFrame(scrollCurrentRowIntoView);
    // Backend update is best-effort, fire and forget.
    try {
      await fetch(`/api/dial/${session.id}/previous`, {
        method: "POST",
        credentials: "same-origin",
      });
    } catch {}
  }

  async function finishSession() {
    if (!session) return;
    const total = session.contactQueue.length;
    const booked = session.bookedCount || 0;
    try {
      await fetch(`/api/dial/${session.id}/end`, {
        method: "POST",
        credentials: "same-origin",
      });
    } catch {}
    const elapsed = Math.round((Date.now() - session.startedAt) / 60000);
    cleanupUI();
    if (typeof window.refreshContactsOnly === "function") {
      window.refreshContactsOnly();
    }
    // Friendly summary toast
    setTimeout(() => {
      alert(`Session complete!\n\n${total} contacts dialed\n${booked} booked\n~${elapsed} minute${elapsed === 1 ? "" : "s"}\n$${costThisSession.toFixed(2)} Twilio spend`);
    }, 80);
  }

  // --- Exposed API ---------------------------------------------------
  window.PowerDialer = {
    isActive,
    openModal,
    activate,
    deactivate,
    // Called by renderContacts() after every render — re-applies the
    // current-row highlight + action row. Safe to call when no session.
    afterContactsRender() {
      if (!isActive()) return;
      decorate();
    },
  };
})();
