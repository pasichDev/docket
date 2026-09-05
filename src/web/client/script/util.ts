/*
 * Colour derivation, date helpers and the sort comparators — the leaf functions every
 * other part of the client calls and none of them calls back into.
 *
 * A TEMPLATE LITERAL, not a module. Everything below is text that becomes the page.
 *
 * Two rules follow from that and there is no compiler to enforce either:
 *  - a literal backtick ends the string. Write \\` , or reword. views.backtick.test.ts
 *    fails with the exact line number when one slips into a comment, which is where it
 *    always happens — a backtick is the natural way to quote an identifier in prose.
 *  - ${...} interpolates. Write \\${ for a dollar-brace that should reach the browser.
 */
export const UTIL = `
let lastSync = null;

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function isDark() {
  return document.documentElement.dataset.theme !== "light";
}

function categoryTint(cat) {
  if (!cat) return null;
  let hash = 0;
  for (let i = 0; i < cat.length; i++) hash = (hash * 31 + cat.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  const dark = isDark();
  return {
    chipBg: \`hsl(\${hue} \${dark ? "35% 22%" : "65% 85%"})\`,
    chipText: \`hsl(\${hue} \${dark ? "65% 75%" : "55% 32%"})\`,
    rot: \`\${((hash % 3) - 1) * 1.5}deg\`,
  };
}

function agentColor(agent) {
  if (!agent) return "#94a3b8";
  let hash = 0;
  for (let i = 0; i < agent.length; i++) hash = (hash * 31 + agent.charCodeAt(i)) >>> 0;
  return \`hsl(\${hash % 360} 55% 55%)\`;
}

function sageHex() {
  return isDark() ? "#7fc492" : "#3f7a50";
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function isOverdue(t) {
  return !t.done && t.dueDate && t.dueDate < todayStr();
}

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

// "\\uffff" sorts after any real value, so items missing the sort key land last.
const byId = (a, b) => a.id - b.id;
const COMPARATORS = {
  newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
  oldest: (a, b) => a.createdAt.localeCompare(b.createdAt),
  az: (a, b) => a.title.localeCompare(b.title),
  category: (a, b) => (a.category || "\\uffff").localeCompare(b.category || "\\uffff") || byId(a, b),
  priority: (a, b) => (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3) || byId(a, b),
  due: (a, b) => (a.dueDate || "\\uffff").localeCompare(b.dueDate || "\\uffff") || byId(a, b),
};

function sortItems(items, mode) {
  const cmp = COMPARATORS[mode] ?? byId;
  // Claimed/in-progress items always come first, regardless of sort mode.
  return [...items].sort((a, b) => Number(!!b.workingAgent) - Number(!!a.workingAgent) || cmp(a, b));
}
`;
