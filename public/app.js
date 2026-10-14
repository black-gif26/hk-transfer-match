const state = {
  origin: null,
  locating: false,
  leg: { 1: null, 2: null },
  stops: { 1: [], 2: [] },
  suggest: [],
  activeLeg: null,
  highlight: 0,
  searchToken: { 1: 0, 2: 0 },
  planToken: 0,
  plan: null,
  selected: null,
  match: null,
  mode: "fastest",
};

let fillingControls = false;

const $ = (id) => document.getElementById(id);

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function coName(co) {
  return co === "CTB" ? "城巴" : "九巴";
}

function fmtTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("zh-HK", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Hong_Kong",
  });
}

async function api(path, options) {
  const res = await fetch(path, {
    headers: {
      Accept: "application/json",
      ...(options?.body ? { "Content-Type": "application/json" } : {}),
    },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `請求失敗 ${res.status}`);
  return data;
}

function isIos() {
  const ua = navigator.userAgent || "";
  return /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function readPosition(highAccuracy) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(Object.assign(new Error("呢部機唔支援定位"), { code: 0 }));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: highAccuracy,
      timeout: highAccuracy ? 10000 : 8000,
      maximumAge: highAccuracy ? 15000 : 120000,
    });
  });
}

function geoErrorMessage(err) {
  if (!err) return "定位失敗";
  if (!window.isSecureContext) return "用 https 開啟先可以定位。";
  if (err.code === 1) {
    return isIos()
      ? "未允許位置。去 設定 > Safari > 位置，改做「允許」。"
      : "未授權位置。撳一下再允許。";
  }
  if (err.code === 2) return "暫時拎唔到位置，撳一下再試。";
  if (err.code === 3) return "定位逾時，撳一下再試。";
  return err.message || "定位失敗";
}

function hideSuggest() {
  $("suggest").hidden = true;
  $("suggest").innerHTML = "";
  state.suggest = [];
  state.activeLeg = null;
}

function renderChip(leg) {
  const route = state.leg[leg];
  const chip = $(`chip${leg}`);
  const input = $(`q${leg}`);
  const clear = $(`clear${leg}`);
  if (!route) {
    chip.hidden = true;
    chip.innerHTML = "";
    input.hidden = false;
    clear.hidden = true;
    return;
  }
  input.hidden = true;
  input.value = "";
  clear.hidden = false;
  chip.hidden = false;
  const special = route.serviceType !== "1" ? ` · 特別班 ${route.serviceType}` : "";
  chip.innerHTML = `
    <span class="no">${escapeHtml(route.route)}</span>
    <span class="dir-text">
      <strong>往 ${escapeHtml(route.destTc)}</strong>
      <small>${coName(route.co)} · ${escapeHtml(route.origTc)}開出${escapeHtml(special)}</small>
    </span>
  `;
}

function paintHighlight() {
  $("suggest").querySelectorAll("button").forEach((button, index) => {
    button.classList.toggle("is-on", index === state.highlight);
  });
}

function renderSuggest(routes, leg) {
  const list = $("suggest");
  state.activeLeg = leg;
  state.suggest = routes;
  state.highlight = 0;
  list.hidden = false;
  if (!routes.length) {
    list.innerHTML = `<li class="empty">搵唔到呢條路線</li>`;
    return;
  }
  list.innerHTML = routes
    .map((route, index) => {
      const special = route.serviceType !== "1" ? ` · 特別班 ${route.serviceType}` : "";
      return `
        <li>
          <button type="button" role="option" data-i="${index}" class="${index === 0 ? "is-on" : ""}">
            <span class="no">${escapeHtml(route.route)}</span>
            <span class="text">
              <strong>往 ${escapeHtml(route.destTc)}</strong>
              <small>${coName(route.co)} · ${escapeHtml(route.origTc)}開出${escapeHtml(special)}</small>
            </span>
          </button>
        </li>
      `;
    })
    .join("");
}

