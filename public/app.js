import {
  parseRouteValue,
  sameRoute,
  canShowConfirmedJourney,
  shouldApplyResponse,
  canPlanWith,
  geoErrorMessage,
  TIMING_LABEL,
} from "./state-helpers.js";

const state = {
  1: { routes: [], stops: [] },
  2: { routes: [], stops: [] },
  origin: null,
  locateAttempted: false,
  plan: null,
  selectedCandidateIndex: null,
  board1: null,
  board1Departures: [],
  board1TimingStatus: null,
  board1TimingStatusTc: null,
  lastTimingUpdatedAt: null,
  timingRefreshing: false,
  timingStale: false,
  timingError: null,
};

/** Per-stream generation tokens — ignore stale responses. */
const gens = {
  routes1: 0,
  routes2: 0,
  stops1: 0,
  stops2: 0,
  board1: 0,
  plan: 0,
  candidate: 0,
  refresh: 0,
};

const controllers = {
  routes1: null,
  routes2: null,
  stops1: null,
  stops2: null,
  board1: null,
  plan: null,
  refresh: null,
};

const $ = (id) => document.getElementById(id);

const MODE_HINTS = {
  shortest_walk: "優先轉車兩站直線距離最短（唔代表可行人路）。",
  fastest: "由出發地計到第二程最早上車時間（唔係終點到達）。",
  manual: "列出可揀站，你自己決定；可開進階睇附近站。",
};

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function abortAndStart(key) {
  if (controllers[key]) {
    try {
      controllers[key].abort();
    } catch {
      /* ignore */
    }
  }
  controllers[key] = new AbortController();
  return controllers[key];
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

function fmtUpdated(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("zh-HK", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "Asia/Hong_Kong",
  });
}

function selectedMode() {
  return document.querySelector('input[name="planMode"]:checked')?.value || "shortest_walk";
}

function boardingInputMode() {
  return (
    document.querySelector('input[name="boardingInputMode"]:checked')?.value || "manual_stop"
  );
}

function board1Mode() {
  return document.querySelector('input[name="board1Mode"]:checked')?.value || "auto";
}

function preferredBoard1Eta() {
  if (board1Mode() !== "manual") return null;
  return $("board1Eta").value || null;
}

