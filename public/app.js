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
    btn.textContent = "開始�textContent = "先揀兩程路線同方向";
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
  const node = document.create