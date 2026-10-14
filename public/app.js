const state = {
  origin: null,
  locating: false,
  leg: { 1: null, 2: null },
  stops: { 1: [], 2: [] },
  stopTouched: { 1: false, 2: false },
  stopToken: { 1: 0, 2: 0 },
  suggest: [],
  activeLeg: null,
  highlight: 0,
  searchToken: { 1: 0, 2: 0 },
  planToken: 0,
  plan: null,
  selected: null,
  match: null,
  mode: "fastest",
  transferTouched: false,
  departureTouched: false,
};

let fillingControls = false;
let boardStopKey = "";
let boardToken = 0;

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

function placeSuggest(leg) {
  $(`field${leg}`).parentElement.appendChild($("suggest"));
}

function renderSuggest(routes, leg) {
  const list = $("suggest");
  placeSuggest(leg);
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
  placeSuggest(leg);
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
  state.stopTouched[leg] = false;
  if (leg === 1) state.departureTouched = false;
  renderChip(leg);
  const other = leg === 1 ? 2 : 1;
  if (!state.leg[other]) $(`q${other}`).focus();
  fillStops(leg).catch(() => {});
  schedulePlan();
}

function clearLeg(leg) {
  state.leg[leg] = null;
  state.stopTouched[leg] = false;
  if (leg === 1) state.departureTouched = false;
  state.stops[leg] = [];
  $(`q${leg}`).value = "";
  renderChip(leg);
  resetStopSelect(leg);
  hideSuggest();
  $(`q${leg}`).focus();
  schedulePlan();
}

function resetStopSelect(leg) {
  const select = $(`stop${leg}`);
  const label = $(`stopLabel${leg}`);
  select.innerHTML = `<option value="">用建議站</option>`;
  select.disabled = true;
  select.value = "";
  label.hidden = true;
  if (leg === 1) {
    boardStopKey = "";
    boardToken += 1;
    $("boardLabel").hidden = true;
    fillingControls = true;
    $("board1Eta").innerHTML = `<option value="">自動下一班</option>`;
    $("board1Eta").value = "";
    $("board1Eta").disabled = true;
    fillingControls = false;
  }
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
  state.stopTouched[1] = false;
  state.stopTouched[2] = false;
  state.departureTouched = false;
  renderChip(1);
  renderChip(2);
  fillStops(1).catch(() => {});
  fillStops(2).catch(() => {});
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
      : "輸入兩程路線，結果會自動出現。唔使定位都得。";
    return;
  }
  if (!step2StopChosen()) {
    $("status").textContent = "揀第二程落車站，先會出可轉車站。";
    return;
  }
  if (state.plan?.candidates?.length) {
    const located = state.origin ? "" : "未用定位。";
    $("status").textContent = `${located}可轉車站有 ${state.plan.candidates.length} 個，撳一下就用。`;
  }
}

function step2StopChosen() {
  return !!(state.leg[2] && state.stopTouched[2] && $("stop2").value);
}

function readyToPlan() {
  return !!(state.leg[1] && state.leg[2] && step2StopChosen());
}

function schedulePlan() {
  if (!readyToPlan()) {
    state.planToken += 1;
    state.plan = null;
    state.match = null;
    state.selected = null;
    state.transferTouched = false;
    hideTransfer();
    $("results").innerHTML = "";
    refreshStatus();
    return;
  }
  runPlan();
}

function preferredBoard1Eta() {
  if (!state.departureTouched) return null;
  return $("board1Eta").value || null;
}

function departureLabel(item) {
  const when = fmtTime(item.eta);
  if (!item.catchable) return `${when} · 可能趕唔切`;
  return `${when} · ${item.inMinutes} 分後`;
}