function parseBoardStopValue(raw) {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (v?.stopId != null && v?.seq != null) {
      return { stopId: String(v.stopId), seq: Number(v.seq) };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function selectedBoardStop() {
  return parseBoardStopValue($("boardStop1")?.value);
}

function minutesToBoardStopValue() {
  const raw = $("minutesToBoardStop")?.value;
  if (raw === "" || raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function boardingPayload() {
  const mode = boardingInputMode();
  if (mode === "manual_stop") {
    const stop = selectedBoardStop();
    return {
      boardingMode: "manual_stop",
      boardStopId: stop?.stopId ?? null,
      boardStopSeq: stop?.seq ?? null,
      minutesToBoardStop: minutesToBoardStopValue(),
    };
  }
  return {
    boardingMode: "location",
    origin: state.origin ? { ...state.origin } : null,
  };
}

function syncBoardingPanels() {
  const mode = boardingInputMode();
  const loc = mode === "location";
  $("locationPanel").hidden = !loc;
  $("manualBoardPanel").hidden = loc;
}

function clearPlanDependentState(reason) {
  state.plan = null;
  state.selectedCandidateIndex = null;
  state.timingStale = false;
  state.timingError = null;
  state.lastTimingUpdatedAt = null;
  const box = $("output");
  if (reason) {
    box.replaceChildren(el("div", { className: "hint", text: reason }));
  } else {
    box.replaceChildren();
  }
}

function setStep(n) {
  document.querySelectorAll(".step").forEach((elStep) => {
    const s = Number(elStep.dataset.step);
    elStep.classList.toggle("is-current", s === n);
    elStep.classList.toggle("is-done", s < n);
  });
  const hasRoute1 = !!parseRouteValue($("route1").value);
  const boardingReady =
    boardingInputMode() === "manual_stop"
      ? !!selectedBoardStop()
      : !!state.origin;
  $("cardOrigin").classList.toggle("is-ready", boardingReady);
  $("cardRoutes").classList.toggle("is-dim", false);
  $("cardRoutes").classList.toggle("is-ready", true);
  $("cardBoard1").classList.toggle("is-dim", !hasRoute1);
  $("cardBoard1").classList.toggle("is-ready", hasRoute1);
  $("cardPlan").classList.toggle("is-dim", !canPlan());
  $("cardPlan").classList.toggle("is-ready", canPlan());
}

function canPlan() {
  const stop = selectedBoardStop();
  return canPlanWith({
    boardingMode: boardingInputMode(),
    origin: state.origin,
    boardStopId: stop?.stopId ?? null,
    boardStopSeq: stop?.seq ?? null,
    leg1: parseRouteValue($("route1").value),
    leg2: parseRouteValue($("route2").value),
  });
}

function refreshSticky() {
  const btn = $("planBtn");
  const hasRoutes =
    !!parseRouteValue($("route1").value) && !!parseRouteValue($("route2").value);
  const mode = boardingInputMode();

  if (!hasRoutes) {
    $("stickyHint").textContent = "先揀兩程路線同方向";
    btn.disabled = true;
    btn.textContent = "開始搵轉乘";
    setStep(2);
    return;
  }

  if (mode === "location" && !state.origin) {
    $("stickyHint").textContent = "可用目前位置，或改用自行選擇上車站";
    btn.disabled = true;
    btn.textContent = "開始搵轉乘";
    setStep(1);
    return;
  }

  if (mode === "manual_stop" && !selectedBoardStop()) {
    $("stickyHint").textContent = "再揀第一程上車站";
    btn.disabled = true;
    btn.textContent = "開始搵轉乘";
    setStep(1);
    return;
  }

  $("stickyHint").textContent = "可以開始搵轉乘建議";
  btn.disabled = false;
  btn.textContent = "開始搵轉乘";
  setStep(3);
}

/** Safe element helper — never interpolates untrusted strings into HTML. */
function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.id) node.id = opts.id;
  if (opts.text != null) node.textContent = opts.text;
  if (opts.html != null) node.innerHTML = opts.html; // only for static trusted fragments
  if (opts.title) node.title = opts.title;
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) {
      if (v == null) continue;
      node.setAttribute(k, String(v));
    }
  }
  if (opts.on) {
    for (const [ev, fn] of Object.entries(opts.on)) {
      node.addEventListener(ev, fn);
    }
  }
  for (const child of children) {
    if (child == null) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function clearSelect(select, placeholder, disabled = true) {
  select.replaceChildren();
  if (placeholder != null) {
    const opt = new Option(placeholder, "");
    select.append(opt);
  }
  select.disabled = disabled;
}

function fillSelectOptions(select, items, toOption) {
  select.replaceChildren();
  for (const item of items) {
    const { value, label, selected } = toOption(item);
    const opt = new Option(label, value);
    if (selected) opt.selected = true;
    select.append(opt);
  }
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: {
      Accept: "application/json",
      ...(options?.body ? { "Content-Type": "application/json" } : {}),
    },
    ...options,
  });
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`請求失敗 ${res.status}`);
  }
  if (!res.ok) throw new Error(data.error || `請求失敗 ${res.status}`);
  return data;
}

function syncVisibleStops(leg) {
  const hidden = $(`stop${leg}`);
  const visible = $(`stop${leg}Visible`);
  visible.replaceChildren();
  for (const opt of hidden.options) {
    visible.append(new Option(opt.textContent, opt.value, false, opt.selected));
  }
  visible.disabled = hidden.disabled || !hidden.options.length;
  visible.value = hidden.value;
}

function planInputSnapshot() {
  const boarding = boardingPayload();
  const stop = selectedBoardStop();
  return {
    boardingMode: boarding.boardingMode,
    origin: boarding.origin ?? null,
    boardStopId: boarding.boardStopId ?? stop?.stopId ?? null,
    boardStopSeq: boarding.boardStopSeq ?? stop?.seq ?? null,
    minutesToBoardStop: boarding.minutesToBoardStop ?? null,
    leg1: parseRouteValue($("route1").value),
    leg2: parseRouteValue($("route2").value),
    mode: selectedMode(),
    preferredBoard1Eta: preferredBoard1Eta(),
    bufferMinutes: Number($("bufferMinutes").value || 1),
    maxTransferMeters: Number($("maxTransferMeters").value || 450),
  };
}

function boardingBodyFromSnap(snap) {
  if (snap.boardingMode === "manual_stop") {
    return {
      boardingMode: "manual_stop",
      boardStopId: snap.boardStopId,
      boardStopSeq: snap.boardStopSeq,
      minutesToBoardStop: snap.minutesToBoardStop,
    };
  }
  return {
    boardingMode: "location",
    origin: snap.origin,
  };
}