async function search(leg) {
  const query = $(`q${leg}`).value.trim();
  const token = ++state.searchToken[leg];
  if (!query) {
    if (state.activeLeg === leg) hideSuggest();
    return;
  }
  $("suggest").hidden = false;
  $("suggest").innerHTML = `<li class="empty">搜尋中…</li>`;
  state.activeLeg = leg;
  try {
    const data = await api(`/api/routes?q=${encodeURIComponent(query)}&limit=8`);
    if (token !== state.searchToken[leg]) return;
    if (document.activeElement !== $(`q${leg}`)) return;
    renderSuggest(data.routes || [], leg);
  } catch (err) {
    if (token !== state.searchToken[leg]) return;
    $("suggest").hidden = false;
    $("suggest").innerHTML = `<li class="empty">${escapeHtml(err.message)}</li>`;
  }
}

const searchDebounced = {
  1: debounce(() => search(1), 220),
  2: debounce(() => search(2), 220),
};

function pick(leg, index) {
  const route = state.suggest[index];
  if (!route) return;
  state.leg[leg] = route;
  hideSuggest();
  renderChip(leg);
  const other = leg === 1 ? 2 : 1;
  if (!state.leg[other]) $(`q${other}`).focus();
  schedulePlan();
}

function clearLeg(leg) {
  state.leg[leg] = null;
  $(`q${leg}`).value = "";
  renderChip(leg);
  hideSuggest();
  $(`q${leg}`).focus();
  schedulePlan();
}

function swapLegs() {
  const previous = state.leg[1];
  state.leg[1] = state.leg[2];
  state.leg[2] = previous;
  const first = $("q1").value;
  const second = $("q2").value;
  $("q1").value = state.leg[1] ? "" : second;
  $("q2").value = state.leg[2] ? "" : first;
  hideSuggest();
  renderChip(1);
  renderChip(2);
  schedulePlan();
}

function refreshStatus(message) {
  if (message) {
    $("status").textContent = message;
    return;
  }
  if (!state.leg[1] || !state.leg[2]) {
    $("status").textContent = state.leg[1] || state.leg[2]
      ? "再揀另一程路線。"
      : "輸入兩程路線，結果會自動出現。";
    return;
  }
  if (!state.origin) {
    $("status").textContent = "兩程已揀好。撳「用我的位置」，結果就會自動出。";
    return;
  }
  if (state.plan?.candidates?.length) {
    $("status").textContent = `已列出最接近的 ${state.plan.candidates.length} 班車。`;
  }
}

function readyToPlan() {
  return !!(state.origin && state.leg[1] && state.leg[2]);
}

function schedulePlan() {
  if (!readyToPlan()) {
    state.planToken += 1;
    state.plan = null;
    state.match = null;
    state.selected = null;
    $("results").innerHTML = "";
    refreshStatus();
    return;
  }
  runPlan();
}

function preferredBoard1Eta() {
  return $("board1Eta").value || null;
}

async function runPlan() {
  if (!readyToPlan()) return;
  const token = ++state.planToken;
  refreshStatus("搵緊最接近的 3 班車…");
  $("results").innerHTML = `<p class="loading">搵緊轉乘…</p>`;
  const legPayload = (leg) => ({
    co: leg.co,
    route: leg.route,
    bound: leg.bound,
    serviceType: leg.serviceType,
  });
  try {
    const plan = await api("/api/plan-transfer", {
      method: "POST",
      body: JSON.stringify({
        origin: state.origin,
        leg1: legPayload(state.leg[1]),
        leg2: legPayload(state.leg[2]),
        mode: state.mode,
        maxTransferMeters: Number($("maxTransferMeters").value || 450),
        bufferMinutes: Number($("bufferMinutes").value || 1),
        limit: 3,
        preferredBoard1Eta: preferredBoard1Eta(),
      }),
    });
    if (token !== state.planToken) return;
    state.plan = plan;
    state.match = null;
    renderBoard(plan);
    if (!plan.candidates.length) {
      state.selected = null;
      renderResults();
      refreshStatus(plan.summaryTc);
      return;
    }
    const firstGood = plan.candidates.findIndex((candidate) => candidate.hasMatch);
    await applyCandidate(firstGood >= 0 ? firstGood : 0, token);
  } catch (err) {
    if (token !== state.planToken) return;
    state.plan = null;
    $("results").innerHTML = `<div class="error">${escapeHtml(err.message)}</div>`;
    refreshStatus();
  }
}