async function loadBoard1Departures() {
  const route = state.leg[1];
  const label = $("boardLabel");
  const select = $("board1Eta");
  if (!route) {
    boardStopKey = "";
    label.hidden = true;
    return;
  }
  const stopId = state.stopTouched[1] ? $("stop1").value || "" : "";
  const key = `${route.co}|${route.route}|${route.bound}|${route.serviceType}|${stopId}|${state.origin?.lat ?? ""}|${state.origin?.long ?? ""}`;
  if (key === boardStopKey && select.value && !select.disabled) return;
  boardStopKey = key;
  const token = ++boardToken;
  label.hidden = false;
  select.disabled = true;
  try {
    const data = await api("/api/board1-departures", {
      method: "POST",
      body: JSON.stringify({
        origin: state.origin,
        leg1: {
          co: route.co,
          route: route.route,
          bound: route.bound,
          serviceType: route.serviceType,
        },
        bufferMinutes: Number($("bufferMinutes").value || 1),
        preferredBoard1Eta: preferredBoard1Eta(),
        board1StopId: stopId || null,
      }),
    });
    if (token !== boardToken) return;
    renderBoard(data);
  } catch {
    if (token !== boardToken) return;
    select.disabled = false;
  }
}

async function runPlan() {
  if (!readyToPlan()) return;
  const token = ++state.planToken;
  state.transferTouched = false;
  hideTransfer();
  refreshStatus("搵緊可以轉車嘅站…");
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
        limit: 12,
        preferredBoard1Eta: preferredBoard1Eta(),
        board1StopId: state.stopTouched[1] ? $("stop1").value || null : null,
        alight2StopId: state.stopTouched[2] ? $("stop2").value || null : null,
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
  const departures = plan.board1Departures || [];
  const wanted = state.departureTouched && select.value ? select.value : plan.board1?.boardEta || "";
  fillingControls = true;
  select.innerHTML = departures.length
    ? departures.map((item) => `<option value="${escapeHtml(item.eta)}">${escapeHtml(departureLabel(item))}</option>`).join("")
    : `<option value="">暫時未有班次</option>`;
  if (wanted && [...select.options].some((option) => option.value === wanted)) {
    select.value = wanted;
  } else if (!departures.some((item) => item.eta === wanted)) {
    state.departureTouched = false;
  }
  select.disabled = !departures.length;
  $("boardLabel").hidden = false;
  fillingControls = false;
}

async function fillStops(leg, preferredId) {
  const route = state.leg[leg];
  const select = $(`stop${leg}`);
  const label = $(`stopLabel${leg}`);
  const token = ++state.stopToken[leg];
  if (!route) {
    resetStopSelect(leg);
    return;
  }
  const params = new URLSearchParams({
    co: route.co,
    route: route.route,
    bound: route.bound,
    serviceType: route.serviceType,
  });
  const { stops } = await api(`/api/stops?${params}`);
  if (token !== state.stopToken[leg] || state.leg[leg] !== route) return;
  state.stops[leg] = stops;
  const keep = state.stopTouched[leg] ? select.value : "";
  const next = preferredId || keep;
  fillingControls = true;
  select.innerHTML = `<option value="">用建議站</option>${stops
    .map((stop) => `<option value="${escapeHtml(stop.stopId)}">${stop.seq}. ${escapeHtml(stop.nameTc)}</option>`)
    .join("")}`;
  select.disabled = !stops.length;
  label.hidden = false;
  if (next && [...select.options].some((option) => option.value === next)) select.value = next;
  fillingControls = false;
  if (leg === 1) loadBoard1Departures().catch(() => {});
}

function etaMs(iso) {
  const ms = new Date(iso || "").getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

function chainIsPossible(board1Eta, leg1Eta, leg2Eta) {
  const alight = etaMs(leg1Eta);
  const second = etaMs(leg2Eta);
  if (!Number.isFinite(alight) || !Number.isFinite(second) || !(alight < second)) return false;
  const board = etaMs(board1Eta);
  if (Number.isFinite(board) && !(board < alight)) return false;
  return true;
}

async function runMatch(candidate) {
  const route1 = state.leg[1];
  const route2 = state.leg[2];
  const stop1 = candidate?.alight1?.stopId;
  const stop2 = candidate?.board2?.stopId;
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
      board1Eta: candidate.board1Eta,
      minRideMinutes: candidate.rideMinutes || 1,
    }),
  });
}