async function loadRoutes(leg) {
  const co = $(`co${leg}`).value;
  const q = $(`routeQuery${leg}`).value.trim();
  const select = $(`route${leg}`);
  const stopSelect = $(`stop${leg}`);
  const genKey = `routes${leg}`;
  const gen = ++gens[genKey];
  const ac = abortAndStart(genKey);

  if (!q) {
    clearSelect(select, "輸入路線後揀方向", true);
    clearSelect(stopSelect, null, true);
    syncVisibleStops(leg);
    state[leg].routes = [];
    state[leg].stops = [];
    if (leg === 1) fillBoardStopSelect([]);
    clearPlanDependentState();
    refreshSticky();
    return;
  }

  select.disabled = true;
  clearSelect(select, "載入中…", true);

  try {
    const { routes } = await api(
      `/api/routes?co=${encodeURIComponent(co)}&q=${encodeURIComponent(q)}`,
      { signal: ac.signal },
    );
    if (gen !== gens[genKey]) return;
    state[leg].routes = routes;
    if (!routes.length) {
      clearSelect(select, "搵唔到路線", true);
      refreshSticky();
      return;
    }
    fillSelectOptions(select, routes, (r) => ({
      value: JSON.stringify({
        co: r.co,
        route: r.route,
        bound: r.bound,
        serviceType: r.serviceType,
      }),
      label: r.labelTc,
    }));
    select.disabled = false;
    clearPlanDependentState();
    await loadStops(leg);
    if (leg === 1) await refreshBoard1Departures();
  } catch (err) {
    if (err.name === "AbortError") return;
    if (gen !== gens[genKey]) return;
    clearSelect(select, "載入失敗", true);
    showOutputError(err.message);
  }
  refreshSticky();
}

function renderBoard1Departures(payload) {
  state.board1 = payload.board1;
  state.board1Departures = payload.board1Departures || [];
  state.board1TimingStatus = payload.board1TimingStatus || null;
  state.board1TimingStatusTc = payload.board1TimingStatusTc || null;
  const select = $("board1Eta");
  const wrap = $("board1SelectWrap");
  const refreshBtn = $("refreshBoard1Btn");

  $("board1Hint").textContent = payload.noteTc || "揀第一程上車班次。";
  refreshBtn.hidden = false;

  if (!state.board1Departures.length) {
    clearSelect(select, "暫時未有 ETA", true);
    wrap.hidden = board1Mode() !== "manual";
    return;
  }

  const autoEta = payload.board1?.boardEta;
  fillSelectOptions(select, state.board1Departures, (d) => ({
    value: d.eta,
    label: `${d.labelTc}${autoEta === d.eta ? "（自動建議）" : ""}`,
    selected: autoEta === d.eta,
  }));
  select.disabled = false;
  if (autoEta) select.value = autoEta;
  wrap.hidden = board1Mode() !== "manual";
}

async function refreshBoard1Departures() {
  const leg1 = parseRouteValue($("route1").value);
  if (!leg1) {
    $("board1Hint").textContent = "先揀第一程路線同方向。";
    $("board1SelectWrap").hidden = true;
    $("refreshBoard1Btn").hidden = true;
    return;
  }
  const boarding = boardingPayload();
  if (boarding.boardingMode === "location" && !boarding.origin) {
    $("board1Hint").textContent = "可用目前位置，或改用自行選擇上車站後再更新班次。";
    return;
  }
  if (boarding.boardingMode === "manual_stop" && !boarding.boardStopId) {
    $("board1Hint").textContent = "先揀第一程上車站，再更新班次。";
    return;
  }

  const gen = ++gens.board1;
  const ac = abortAndStart("board1");
  const snapPreferred = preferredBoard1Eta();
  $("board1Hint").textContent = "更新緊第一程班次…";
  try {
    const data = await api("/api/board1-departures", {
      method: "POST",
      signal: ac.signal,
      body: JSON.stringify({
        ...boarding,
        leg1,
        bufferMinutes: Number($("bufferMinutes").value || 1),
        preferredBoard1Eta: snapPreferred,
      }),
    });
    if (gen !== gens.board1) return;
    if (!sameRoute(leg1, parseRouteValue($("route1").value))) return;
    renderBoard1Departures(data);
  } catch (err) {
    if (err.name === "AbortError") return;
    if (gen !== gens.board1) return;
    $("board1Hint").textContent = err.message;
  }
  refreshSticky();
}

function fillBoardStopSelect(stops, preferred = null) {
  const select = $("boardStop1");
  if (!select) return;
  select.replaceChildren();
  if (!stops?.length) {
    select.append(new Option("未有車站", ""));
    select.disabled = true;
    return;
  }
  select.append(new Option("揀上車站", ""));
  for (const s of stops) {
    const value = JSON.stringify({ stopId: s.stopId, seq: s.seq });
    select.append(new Option(`${s.seq}. ${s.nameTc}`, value));
  }
  select.disabled = false;
  if (preferred) {
    const match =
      stops.find(
        (s) =>
          s.stopId === preferred.stopId &&
          (preferred.seq == null || s.seq === preferred.seq),
      ) || stops.find((s) => s.stopId === preferred.stopId);
    if (match) {
      select.value = JSON.stringify({ stopId: match.stopId, seq: match.seq });
    }
  }
}

