window.__ModuleLoader__.load({
  id: "dsh-memory",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.tsx
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(client_exports);
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
function MemoryIcon() {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", { width: "16", height: "16", viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("circle", { cx: "8", cy: "8", r: "2.1", fill: "currentColor" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M8 5.9V3.2 M8 10.1V12.8 M5.9 8H3.2 M10.1 8H12.8", stroke: "currentColor", strokeWidth: "1.3", strokeLinecap: "round" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("circle", { cx: "8", cy: "3.2", r: "0.9", fill: "currentColor" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("circle", { cx: "8", cy: "12.8", r: "0.9", fill: "currentColor" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("circle", { cx: "3.2", cy: "8", r: "0.9", fill: "currentColor" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("circle", { cx: "12.8", cy: "8", r: "0.9", fill: "currentColor" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("circle", { cx: "4.7", cy: "4.7", r: "0.8", fill: "currentColor" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("circle", { cx: "11.3", cy: "4.7", r: "0.8", fill: "currentColor" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("circle", { cx: "4.7", cy: "11.3", r: "0.8", fill: "currentColor" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("circle", { cx: "11.3", cy: "11.3", r: "0.8", fill: "currentColor" })
  ] });
}
function useScope(scope) {
  const [snap, setSnap] = (0, import_react.useState)(() => scope.getSnapshot());
  (0, import_react.useEffect)(() => scope.subscribe(() => setSnap(scope.getSnapshot())), [scope]);
  return snap;
}
function Toggle(props) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: { display: "flex", alignItems: "center", gap: 10, padding: "8px 0" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "checkbox", checked: props.checked, disabled: props.disabled, onChange: (e) => props.onChange(e.target.checked) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { flex: 1 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { children: props.label }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { fontSize: 12, opacity: 0.7 }, children: props.hint })
    ] })
  ] });
}
function FileEditor(props) {
  const [draft, setDraft] = (0, import_react.useState)(props.value);
  const [saving, setSaving] = (0, import_react.useState)(false);
  const [opening, setOpening] = (0, import_react.useState)(false);
  const [error, setError] = (0, import_react.useState)(null);
  const [note, setNote] = (0, import_react.useState)(null);
  (0, import_react.useEffect)(() => {
    setDraft(props.value);
    setError(null);
  }, [props.value]);
  const save = async () => {
    setSaving(true);
    setError(null);
    const result = await props.onSave(draft);
    setSaving(false);
    if (!result.ok) {
      setDraft(props.value);
      setError(result.error ?? "\u4FDD\u5B58\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u7F51\u7EDC\u6216\u6743\u9650");
    } else {
      setNote("\u5DF2\u4FDD\u5B58");
    }
  };
  const open = async () => {
    if (!props.onOpen) return;
    setOpening(true);
    setError(null);
    setNote(null);
    const result = await props.onOpen();
    setOpening(false);
    if (!result.ok) {
      setError(result.error ?? "\u65E0\u6CD5\u6253\u5F00\u672C\u5730\u7F16\u8F91\u5668");
    } else {
      setNote("\u5DF2\u5728\u672C\u5730\u7F16\u8F91\u5668\u4E2D\u6253\u5F00\u3002\u5916\u90E8\u4FEE\u6539\u540E\u8BF7\u70B9\u201C\u4FDD\u5B58\u201D\u540C\u6B65\uFF0C\u6216\u5237\u65B0\u9875\u9762\u3002");
    }
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { marginTop: 12 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { fontWeight: 600, marginBottom: 4 }, children: props.label }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "textarea",
      {
        value: draft,
        onChange: (e) => setDraft(e.target.value),
        rows: 5,
        style: { width: "100%", boxSizing: "border-box", fontFamily: "ui-monospace, Consolas, monospace", fontSize: 13, padding: 8 }
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { marginTop: 6, display: "flex", alignItems: "center", gap: 8 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: saving, onClick: () => {
        void save();
      }, children: saving ? "\u4FDD\u5B58\u4E2D\u2026" : "\u4FDD\u5B58" }),
      props.onOpen && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: opening, onClick: () => {
        void open();
      }, children: opening ? "\u6253\u5F00\u4E2D\u2026" : "\u6253\u5F00\u7F16\u8F91" }),
      note && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { fontSize: 12, opacity: 0.8 }, children: note })
    ] }),
    error && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { marginTop: 6, color: "#c00", fontSize: 12 }, children: error })
  ] });
}
function PanelModal(props) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    "div",
    {
      onClick: props.onClose,
      style: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999 },
      children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
        "div",
        {
          onClick: (e) => e.stopPropagation(),
          style: { background: "#1e1e1e", color: "#eee", width: "min(760px, 92vw)", maxHeight: "80vh", borderRadius: 8, display: "flex", flexDirection: "column", boxShadow: "0 8px 32px rgba(0,0,0,0.5)" },
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderBottom: "1px solid rgba(255,255,255,0.12)" }, children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { fontWeight: 600 }, children: props.title }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", onClick: props.onClose, style: { background: "none", border: "none", color: "#ccc", fontSize: 18, cursor: "pointer" }, "aria-label": "\u5173\u95ED", children: "\xD7" })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { overflow: "auto", padding: 14 }, children: props.children })
          ]
        }
      )
    }
  );
}
function MemorySettingsPanel(props) {
  const snap = useScope(props.scope);
  const value = snap.value ?? {};
  const ready = snap.status === "ready" && snap.writable;
  const [identity, setIdentity] = (0, import_react.useState)({ soul: "", user: "" });
  const [triggering, setTriggering] = (0, import_react.useState)(false);
  const [triggerResult, setTriggerResult] = (0, import_react.useState)(null);
  const [triggerError, setTriggerError] = (0, import_react.useState)(null);
  const [viewOpen, setViewOpen] = (0, import_react.useState)(false);
  const [viewLoading, setViewLoading] = (0, import_react.useState)(false);
  const [view, setView] = (0, import_react.useState)(null);
  const [viewError, setViewError] = (0, import_react.useState)(null);
  (0, import_react.useEffect)(() => {
    props.loadIdentity().then(setIdentity).catch(() => {
    });
  }, [props.loadIdentity]);
  const set = (field, next) => {
    void props.scope.set(field, next);
  };
  const runNow = async () => {
    setTriggering(true);
    setTriggerResult(null);
    setTriggerError(null);
    try {
      const r = await props.runNow();
      setTriggerResult(
        `\u6574\u7406\u5B8C\u6210\uFF1A\u51DD\u7EC3${r.refined ? "\u5DF2\u6267\u884C" : "\u5DF2\u8DF3\u8FC7\uFF08\u65E0\u5F85\u6574\u7406\u6216\u65E0 LLM \u8DEF\u7531\uFF09"}\uFF1B\u9057\u5FD8\uFF1A\u964D\u7EA7 ${r.forgetDemoted}\u3001\u5F52\u6863\u8BB0\u5FC6 ${r.forgetArchivedMem}\u3001\u5220\u9664\u8BB0\u5FC6 ${r.forgetDeletedMem}\u3001\u5F52\u6863\u4F1A\u8BDD ${r.forgetArchivedEpi}\u3001\u5220\u9664\u4F1A\u8BDD ${r.forgetDeletedEpi}`
      );
    } catch (e) {
      setTriggerError(e instanceof Error ? e.message : "\u89E6\u53D1\u5931\u8D25");
    } finally {
      setTriggering(false);
    }
  };
  const openViewer = async () => {
    setViewOpen(true);
    setViewLoading(true);
    setViewError(null);
    try {
      setView(await props.loadMemoryView());
    } catch (e) {
      setViewError(e instanceof Error ? e.message : "\u8BFB\u53D6\u8BB0\u5FC6\u5931\u8D25");
    } finally {
      setViewLoading(false);
    }
  };
  const layerLabel = (l) => l === "user" ? "\u7528\u6237" : l === "memory" ? "\u8BB0\u5FC6" : l;
  const kindLabel = (k) => k === "preference" ? "\u504F\u597D" : k === "env" ? "\u73AF\u5883" : k === "lesson" ? "\u7ECF\u9A8C" : k === "decision" ? "\u51B3\u7B56" : "\u4E00\u822C";
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { padding: 8, display: "flex", flexDirection: "column", gap: 4 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      Toggle,
      {
        label: "\u8BB0\u5FC6\u603B\u5F00\u5173",
        hint: "\u5173\u95ED\u540E\u65B0\u4F1A\u8BDD\u4E0D\u6CE8\u5165\u4EFB\u4F55\u8BB0\u5FC6\uFF08\u6E05\u6D01\u4F1A\u8BDD\uFF09\uFF0C\u540E\u53F0\u6574\u7406/\u9057\u5FD8/\u7EF4\u62A4\u5168\u505C",
        checked: value.enabled ?? true,
        disabled: !ready,
        onChange: (next) => set("enabled", next)
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      Toggle,
      {
        label: "\u5FD9\u95F2\u65F6\u6BB5\u6291\u5236\u626B\u63CF",
        hint: "\u5CF0\u65F6\uFF08\u9ED8\u8BA4\u5317\u4EAC 09\u201312 / 14\u201318\uFF09\u8DF3\u8FC7\u540E\u53F0 LLM \u51DD\u7EC3\uFF0C\u7701 API \u8D39\u7528",
        checked: value.peakHourSuppress ?? true,
        disabled: !ready,
        onChange: (next) => set("peakHourSuppress", next)
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      Toggle,
      {
        label: "\u4E3B\u52A8\u9057\u5FD8",
        hint: "\u5173\u95ED\u540E\u6682\u505C\u70ED\u5EA6\u8870\u51CF\u8BB0\u5FC6\u7684\u964D\u7EA7/\u5F52\u6863/\u786C\u5220\uFF08\u4EC5\u6682\u505C\uFF0C\u4E0D\u6E05\u7406\u5DF2\u6709\u8BB0\u5FC6\uFF09",
        checked: value.forgetEnabled ?? true,
        disabled: !ready,
        onChange: (next) => set("forgetEnabled", next)
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: { display: "flex", alignItems: "center", gap: 10, padding: "8px 0" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { flex: 1 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { children: "\u51DD\u7EC3\u6574\u7406\u65F6\u95F4\u95F4\u9694\uFF08\u5C0F\u65F6\uFF09" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { fontSize: 12, opacity: 0.7 }, children: "\u540E\u53F0 L1/L2 \u62BD\u53D6\u4E0E\u53BB\u91CD\u7684\u5468\u671F\u626B\u63CF\uFF1B\u6539\u5C0F\u66F4\u53CA\u65F6\u3001\u66F4\u8D39 API\uFF0C\u6539\u5927\u66F4\u7701\u3002\u65B0\u4F1A\u8BDD\u540E 10 \u79D2\u5185\u4ECD\u4F1A\u5373\u65F6\u51DD\u7EC3\u4E00\u6B21" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "input",
        {
          type: "number",
          min: 0.1,
          step: 0.5,
          disabled: !ready,
          value: Math.round((value.refineIntervalMs ?? 36e5) / 36e5 * 10) / 10,
          onChange: (e) => {
            const h = Math.max(0.1, Number(e.target.value) || 1);
            set("refineIntervalMs", Math.round(h * 36e5));
          },
          style: { width: 64 }
        }
      )
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 8, padding: "10px 0", borderTop: "1px solid rgba(128,128,128,0.25)", marginTop: 4 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: triggering, onClick: () => {
        void runNow();
      }, style: { padding: "6px 10px" }, children: triggering ? "\u6574\u7406\u4E2D\u2026" : "\u7ACB\u5373\u6574\u7406\u8BB0\u5FC6" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", onClick: () => {
        void openViewer();
      }, style: { padding: "6px 10px" }, children: "\u67E5\u770B\u8BB0\u5FC6" })
    ] }),
    triggerResult && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { fontSize: 12, color: "#0a7a2f", whiteSpace: "pre-wrap" }, children: triggerResult }),
    triggerError && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { fontSize: 12, color: "#c00" }, children: triggerError }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      FileEditor,
      {
        label: "soul.md\uFF08AI \u4EBA\u683C/\u884C\u4E3A\u51C6\u5219\uFF0C\u4EBA\u5199\uFF09",
        value: identity.soul,
        onSave: (content) => props.saveIdentity("soul", content),
        onOpen: () => props.openEditor("soul")
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      FileEditor,
      {
        label: "user.md\uFF08\u7528\u6237\u753B\u50CF\uFF0C\u53EF\u7F16\u8F91\uFF09",
        value: identity.user,
        onSave: (content) => props.saveIdentity("user", content),
        onOpen: () => props.openEditor("user")
      }
    ),
    viewOpen && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(PanelModal, { title: "\u8BB0\u5FC6\u67E5\u770B", onClose: () => setViewOpen(false), children: [
      viewLoading && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { opacity: 0.7 }, children: "\u8BFB\u53D6\u4E2D\u2026" }),
      viewError && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { color: "#c00", fontSize: 12 }, children: viewError }),
      !viewLoading && view && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 16, opacity: 0.85, fontSize: 13, marginBottom: 8 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [
            "\u6709\u6548\u8BB0\u5FC6 ",
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { children: view.memoryCount }),
            " \u6761"
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [
            "\u4F1A\u8BDD\u6458\u8981 ",
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { children: view.episodeCount }),
            " \u6761"
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [
            "\u4E3B\u9898 ",
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { children: view.topics.length }),
            " \u4E2A"
          ] })
        ] }),
        view.topics.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { fontSize: 12, opacity: 0.8, marginBottom: 8 }, children: [
          "\u4E3B\u9898\uFF1A",
          view.topics.slice(0, 12).map((t) => `${t.topic}(${t.count})`).join("\u3001")
        ] }),
        view.memories.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { opacity: 0.6, fontSize: 13 }, children: "\u6682\u65E0\u6709\u6548\u8BB0\u5FC6\u3002" }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("table", { style: { width: "100%", borderCollapse: "collapse", fontSize: 12 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tr", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { style: { textAlign: "left", padding: "4px 6px", borderBottom: "1px solid rgba(255,255,255,0.2)" }, children: "\u5C42\u7EA7" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { style: { textAlign: "left", padding: "4px 6px", borderBottom: "1px solid rgba(255,255,255,0.2)" }, children: "\u7C7B\u578B" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { style: { textAlign: "left", padding: "4px 6px", borderBottom: "1px solid rgba(255,255,255,0.2)" }, children: "\u4E3B\u9898" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { style: { textAlign: "left", padding: "4px 6px", borderBottom: "1px solid rgba(255,255,255,0.2)" }, children: "\u5185\u5BB9" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { style: { textAlign: "right", padding: "4px 6px", borderBottom: "1px solid rgba(255,255,255,0.2)" }, children: "\u91CD\u8981" })
          ] }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("tbody", { children: view.memories.map((m) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tr", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("td", { style: { padding: "4px 6px", borderBottom: "1px solid rgba(255,255,255,0.06)", whiteSpace: "nowrap" }, children: [
              layerLabel(m.layer),
              m.tier === 0 ? "\xB7T0" : ""
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { style: { padding: "4px 6px", borderBottom: "1px solid rgba(255,255,255,0.06)", whiteSpace: "nowrap" }, children: kindLabel(m.kind) }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { style: { padding: "4px 6px", borderBottom: "1px solid rgba(255,255,255,0.06)" }, children: m.topic }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { style: { padding: "4px 6px", borderBottom: "1px solid rgba(255,255,255,0.06)" }, children: m.content }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { style: { padding: "4px 6px", borderBottom: "1px solid rgba(255,255,255,0.06)", textAlign: "right" }, children: m.importance })
          ] }, m.id)) })
        ] })
      ] })
    ] })
  ] });
}
var inject = ["slots", "settingsScope"];
function apply(ctx) {
  const scope = ctx.settingsScope.bind({ namespace: "memory" });
  const loadIdentity = async () => {
    const resp = await fetch("/memory/identity", { cache: "no-store" });
    if (!resp.ok) return { soul: "", user: "" };
    const data = await resp.json();
    return { soul: typeof data.soul === "string" ? data.soul : "", user: typeof data.user === "string" ? data.user : "" };
  };
  const saveIdentity = async (file, content) => {
    try {
      const resp = await fetch("/memory/identity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file, content })
      });
      if (resp.ok) return { ok: true };
      const data = await resp.json().catch(() => ({}));
      return { ok: false, error: data.error ?? `HTTP ${resp.status}: ${resp.statusText}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "\u7F51\u7EDC\u9519\u8BEF" };
    }
  };
  const openEditor = async (file) => {
    try {
      const resp = await fetch("/memory/identity/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file })
      });
      if (resp.ok) return { ok: true };
      const data = await resp.json().catch(() => ({}));
      return { ok: false, error: data.error ?? `HTTP ${resp.status}: ${resp.statusText}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "\u7F51\u7EDC\u9519\u8BEF" };
    }
  };
  const runNow = async () => {
    const resp = await fetch("/memory/trigger", { method: "POST", headers: { "content-type": "application/json" } });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.ok) throw new Error(data.error ?? `HTTP ${resp.status}`);
    return data.result ?? {
      refined: false,
      forgetDemoted: 0,
      forgetArchivedMem: 0,
      forgetDeletedMem: 0,
      forgetArchivedEpi: 0,
      forgetDeletedEpi: 0
    };
  };
  const loadMemoryView = async () => {
    const resp = await fetch("/memory/view", { cache: "no-store" });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.ok) throw new Error(data.error ?? `HTTP ${resp.status}`);
    return {
      memories: Array.isArray(data.memories) ? data.memories : [],
      memoryCount: data.memoryCount ?? 0,
      episodeCount: data.episodeCount ?? 0,
      topics: Array.isArray(data.topics) ? data.topics : [],
      updatedMs: data.updatedMs ?? Date.now()
    };
  };
  const dispose = ctx.slots.inject("settings.section", () => ctx.slots.register(
    {
      name: "settings.section",
      id: "memory",
      order: 50,
      label: () => "\u8BB0\u5FC6",
      icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MemoryIcon, {}),
      inject: () => ({ scope, loadIdentity, saveIdentity, openEditor, runNow, loadMemoryView })
    },
    MemorySettingsPanel
  ));
  return () => {
    dispose();
  };
}
    return module.exports;
  }
});
//# sourceMappingURL=client.js.map