function minutesUntil(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round(ms / 60000));
}

function applyMatchToCandidate(candidate, match) {
  if (!candidate || !match) return;
  if (candidate.hasMatch && chainIsPossible(candidate.board1Eta, candidate.leg1Eta, candidate.leg2Eta)) return;
  const pair = (match.pairs || []).find(
    (item) => item.status !== "miss" && chainIsPossible(candidate.board1Eta, item.leg1Eta, item.leg2Eta),
  );
  candidate.timed = true;
  if (!pair) {
    const board = etaMs(candidate.board1Eta);
    const laterAlight = (match.leg1?.etas || []).some((item) => etaMs(item.eta) > board);
    candidate.etaState = laterAlight ? "no_second" : "pending";
    candidate.hasMatch = false;
    candidate.leg2Eta = null;
    candidate.readyAt = null;
    candidate.waitMinutes = null;
    candidate.gapMinutes = null;
    candidate.board2InMinutes = null;
    if (candidate.etaState !== "no_second") candidate.leg1Eta = null;
    candidate.scoreTc = candidate.etaState === "no_second" ? "第二程更遲班次未出。" : "呢班落車時間未出。";
    return;
  }
  candidate.etaState = "ok";
  candidate.hasMatch = true;
  candidate.leg1Estimated = !!pair.leg1Estimated;
  candidate.leg1Eta = pair.leg1Eta;
  candidate.leg2Eta = pair.leg2Eta;
  candidate.readyAt = pair.readyAt;
  candidate.waitMinutes = pair.waitMinutes;
  candidate.gapMinutes = pair.gapMinutes;
  candidate.board2InMinutes = minutesUntil(pair.leg2Eta);
}

async function applyCandidate(index, token = state.planToken) {
  const candidate = state.plan?.candidates?.[index];
  if (!candidate) return;
  state.selected = index;
  const prefer1 = state.stopTouched[1] ? $("stop1").value : state.plan.board1.stopId;
  const prefer2 = state.stopTouched[2] ? $("stop2").value : "";
  try {
    await Promise.all([
      fillStops(1, prefer1),
      fillStops(2, prefer2),
    ]);
  } catch {
    // The three closest buses can still be shown if the stop lists are busy.
  }
  if (token !== state.planToken) return;
  $("walkMinutes").value = String(candidate.walkMinutes);
  try {
    state.match = await runMatch(candidate);
    applyMatchToCandidate(candidate, state.match);
  } catch {
    state.match = null;
  }
  if (token !== state.planToken) return;
  renderTransferOptions();
  renderResults();
  refreshStatus();
}

function hideTransfer() {
  $("transferRow").hidden = true;
  $("transferList").innerHTML = "";
}

function transferParts(candidate) {
  const title = `落 ${candidate.alight1.nameTc} → ${candidate.walkMeters}m → 上 ${candidate.board2.nameTc}`;
  if (candidate.board2InMinutes != null && chainIsPossible(candidate.board1Eta, candidate.leg1Eta, candidate.leg2Eta)) {
    const ride = candidate.rideMinutes ? `行車約 ${candidate.rideMinutes} 分 · ` : "";
    return { title, meta: `${ride}${candidate.board2InMinutes} 分鐘後上第二程` };
  }
  if (candidate.etaState === "no_second") return { title, meta: "第二程更遲班次未出" };
  if (candidate.etaState === "pending" || candidate.timed) return { title, meta: "落車時間未出" };
  return { title, meta: "未計班次，撳一下先查時間" };
}