async function loadStops(leg, preferred = null) {
  const route = parseRouteValue($(`route${leg}`).value);
  const stopSelect = $(`stop${leg}`);
  const genKey = `stops${leg}`;
  const gen = ++gens[genKey];
  const ac = abortAndStart(genKey);

  if (!route) {
    clearSelect(stopSelect, null, true);
    syncVisibleStops(leg);
    return;
  }

  stopSelect.disabled = true;
  const params = new URLSearchParams({
    co: route.co,
    route: route.route,
    bound: route.bound,
    serviceType: route.serviceType,
  });

  try {
    const { stops } = await api(`/api/stops?${params}`, { signal: ac.signal });
    if (gen !== gens[genKey]) return;
    if (!sameRoute(route, parseRouteValue($(`route${leg}`).value))) return;
    state[leg].stops = stops;
    stopSelect.replaceChildren();
    for (const s of stops) {
      const value = JSON.stringify({ stopId: s.stopId, seq: s.seq });
      const opt = new Option(`${s.seq}. ${s.nameTc}`, value);
      stopSelect.append(opt);
    }
    stopSelect.disabled = !stops.length;
    if (preferred) {
      const match =
        stops.find(
          (s) =>
            s.stopId === preferred.stopId &&
            (preferred.seq == null || s.seq === preferred.seq),
        ) || stops.find((s) => s.stopId === preferred.stopId);
      if (match) {
        stopSelect.value = JSON.stringify({ stopId: match.stopId, seq: match.seq });
      }
    }
    // Dedicated first-leg boarding stop select (not alight/transfer stop1).
    if (leg === 1) {
      const prevBoard = selectedBoardStop();
      fillBoardStopSelect(stops, prevBoard);
      $("manualBoardHint").textContent = stops.length
        ? "揀你實際上車嗰個站（可填幾分鐘後到站）。"
        : "呢程暫時未有車站。";
    }
  } catch (err) {
    if (err.name === "AbortError") return;
    if (gen !== gens[genKey]) return;
    clearSelect(stopSelect, "載入失敗", true);
    if (leg === 1) fillBoardStopSelect([]);
    showOutputError(err.message);
  }
  syncVisibleStops(leg);
  refreshSticky();
}

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    const available = typeof navigator !== "undefined" && !!navigator.geolocation;
    const secure =
      typeof window === "undefined" ? true : window.isSecureContext !== false;
    if (!available) {
      const err = new Error("geolocation unavailable");
      err.code = 2;
      err._geoMeta = { geolocationAvailable: false, isSecureContext: secure };
      reject(err);
      return;
    }
    if (!secure) {
      const err = new Error("insecure context");
      err.code = 1;
      err._geoMeta = { geolocationAvailable: true, isSecureContext: false };
      reject(err);
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 30000,
    });
  });
}

async function locateOrigin() {
  const btn = $("locateBtn");
  state.locateAttempted = true;
  btn.disabled = true;
  btn.textContent = "定位中…";
  $("originStatus").textContent = "正在拎你個位置…";
  $("originStatus").classList.remove("ok");

  try {
    const pos = await getCurrentPosition();
    state.origin = { lat: pos.coords.latitude, long: pos.coords.longitude };
    clearPlanDependentState();
    $("originStatus").textContent = "已定位，可用嚟建議最近上車站。";
    $("originStatus").classList.add("ok");
    btn.textContent = "重新定位";
    $("cardRoutes").scrollIntoView({ behavior: "smooth", block: "start" });
    await refreshBoard1Departures();
  } catch (err) {
    state.origin = null;
    const meta = err?._geoMeta || {
      geolocationAvailable: typeof navigator !== "undefined" && !!navigator.geolocation,
      isSecureContext: typeof window === "undefined" || window.isSecureContext !== false,
    };
    $("originStatus").textContent = geoErrorMessage(err, meta);
    btn.textContent = "使用目前位置";
    // Keep manual flow available — do not auto-retry location.
  } finally {
    btn.disabled = false;
    refreshSticky();
  }
}

function showOutputError(message) {
  $("output").replaceChildren(el("div", { className: "error", text: message }));
}

function timingBadgeClass(status) {
  if (status === "eta_matched") return "pill match";
  if (status === "upstream_error" || status === "manual_uncatchable" || status === "preferred_gone") {
    return "pill miss";
  }
  if (status === "outside_visible_eta" || status === "no_catchable_board1") return "pill tight";
  return "pill";
}

