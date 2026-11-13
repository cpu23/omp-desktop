type SessionDetails = {
  title: string;
  directory: string;
  lastActivity: string | null;
  costUsd: number | null;
};

const card = document.createElement("div");
card.id = "session-hover-card";
card.className = "session-hover-card";
card.setAttribute("role", "tooltip");
card.hidden = true;
const title = document.createElement("div");
title.className = "session-hover-title";
const directory = document.createElement("div");
directory.className = "session-hover-directory";
const metadata = document.createElement("div");
metadata.className = "session-hover-metadata";
const activity = document.createElement("span");
const cost = document.createElement("span");
metadata.append(activity, cost);
card.append(title, directory, metadata);
document.body.append(card);

let anchor: HTMLElement | null = null;
let details: (() => SessionDetails) | null = null;
let showTimer: number | undefined;
let hideTimer: number | undefined;
let refreshTimer: number | undefined;

function relativeActivity(value: string | null): string {
  const timestamp = value === null ? NaN : Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Activity unknown";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function refresh(): void {
  if (!anchor?.isConnected || !details) { hide(); return; }
  const value = details();
  title.textContent = value.title;
  directory.textContent = value.directory;
  activity.textContent = relativeActivity(value.lastActivity);
  activity.setAttribute("aria-label", `Last activity: ${activity.textContent}`);
  cost.textContent = value.costUsd !== null && Number.isFinite(value.costUsd)
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value.costUsd)
    : "Cost unavailable";
  cost.setAttribute("aria-label", `Session cost: ${cost.textContent}`);
  const row = anchor.getBoundingClientRect();
  const box = card.getBoundingClientRect();
  const right = row.right + 8;
  const left = right + box.width <= innerWidth - 8 ? right : row.left - box.width - 8;
  card.style.left = `${Math.max(8, Math.min(left, innerWidth - box.width - 8))}px`;
  card.style.top = `${Math.max(8, Math.min(row.top, innerHeight - box.height - 8))}px`;
}

function hide(): void {
  window.clearTimeout(showTimer);
  window.clearTimeout(hideTimer);
  window.clearInterval(refreshTimer);
  anchor?.removeAttribute("aria-describedby");
  anchor = null;
  details = null;
  card.hidden = true;
}

function scheduleHide(): void {
  window.clearTimeout(showTimer);
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(hide, 120);
}

card.addEventListener("pointerenter", () => window.clearTimeout(hideTimer));
card.addEventListener("pointerleave", scheduleHide);
document.addEventListener("keydown", (event) => { if (event.key === "Escape") hide(); });
document.addEventListener("pointerdown", hide, true);
document.addEventListener("contextmenu", hide, true);
document.addEventListener("scroll", (event) => {
  if (!(event.target instanceof Node) || !card.contains(event.target)) hide();
}, true);
window.addEventListener("blur", hide);
window.addEventListener("resize", hide);

/** Resolve current row data only when needed; one shared card escapes sidebar clipping. */
export function wireSessionHover(row: HTMLElement, readDetails: () => SessionDetails): void {
  const show = (): void => {
    hide();
    anchor = row;
    details = readDetails;
    showTimer = window.setTimeout(() => {
      card.hidden = false;
      row.setAttribute("aria-describedby", card.id);
      refresh();
      refreshTimer = window.setInterval(refresh, 30_000);
    }, 350);
  };
  row.addEventListener("pointerenter", show);
  row.addEventListener("pointerleave", scheduleHide);
  row.addEventListener("focusin", show);
  row.addEventListener("focusout", (event) => {
    if (!(event.relatedTarget instanceof Node) || !row.contains(event.relatedTarget)) scheduleHide();
  });
}