function renderBoard(plan) {
  const select = $("board1Eta");
  const current = select.value;
  const departures = plan.board1Departures || [];
  fillingControls = true;
  select.innerHTML = `<option value="">自動下一班</option>${departures
    .map((item) => `<option value="${escapeHtml(item.eta)}">${escapeHtml(item.labelTc)}</option>`)
    .join("")}`;
  if (current && [...select.options].some((option) => option.value === current)) {
    select.value = current;
  }
  fillingControls = false;
}

async function fillStops(leg, preferredId) {
  const route = state.leg[leg];
  const select = $(`stop${leg}`);
  if (!route) {
    select.innerHTML = `<option value="">用建議站</option>`;
    select.disabled = true;
    return;
  }
  const params = new URLSearchParams({
    co: route.co,
    route: route.route,
    bound: route.bound,
    serviceType: route.serviceType,
  });
  const { stops } = await api(`/api/stops?${params}`);
  state.stops[leg] = stops;
  fillingControls = true;
  select.innerHTML = stops
    .map((stop) => `<option value="${escapeHtml(stop.stopId)}">${stop.seq}. ${escapeHtml(stop.nameTc)}</option>`)
    .join("");
  select.disabled = !stops.length;
  if (preferredId && stops.some((stop) => stop.stopId === preferredId)) select.value = preferredId;
  fillingControls = false;
}

async function runMatch() {
  const route1 = state.leg[1];
  const route2 = state.leg[2];
  const stop1 = $("stop1").value;
  const stop2 = $("stop2").value;
  if (!route1 || !route2 || !stop1 || !stop2) return null;
  const walkRaw = $("walkMinutes").value;
  const bufferRaw = $("bufferMinutes").value;
  return api("/api/match", {
    method: "POST",
    body: JSON.stringify({
      leg1: {
        co: route1.co,
        route: route1.route,
        bound: route1.bound,
        serviceType: route1.serviceType,
        stopId: stop1,
      },
      leg2: {
        co: route2.co,
        route: route2.route,
        bound: route2.bound,
        serviceType: route2.serviceType,
        stopId: stop2,
      },
      walkMinutes: walkRaw === "" ? null : Number(walkRaw),
      bufferMinutes: bufferRaw === "" ? 1 : Number(bufferRaw),
    }),
  });
}

async function applyCandidate(index, token = state.planToken) {
  const candidate = state.plan?.candidates?.[index];
  if (!candidate) return;
  state.selected = index;
  try {
    await Promise.all([
      fillStops(1, candidate.alight1.stopId),
      fillStops(2, candidate.board2.stopId),
    ]);
  } catch {
    // The three closest buses can still be shown if the stop lists are busy.
  }
  if (token !== state.planToken) return;
  $("walkMinutes").value = String(candidate.walkMinutes);
  try {
    state.match = await runMatch();
  } catch {
    state.match = null;
  }
  if (token !== state.planToken) return;
  renderResults();
  refreshStatus();
}

function matchBadge() {
  const pair = state.match?.pairs?.find((item) => item.status !== "miss") || state.match?.pairs?.[0];
  if (!pair) return { label: "計緊", cls: "" };
  if (pair.status === "miss") return { label: pair.statusTc || "接唔到", cls: "miss" };
  if (pair.status === "tight") return { label: pair.statusTc || "好逼", cls: "tight" };
  return { label: pair.statusTc || "可接", cls: "" };
}