function applyCandidate(index) {
  const plan = state.plan;
  if (!plan?.candidates?.[index]) return;
  const gen = ++gens.candidate;
  state.selectedCandidateIndex = index;
  state.timingStale = false;
  state.timingError = null;
  const c = plan.candidates[index];

  // Sync advanced stop selects to this candidate occurrence — no unconstrained /api/match.
  void Promise.all([
    loadStops(1, { stopId: c.alight1.stopId, seq: c.alight1.seq }),
    loadStops(2, { stopId: c.board2.stopId, seq: c.board2.seq }),
  ]).then(() => {
    if (gen !== gens.candidate) return;
    $("walkMinutes").value = String(c.walkMinutes);
  });

  if (gen !== gens.candidate) return;
  state.lastTimingUpdatedAt = c.evaluatedAt || plan.generatedAt || null;
  renderOutput();
}

async function refreshSelectedTiming() {
  if (state.timingRefreshing) return;
  const plan = state.plan;
  const idx = state.selectedCandidateIndex;
  if (plan == null || idx == null || !plan.candidates?.[idx]) return;
  const c = plan.candidates[idx];
  const snap = planInputSnapshot();
  if (!snap.leg1 || !snap.leg2) return;
  if (snap.boardingMode === "location" && !snap.origin) return;
  if (snap.boardingMode === "manual_stop" && !snap.boardStopId) return;

  const gen = ++gens.refresh;
  const ac = abortAndStart("refresh");
  state.timingRefreshing = true;
  state.timingError = null;
  renderOutput();

  try {
    const data = await api("/api/refresh-candidate", {
      method: "POST",
      signal: ac.signal,
      body: JSON.stringify({
        ...boardingBodyFromSnap(snap),
        leg1: snap.leg1,
        leg2: snap.leg2,
        alight1StopId: c.alight1.stopId,
        alight1Seq: c.alight1.seq,
        board2StopId: c.board2.stopId,
        board2Seq: c.board2.seq,
        bufferMinutes: snap.bufferMinutes,
        preferredBoard1Eta: snap.preferredBoard1Eta,
      }),
    });
    if (gen !== gens.refresh) return;
    if (state.selectedCandidateIndex !== idx) return;
    if (!state.plan || state.plan !== plan) return;

    // Preserve physical selection; replace timing fields on that candidate.
    const next = { ...plan, candidates: [...plan.candidates] };
    next.candidates[idx] = data.candidate;
    next.board1 = data.board1Context.board1;
    next.board1Departures = data.board1Context.board1Departures;
    next.board1EtaSource = data.board1Context.board1EtaSource;
    next.board1TimingStatus = data.board1Context.board1TimingStatus;
    next.board1TimingStatusTc = data.board1Context.board1TimingStatusTc;
    state.plan = next;
    state.timingStale = false;
    state.lastTimingUpdatedAt = data.generatedAt || data.candidate.evaluatedAt;
    renderBoard1Departures({
      board1: data.board1Context.board1,
      board1Departures: data.board1Context.board1Departures,
      board1TimingStatus: data.board1Context.board1TimingStatus,
      board1TimingStatusTc: data.board1Context.board1TimingStatusTc,
      noteTc: `已更新班次 · ${data.board1Context.board1TimingStatusTc}`,
    });
  } catch (err) {
    if (err.name === "AbortError") return;
    if (gen !== gens.refresh) return;
    state.timingError = err.message;
    state.timingStale = true;
    if (state.plan?.candidates?.[idx]) {
      state.plan.candidates[idx] = { ...state.plan.candidates[idx], stale: true };
    }
  } finally {
    if (gen === gens.refresh) state.timingRefreshing = false;
    renderOutput();
  }
}