function renderTransferOptions() {
  const list = $("transferList");
  const row = $("transferRow");
  const candidates = state.plan?.candidates || [];
  if (!candidates.length || !step2StopChosen()) {
    hideTransfer();
    return;
  }
  row.hidden = false;
  list.innerHTML = candidates.map((candidate, index) => {
    const parts = transferParts(candidate);
    const selected = index === state.selected;
    return `<li><button type="button" class="${selected ? "is-on" : ""}" data-transfer="${index}" role="option" aria-selected="${selected}">
      <strong>${escapeHtml(parts.title)}</strong>
      <span>${escapeHtml(parts.meta)}</span>
    </button></li>`;
  }).join("");
}

function offStopName() {
  const id = $("stop2").value;
  if (!id) return "";
  return state.stops[2].find((stop) => stop.stopId === id)?.nameTc || "";
}

function matchBadge(candidate) {
  if (!chainIsPossible(candidate.board1Eta, candidate.leg1Eta, candidate.leg2Eta)) {
    if (candidate.etaState === "no_second") return { label: "等緊", cls: "tight" };
    if (candidate.etaState === "pending" || candidate.timed) return { label: "未出", cls: "" };
    return { label: "計緊", cls: "" };
  }
  if (candidate.waitMinutes != null && candidate.waitMinutes <= 2) return { label: "好逼", cls: "tight" };
  return { label: "可接", cls: "" };
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
  const ok = chainIsPossible(chosen.board1Eta, chosen.leg1Eta, chosen.leg2Eta);
  const badge = matchBadge(chosen);
  const minutes = ok ? chosen.board2InMinutes : null;
  const minuteCaption = ok
    ? "分鐘後上第二程"
    : chosen.etaState === "no_second"
      ? "第二程更遲班次未出"
      : chosen.etaState === "pending" || chosen.timed
        ? "落車時間未出"
        : "未有上車時間";
  const rideNote = chosen.rideMinutes ? `行車約 ${chosen.rideMinutes} 分 · ` : "";
  const detail = ok
    ? `${rideNote}${chosen.leg1Estimated ? "約 " : ""}${fmtTime(chosen.leg1Eta)} 落車 · ${fmtTime(chosen.readyAt)} 行到 · ${fmtTime(chosen.leg2Eta)} 上第二程`
    : chosen.etaState === "no_second"
      ? "見到落車時間，但第二程可見班次都早過你行到。更遲嗰班可能未入 ETA。"
      : chosen.etaState === "pending" || chosen.timed
        ? "呢班車嘅落車時間未出。ETA 通常只顯示最近幾班，唔代表接唔到。"
        : chosen.scoreTc;

  box.innerHTML = `
    ${modeButtons}
    <article class="card">
      <div class="card-top">
        <div class="mins">${minutes == null ? "—" : minutes}<span>${escapeHtml(minuteCaption)}</span></div>
        <span class="pill ${badge.cls}">${escapeHtml(badge.label)}</span>
      </div>
      <ol class="itinerary">
        <li class="leg">
          <span class="dot"></span>
          <div>
            <b>${escapeHtml(state.leg[1].route)}</b> ${fmtTime(chosen.board1Eta)} 上 ${escapeHtml(plan.board1.nameTc)}
            <small>${chosen.leg1Eta ? `${chosen.leg1Estimated ? "約 " : ""}${fmtTime(chosen.leg1Eta)} 落` : "落"} ${escapeHtml(chosen.alight1.nameTc)}${chosen.rideMinutes ? ` · 行車約 ${chosen.rideMinutes} 分` : ""}</small>
          </div>
        </li>
        <li class="walk">
          <span class="dot"></span>
          <div>步行 ${chosen.walkMeters}m · 約 ${chosen.walkMinutes} 分鐘</div>
        </li>
        <li class="leg">
          <span class="dot"></span>
          <div>
            <b>${escapeHtml(state.leg[2].route)}</b> ${ok ? `${fmtTime(chosen.leg2Eta)} 上` : "上"} ${escapeHtml(chosen.board2.nameTc)}
            ${offStopName() ? `<small>落 ${escapeHtml(offStopName())}</small>` : ""}
          </div>
        </li>
      </ol>
      <p class="match-line">${escapeHtml(detail)}</p>
    </article>
  `;
  wireModes();
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
      state.stopTouched[leg] = false;
      renderChip(leg);
      resetStopSelect(leg);
    }
    searchDebounced[leg]();
  });
  input.addEventListener("focus", () => {
    if (input.value.trim()) search(leg);
  });
  input.addEventListener("blur", () => {
    setTimeout(() => {
      if (suggestGesture) return;
      if (state.activeLeg === leg && document.activeElement !== input) hideSuggest();
    }, 400);
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
    if (state.leg[1]) loadBoard1Departures().catch(() => {});
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

function onStopChange() {
  if (fillingControls) return;
  schedulePlan();
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
    $("originSub").textContent = permission === "denied" ? geoErrorMessage({ code: 1 }) : "可選。唔使定位都搜到";
}

wireSearch(1);
wireSearch(2);

let suggestGesture = null;
$("suggest").addEventListener("pointerdown", (event) => {
  const button = event.target.closest("button[data-i]");
  suggestGesture = button
    ? { x: event.clientX, y: event.clientY, id: button.dataset.i, moved: false }
    : null;
});
$("suggest").addEventListener("pointermove", (event) => {
  if (!suggestGesture) return;
  if (Math.hypot(event.clientX - suggestGesture.x, event.clientY - suggestGesture.y) > 12) {
    suggestGesture.moved = true;
  }
});
$("suggest").addEventListener("pointercancel", () => {
  suggestGesture = null;
});
$("suggest").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-i]");
  const gesture = suggestGesture;
  suggestGesture = null;
  if (!button || state.activeLeg == null) return;
  if (gesture?.moved) return;
  pick(state.activeLeg, Number(button.dataset.i));
});
document.addEventListener("pointerdown", (event) => {
  const list = $("suggest");
  if (list.hidden) return;
  if (list.contains(event.target)) return;
  const leg = state.activeLeg;
  if (leg && event.target === $(`q${leg}`)) return;
  hideSuggest();
});