function renderResults() {
  const plan = state.plan;
  const box = $("results");
  if (!plan) {
    box.innerHTML = "";
    return;
  }
  const modeButtons = `
    <div class="filters" role="radiogroup" aria-label="轉乘排序">
      <button type="button" data-mode="fastest" class="${state.mode === "fastest" ? "is-on" : ""}">最早上車</button>
      <button type="button" data-mode="shortest_walk" class="${state.mode === "shortest_walk" ? "is-on" : ""}">最少步行</button>
    </div>
  `;
  if (!plan.candidates.length) {
    box.innerHTML = `${modeButtons}<div class="error">${escapeHtml(plan.summaryTc)}</div>`;
    wireModes();
    return;
  }

  const selected = state.selected ?? 0;
  const chosen = plan.candidates[selected];
  const badge = chosen.hasMatch ? matchBadge() : { label: "未接", cls: "miss" };
  const minutes = chosen.board2InMinutes;
  const pair = state.match?.pairs?.find((item) => item.status !== "miss") || state.match?.pairs?.[0];
  const detail = pair
    ? `${fmtTime(pair.leg1Eta)} 落車 · ${fmtTime(pair.readyAt)} 行到 · ${pair.leg2Eta ? fmtTime(pair.leg2Eta) : "—"} 上第二程`
    : chosen.scoreTc;

  const alts = plan.candidates
    .map((candidate, index) => {
      if (index === selected) return "";
      const when = candidate.board2InMinutes == null ? "未有時間" : `${candidate.board2InMinutes} 分鐘後`;
      return `
        <button type="button" class="alt" data-pick="${index}">
          <strong>${when} · ${candidate.hasMatch ? "可接" : "未接"}</strong>
          <span>落 ${escapeHtml(candidate.alight1.nameTc)} → 步行 ${candidate.walkMeters}m → 上 ${escapeHtml(candidate.board2.nameTc)}</span>
        </button>
      `;
    })
    .join("");

  box.innerHTML = `
    ${modeButtons}
    <article class="card">
      <div class="card-top">
        <div class="mins">${minutes == null ? "—" : minutes}<span>${minutes == null ? "未有上車時間" : "分鐘後上第二程"}</span></div>
        <span class="pill ${badge.cls}">${escapeHtml(badge.label)}</span>
      </div>
      <ol class="itinerary">
        <li class="leg">
          <span class="dot"></span>
          <div>
            <b>${escapeHtml(state.leg[1].route)}</b> ${fmtTime(chosen.board1Eta)} 上 ${escapeHtml(plan.board1.nameTc)}
            <small>${fmtTime(chosen.leg1Eta)} 落 ${escapeHtml(chosen.alight1.nameTc)}</small>
          </div>
        </li>
        <li class="walk">
          <span class="dot"></span>
          <div>步行 ${chosen.walkMeters}m · 約 ${chosen.walkMinutes} 分鐘</div>
        </li>
        <li class="leg">
          <span class="dot"></span>
          <div>
            <b>${escapeHtml(state.leg[2].route)}</b> ${fmtTime(chosen.leg2Eta)} 上 ${escapeHtml(chosen.board2.nameTc)}
          </div>
        </li>
      </ol>
      <p class="match-line">${escapeHtml(detail)}</p>
    </article>
    <div class="alts">${alts}</div>
  `;
  wireModes();
  box.querySelectorAll("[data-pick]").forEach((button) => {
    button.addEventListener("click", () => {
      applyCandidate(Number(button.dataset.pick)).catch((err) => {
        box.innerHTML = `<div class="error">${escapeHtml(err.message)}</div>`;
      });
    });
  });
}

function wireModes() {
  $("results").querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      const mode = button.dataset.mode;
      if (!mode || mode === state.mode) return;
      state.mode = mode;
      schedulePlan();
    });
  });
}