function renderSelectedTimeline(plan, c) {
  const wrap = el("div", { className: "timeline" });
  wrap.append(el("strong", { text: "已選轉乘" }));

  const boardOk = plan.board1TimingStatus === "ok" && c.board1Eta;
  wrap.append(
    el("div", {
      text: boardOk
        ? `① ${fmtTime(c.board1Eta)} 上第一程（${plan.board1.nameTc}）`
        : `① 第一程上車站：${plan.board1.nameTc}（上車時間未確立）`,
    }),
  );
  wrap.append(el("div", { text: `↓ 落：${c.alight1.nameTc}` }));
  wrap.append(
    el("div", {
      text: `↓ 步行約 ${c.walkMeters}m / ${c.walkMinutes} 分（直線估算）`,
    }),
  );
  wrap.append(
    el("div", {
      text:
        c.timingStatus === "eta_matched" && c.leg2Eta
          ? `② ${fmtTime(c.leg2Eta)} 上第二程（${c.board2.nameTc}）`
          : `② 上：${c.board2.nameTc}（第二程時間：${c.timingStatusTc}）`,
    }),
  );

  if (c.walkNoteTc) wrap.append(el("p", { className: "hint", text: c.timingNoteTc }));
  if (c.timingNoteTc) wrap.append(el("p", { className: "hint", text: c.timingNoteTc }));
  if (!canShowConfirmedJourney(c, plan)) {
    wrap.append(
      el("p", {
        className: "hint",
        text: "未顯示完整確認行程：第一程上車或轉乘時間未完全確立。",
      }),
    );
  }

  const meta = el("div", { className: "timing-meta" });
  if (state.lastTimingUpdatedAt) {
    meta.append(
      el("span", {
        text: `上次更新 ${fmtUpdated(state.lastTimingUpdatedAt)}${state.timingStale || c.stale ? " · 資料可能過時" : ""}`,
      }),
    );
  }
  const refreshBtn = el(
    "button",
    {
      className: "chip-btn",
      attrs: { type: "button", id: "refreshTimingBtn" },
      on: { click: () => refreshSelectedTiming() },
    },
    [state.timingRefreshing ? "更新中…" : "更新班次"],
  );
  refreshBtn.disabled = state.timingRefreshing;
  meta.append(refreshBtn);
  if (state.timingError) {
    meta.append(el("p", { className: "error", text: state.timingError }));
  }
  wrap.append(meta);

  return wrap;
}

function renderOutput() {
  const plan = state.plan;
  const box = $("output");
  if (!plan) {
    box.replaceChildren();
    return;
  }
  if (!plan.candidates.length) {
    box.replaceChildren(el("div", { className: "error", text: plan.summaryTc }));
    return;
  }

  const modeLabel =
    plan.mode === "fastest" ? "最早上車" : plan.mode === "manual" ? "人手揀" : "最少步行";

  const summary = el("div", { className: "summary" }, [
    el("span", { className: "pill match", text: modeLabel }),
    el("p", { text: plan.summaryTc }),
  ]);
  if (plan.searchNoteTc) {
    summary.append(el("p", { className: "hint", text: plan.searchNoteTc }));
  }
  if (plan.board1TimingStatusTc) {
    summary.append(el("p", { className: "hint", text: plan.board1TimingStatusTc }));
  }

  const selected = state.selectedCandidateIndex;
  const selectedCard =
    selected != null && plan.candidates[selected]
      ? renderSelectedTimeline(plan, plan.candidates[selected])
      : el("p", { className: "hint", text: "撳下面其中一個建議，就會顯示轉乘詳情。" });

  const list = el("div", { className: "plan-result" });
  plan.candidates.forEach((c, idx) => {
    const isSelected = selected === idx;
    const article = el("article", {
      className: `candidate ${isSelected ? "selected" : ""}`,
      attrs: { role: "button", tabindex: "0", "data-pick": String(idx) },
    });
    const top = el("div", { className: "candidate-top" }, [
      el("strong", { text: `${isSelected ? "已選 · " : ""}#${idx + 1}` }),
      el("span", {
        className: timingBadgeClass(c.timingStatus),
        text: TIMING_LABEL[c.timingStatus] || c.timingStatusTc,
      }),
    ]);
    article.append(top);
    article.append(el("p", { className: "meta-line", text: c.scoreTc }));
    article.append(el("p", { className: "meta-line", text: `落：${c.alight1.nameTc}` }));
    article.append(el("p", { className: "meta-line", text: `上：${c.board2.nameTc}` }));
    article.append(el("p", { className: "meta-line", text: `直線約 ${c.walkMeters}m` }));
    if (c.stale) article.append(el("p", { className: "hint", text: "顯示緊可能過時嘅時間" }));

    const pick = () => {
      applyCandidate(idx);
      $("output").scrollIntoView({ behavior: "smooth", block: "start" });
    };
    article.addEventListener("click", pick);
    article.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        pick();
      }
    });
    list.append(article);
  });

  box.replaceChildren(summary, selectedCard, list);
}

async function loadNearbyList() {
  if (!state.origin) return;
  const list = $("nearbyList");
  $("nearbyBlock").hidden = false;
  list.replaceChildren(el("p", { className: "hint", text: "搵緊附近車站…" }));
  try {
    const params = new URLSearchParams({
      lat: String(state.origin.lat),
      long: String(state.origin.long),
      limit: "10",
      maxMeters: "900",
    });
    const data = await api(`/api/nearby?${params}`);
    renderNearby(data);
  } catch (err) {
    list.replaceChildren(el("div", { className: "error", text: err.message }));
  }
}

