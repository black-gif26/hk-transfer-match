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
      