function wireSearch(leg) {
  const input = $(`q${leg}`);
  input.addEventListener("input", () => {
    if (state.leg[leg]) {
      state.leg[leg] = null;
      renderChip(leg);
    }
    searchDebounced[leg]();
  });
  input.addEventListener("focus", () => {
    if (input.value.trim()) search(leg);
    setTimeout(() => {
      input.closest(".sheet")?.scrollIntoView({ block: "start", behavior: "smooth" });
    }, 280);
  });
  input.addEventListener("blur", () => {
    setTimeout(() => {
      if (state.activeLeg === leg && document.activeElement !== input) hideSuggest();
    }, 150);
  });
  input.addEventListener("keydown", (event) => {
    const open = ! $("suggest").hidden && state.activeLeg === leg && state.suggest.length > 0;
    if (event.key === "ArrowDown" && open) {
      event.preventDefault();
      state.highlight = Math.min(state.suggest.length - 1, state.highlight + 1);
      paintHighlight();
    } else if (event.key === "ArrowUp" && open) {
      event.preventDefault();
      state.highlight = Math.max(0, state.highlight - 1);
      paintHighlight();
    } else if (event.key === "Enter" && open) {
      event.preventDefault();
      pick(leg, state.highlight);
    } else if (event.key === "Escape") {
      hideSuggest();
    }
  });
  $(`clear${leg}`).addEventListener("click", () => clearLeg(leg));
}

async function locate() {
  if (state.locating) return;
  if (!window.isSecureContext) {
    $("originLabel").textContent = "用我的位置";
    $("originSub").textContent = geoErrorMessage({});
    return;
  }
  state.locating = true;
  $("originLabel").textContent = "定位中…";
  $("originSub").textContent = "等緊你個位置";
  $("originBtn").classList.remove("is-ok");
  try {
    let pos;
    try {
      pos = await readPosition(false);
    } catch (err) {
      if (err?.code === 1) throw err;
      pos = await readPosition(true);
    }
    state.origin = { lat: pos.coords.latitude, long: pos.coords.longitude };
    $("originLabel").textContent = "我的位置";
    $("originSub").textContent = "已定位 · 撳一下更新";
    $("originBtn").classList.add("is-ok");
    if (state.leg[1] && state.leg[2]) schedulePlan();
    else refreshStatus();
  } catch (err) {
    state.origin = null;
    $("originLabel").textContent = "用我的位置";
    $("originSub").textContent = geoErrorMessage(err);
    refreshStatus();
  } finally {
    state.locating = false;
  }
}

async function onStopChange() {
  if (fillingControls || state.selected == null) return;
  try {
    state.match = await runMatch();
    renderResults();
  } catch (err) {
    $("results").innerHTML = `<div class="error">${escapeHtml(err.message)}</div>`;
  }
}

async function bootLocation() {
  if (!window.isSecureContext) {
    $("originSub").textContent = "用 https 開啟先可以定位。";
    return;
  }
  let permission = "prompt";
  try {
    const result = await navigator.permissions.query({ name: "geolocation" });
    permission = result.state;
  } catch {
    permission = isIos() ? "prompt" : "unknown";
  }
  if (permission === "granted" || (!isIos() && permission !== "denied")) {
    locate();
    return;
  }
  $("originSub").textContent = permission === "denied" ? geoErrorMessage({ code: 1 }) : "撳一下允許定位";
}

wireSearch(1);
wireSearch(2);
$("suggest").addEventListener("pointerdown", (event) => {
  const button = event.target.closest("button[data-i]");
  if (!button || state.activeLeg == null) return;
  event.preventDefault();
  pick(state.activeLeg, Number(button.dataset.i));
});
$("swapBtn").addEventListener("click", swapLegs);
$("originBtn").addEventListener("click", locate);
$("board1Eta").addEventListener("change", () => {
  if (!fillingControls) schedulePlan();
});
$("bufferMinutes").addEventListener("change", debounce(() => schedulePlan(), 250));
$("maxTransferMeters").addEventListener("change", debounce(() => schedulePlan(), 250));
$("walkMinutes").addEventListener("change", debounce(() => onStopChange(), 250));
$("stop1").addEventListener("change", onStopChange);
$("stop2").addEventListener("change", onStopChange);

bootLocation();
refreshStatus();