function renderNearby(data) {
  const list = $("nearbyList");
  if (!data.stops?.length) {
    list.replaceChildren(el("p", { className: "hint", text: "附近暫時搵唔到站。" }));
    return;
  }
  $("nearbyHint").textContent = "點開車站，填入落車／上車站。";
  list.replaceChildren();
  for (const s of data.stops) {
    const details = el("details", {
      className: "nearby-stop",
      attrs: { "data-co": s.co, "data-stop": s.stopId },
    });
    const summary = el("summary");
    summary.append(el("span", { text: s.nameTc }), el("span", { className: "dist", text: `${s.meters}m` }));
    const services = el("div", {
      className: "service-list",
      attrs: { "data-services": "" },
      text: "載入路線中…",
    });
    details.append(summary, services);
    details.addEventListener("toggle", () => {
      if (details.open) loadStopServices(details);
    });
    list.append(details);
  }
}

async function loadStopServices(detailsEl) {
  const box = detailsEl.querySelector("[data-services]");
  if (!box || box.dataset.loaded === "1") return;
  const co = detailsEl.dataset.co;
  const stopId = detailsEl.dataset.stop;
  box.textContent = "載入路線中…";
  try {
    const { services } = await api(
      `/api/stop-services?co=${encodeURIComponent(co)}&stopId=${encodeURIComponent(stopId)}`,
    );
    box.dataset.loaded = "1";
    box.replaceChildren();
    if (!services.length) {
      box.append(el("p", { className: "hint", text: "呢站暫時未有路線。" }));
      return;
    }
    for (const svc of services) {
      const row = el("div", { className: "service-row" });
      const p = el("p");
      p.append(el("strong", { text: svc.route }), document.createTextNode(` → ${svc.destTc}`));
      const actions = el("div", { className: "service-actions" });
      const payload = {
        co,
        stopId,
        route: svc.route,
        bound: svc.bound,
        serviceType: svc.serviceType,
        destTc: svc.destTc,
      };
      for (const [leg, label] of [
        [1, "第一程落車"],
        [2, "第二程上車"],
      ]) {
        const btn = el("button", {
          className: "chip-btn",
          attrs: { type: "button" },
          text: label,
          on: {
            click: async () => {
              $(`co${leg}`).value = payload.co;
              $(`routeQuery${leg}`).value = payload.route;
              clearPlanDependentState();
              await loadRoutes(leg);
              const select = $(`route${leg}`);
              for (const opt of select.options) {
                if (!opt.value) continue;
                const v = JSON.parse(opt.value);
                if (v.route === payload.route && v.bound === payload.bound) {
                  select.value = opt.value;
                  break;
                }
              }
              await loadStops(leg, { stopId: payload.stopId, seq: null });
              refreshSticky();
            },
          },
        });
        actions.append(btn);
      }
      row.append(p, actions);
      box.append(row);
    }
  } catch (err) {
    box.replaceChildren(el("div", { className: "error", text: err.message }));
  }
}

async function runPlan() {
  if (!canPlan()) {
    showOutputError("請先完成上車方式（位置或上車站）同兩程路線。");
    return;
  }

  const btn = $("planBtn");
  btn.disabled = true;
  btn.textContent = "搵緊…";
  $("stickyHint").textContent = "分析緊轉乘站同 ETA";
  $("output").replaceChildren(el("p", { className: "hint", text: "分析緊兩程車站同即時 ETA…" }));
  state.selectedCandidateIndex = null;
  state.timingStale = false;
  state.timingError = null;

  const snap = planInputSnapshot();
  const gen = ++gens.plan;
  const ac = abortAndStart("plan");
  const mode = snap.mode;

  try {
    const plan = await api("/api/plan-transfer", {
      method: "POST",
      signal: ac.signal,
      body: JSON.stringify({
        ...boardingBodyFromSnap(snap),
        leg1: snap.leg1,
        leg2: snap.leg2,
        mode,
        maxTransferMeters: snap.maxTransferMeters,
        bufferMinutes: snap.bufferMinutes,
        limit: mode === "manual" ? 12 : 8,
        preferredBoard1Eta: snap.preferredBoard1Eta,
      }),
    });
    if (gen !== gens.plan) return;
    const cur = planInputSnapshot();
    if (!shouldApplyResponse(gen, gens.plan, snap, cur)) return;

    state.plan = plan;
    state.lastTimingUpdatedAt = plan.generatedAt;
    if (plan.board1Departures) {
      const walkNote =
        plan.board1.metersFromOrigin != null
          ? `（距出發地約 ${plan.board1.metersFromOrigin}m）`
          : plan.board1.minutesToBoardStop != null
            ? `（約 ${plan.board1.minutesToBoardStop} 分後到站）`
            : "";
      renderBoard1Departures({
        board1: plan.board1,
        board1Departures: plan.board1Departures,
        board1TimingStatus: plan.board1TimingStatus,
        board1TimingStatusTc: plan.board1TimingStatusTc,
        noteTc: `會喺「${plan.board1.nameTc}」上第一程${walkNote}。${plan.board1TimingStatusTc}`,
      });
    }
    renderOutput();

    if (mode === "manual") {
      $("advanced").open = true;
      await loadNearbyList();
    } else if (plan.candidates.length) {
      const firstGood = plan.candidates.findIndex((c) => c.timingStatus === "eta_matched");
      applyCandidate(firstGood >= 0 ? firstGood : 0);
    }

    $("output").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    if (err.name === "AbortError") return;
    if (gen !== gens.plan) return;
    showOutputError(err.message);
  } finally {
    if (gen === gens.plan) {
      refreshSticky();
      btn.textContent = "再搵一次";
    }
  }
}