let transferGesture = null;
$("transferList").addEventListener("pointerdown", (event) => {
  const button = event.target.closest("button[data-transfer]");
  transferGesture = button
    ? { x: event.clientX, y: event.clientY, id: button.dataset.transfer, moved: false }
    : null;
});
$("transferList").addEventListener("pointermove", (event) => {
  if (!transferGesture) return;
  if (Math.hypot(event.clientX - transferGesture.x, event.clientY - transferGesture.y) > 12) {
    transferGesture.moved = true;
  }
});
$("transferList").addEventListener("pointercancel", () => {
  transferGesture = null;
});
$("swapBtn").addEventListener("click", swapLegs);
$("originBtn").addEventListener("click", locate);
$("board1Eta").addEventListener("change", () => {
  if (fillingControls) return;
  state.departureTouched = true;
  if (readyToPlan()) schedulePlan();
});
$("bufferMinutes").addEventListener("change", debounce(() => schedulePlan(), 250));
$("maxTransferMeters").addEventListener("change", debounce(() => schedulePlan(), 250));
$("walkMinutes").addEventListener("change", debounce(() => onStopChange(), 250));
$("stop1").addEventListener("change", () => {
  if (!fillingControls) {
    state.stopTouched[1] = true;
    state.departureTouched = false;
    fillingControls = true;
    $("board1Eta").value = "";
    fillingControls = false;
  }
  onStopChange();
  loadBoard1Departures().catch(() => {});
});
$("stop2").addEventListener("change", () => {
  if (!fillingControls) state.stopTouched[2] = true;
  onStopChange();
});
$("transferList").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-transfer]");
  const gesture = transferGesture;
  transferGesture = null;
  if (!button || !state.plan?.candidates?.length) return;
  if (!step2StopChosen()) return;
  if (gesture?.moved) return;
  state.transferTouched = true;
  applyCandidate(Number(button.dataset.transfer)).catch((err) => {
    $("results").innerHTML = `<div class="error">${escapeHtml(err.message)}</div>`;
  });
});

bootLocation();
refreshStatus();