function wireLeg(leg) {
  const loadRoutesDebounced = debounce(() => loadRoutes(leg), 350);
  $(`co${leg}`).addEventListener("change", () => {
    $(`routeQuery${leg}`).value = "";
    clearPlanDependentState("公司已改，請重新搵轉乘。");
    loadRoutes(leg);
  });
  $(`routeQuery${leg}`).addEventListener("input", () => {
    clearPlanDependentState();
    loadRoutesDebounced();
  });
  $(`route${leg}`).addEventListener("change", async () => {
    clearPlanDependentState("路線／方向已改，請重新搵轉乘。");
    await loadStops(leg);
    if (leg === 1) await refreshBoard1Departures();
    refreshSticky();
  });
  $(`stop${leg}Visible`).addEventListener("change", () => {
    $(`stop${leg}`).value = $(`stop${leg}Visible`).value;
    // Manual stop edits invalidate the previously selected planned candidate/timeline.
    if (state.plan && state.selectedCandidateIndex != null) {
      state.selectedCandidateIndex = null;
      state.timingStale = false;
      renderOutput();
      const note = el("p", {
        className: "hint",
        text: "已改轉車站；舊建議時間軸已取消。請重新揀候選或再搵一次。",
      });
      $("output").prepend(note);
    }
  });
}

document.querySelectorAll('input[name="planMode"]').forEach((input) => {
  input.addEventListener("change", () => {
    $("modeHint").textContent = MODE_HINTS[selectedMode()];
    $("nearbyBlock").hidden = selectedMode() !== "manual";
    if (selectedMode() === "manual" && state.origin) {
      $("advanced").open = true;
      loadNearbyList();
    }
  });
});

document.querySelectorAll('input[name="boardingInputMode"]').forEach((input) => {
  input.addEventListener("change", () => {
    syncBoardingPanels();
    clearPlanDependentState("上車方式已改，請重新搵轉乘。");
    refreshSticky();
    if (boardingInputMode() === "manual_stop" && parseRouteValue($("route1").value)) {
      if (state[1].stops?.length) fillBoardStopSelect(state[1].stops, selectedBoardStop());
    }
  });
});

document.querySelectorAll('input[name="board1Mode"]').forEach((input) => {
  input.addEventListener("change", () => {
    const manual = board1Mode() === "manual";
    $("board1SelectWrap").hidden = !manual;
    clearPlanDependentState("第一程班次方式已改，請重新搵轉乘。");
    if (manual && !state.board1Departures.length) refreshBoard1Departures();
  });
});

$("board1Eta").addEventListener("change", () => {
  clearPlanDependentState("第一程班次已改，請重新搵轉乘。");
});

$("boardStop1").addEventListener("change", () => {
  clearPlanDependentState("第一程上車站已改，請重新搵轉乘。");
  refreshBoard1Departures();
  refreshSticky();
});

$("minutesToBoardStop").addEventListener(
  "change",
  debounce(() => {
    clearPlanDependentState("到上車站時間已改，請重新搵轉乘。");
    refreshBoard1Departures();
  }, 300),
);

$("refreshBoard1Btn").addEventListener("click", refreshBoard1Departures);
$("bufferMinutes").addEventListener(
  "change",
  debounce(() => {
    clearPlanDependentState("緩衝時間已改，請重新搵轉乘。");
    refreshBoard1Departures();
  }, 300),
);
$("maxTransferMeters").addEventListener("change", () => {
  clearPlanDependentState("最大轉車距離已改，請重新搵轉乘。");
});

wireLeg(1);
wireLeg(2);
$("locateBtn").addEventListener("click", locateOrigin);
$("planBtn").addEventListener("click", runPlan);

$("modeHint").textContent = MODE_HINTS.shortest_walk;
syncBoardingPanels();
refreshSticky();
