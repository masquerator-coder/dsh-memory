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
  const [exporting, setExporting] = (0, import_react.useState)(false);
  const [importing, setImporting] = (0, import_react.useState)(false);
  const [backupNote, setBackupNote] = (0, import_react.useState)(null);
  const [backupError, setBackupError] = (0, import_react.useState)(null);
  const fileRef = (0, import_react.useRef)(null);
  const [models, setModels] = (0, import_react.useState)({ default: {}, candidates: [], failures: [] });
  (0, import_react.useEffect)(() => {
    props.loadModels().then(setModels).catch(() => {
    });
  }, [props.loadModels]);
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
  const doExport = async () => {
    setExporting(true);
    setBackupNote(null);
    setBackupError(null);
    try {
      const r = await props.exportBackup();
      if (r.ok) setBackupNote("\u5907\u4EFD\u5DF2\u5BFC\u51FA\uFF08\u5B8C\u6574 .db \u5FEB\u7167\uFF09\uFF0C\u8BF7\u59A5\u5584\u4FDD\u5B58\u3002");
      else setBackupError(r.error ?? "\u5BFC\u51FA\u5931\u8D25");
    } finally {
      setExporting(false);
    }
  };
  const doImport = async (f) => {
    if (!f) return;
    setImporting(true);
    setBackupNote(null);
    setBackupError(null);
    try {
      const r = await props.importBackup(f);
      if (r.ok) {
        setBackupNote(`\u5DF2\u4ECE\u5907\u4EFD\u6062\u590D\uFF1A${r.memories} \u6761\u8BB0\u5FC6\u3001${r.episodes} \u6761\u4F1A\u8BDD\u6458\u8981\u3002\u5BFC\u5165\u524D\u7684\u72B6\u6001\u5DF2\u5B58\u4E3A memory.db.pre-import.bak \u4EE5\u4FBF\u56DE\u6EDA\u3002`);
      } else {
        setBackupError(r.error ?? "\u5BFC\u5165\u5931\u8D25");
      }
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
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
        label: "\u7CFB\u7EDF\u63D0\u793A\u6CE8\u5165\u5F53\u524D\u65E5\u671F",
        hint: "\u4F1A\u8BDD\u5F00\u59CB\u65F6\u5728\u7CFB\u7EDF\u63D0\u793A\u8BCD\u91CC\u52A0\u4E0A\u771F\u5B9E\u4E16\u754C\u65E5\u671F\uFF08\u4E92\u8054\u7F51\u6388\u65F6\u3001\u672C\u673A\u65F6\u533A\uFF09\uFF0C\u8BA9\u6A21\u578B\u4E0D\u590D\u9677\u5165\u2018\u4E0D\u77E5\u9053\u4ECA\u5929\u662F\u51E0\u53F7\u2019",
        checked: value.timeInjection ?? true,
        disabled: !ready,
        onChange: (next) => set("timeInjection", next)
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
    (() => {
      const mode = value.refineModelMode === "manual" ? "manual" : "auto";
      const provider = value.refineModelProvider ?? "";
      const model = value.refineModel ?? "";
      const pairKey = `${provider}::${model}`;
      const hasCandidate = models.candidates.some((c) => `${c.provider}::${c.model}` === pairKey);
      const defRoute = models.default && models.default.provider && models.default.model ? `${models.default.provider}/${models.default.model}` : null;
      return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { borderTop: "1px solid rgba(128,128,128,0.25)", padding: "8px 0", marginTop: 4 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 10, padding: "4px 0" }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { flex: 1 }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { children: "\u51DD\u7EC3\u6A21\u578B" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { fontSize: 12, opacity: 0.7 }, children: "L1 \u62BD\u53D6 / L2 \u5408\u5E76 / \u6559\u8BAD\u5347\u683C / \u4F1A\u8BDD\u6536\u53E3\u7B49\u6574\u7406\u8C03\u7528\u6240\u7528\u6A21\u578B" })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
            "select",
            {
              value: mode,
              disabled: !ready,
              onChange: (e) => set("refineModelMode", e.target.value),
              style: { padding: "4px 6px" },
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "auto", children: "\u81EA\u52A8\uFF08\u8DDF\u968F\u4F1A\u8BDD / dsh \u9ED8\u8BA4\uFF09" }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "manual", children: "\u624B\u52A8\u6307\u5B9A" })
              ]
            }
          )
        ] }),
        mode === "manual" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: 6, padding: "4px 0" }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
            "select",
            {
              value: hasCandidate ? pairKey : "__custom",
              disabled: !ready,
              onChange: (e) => {
                const v = e.target.value;
                if (v === "__custom" || v === "") return;
                const sep = v.indexOf("::");
                if (sep > 0) {
                  set("refineModelProvider", v.slice(0, sep));
                  set("refineModel", v.slice(sep + 2));
                }
              },
              style: { padding: "4px 6px" },
              children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "__custom", children: "\u81EA\u5B9A\u4E49\u2026\uFF08\u624B\u52A8\u8F93\u5165\uFF09" }),
                models.candidates.map((c) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("option", { value: `${c.provider}::${c.model}`, children: [
                  c.provider,
                  "/",
                  c.model
                ] }, `${c.provider}::${c.model}`))
              ]
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 8, alignItems: "center" }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                placeholder: "provider\uFF08\u5982 deepseek-official\uFF09",
                disabled: !ready,
                value: provider,
                onChange: (e) => set("refineModelProvider", e.target.value),
                style: { width: 170, padding: "4px 6px" }
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                placeholder: "model\uFF08\u5982 deepseek-v4-flash\uFF09",
                disabled: !ready,
                value: model,
                onChange: (e) => set("refineModel", e.target.value),
                style: { width: 170, padding: "4px 6px" }
              }
            )
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { fontSize: 12, opacity: 0.75, paddingTop: 2 }, children: mode === "auto" ? defRoute ? `\u81EA\u52A8\u8DDF\u968F\uFF1A\u4F1A\u8BDD\u6240\u7528\u6A21\u578B \u2192 dsh \u9ED8\u8BA4\uFF08${defRoute}\uFF09` : "\u81EA\u52A8\u8DDF\u968F\uFF1A\u4F1A\u8BDD\u6240\u7528\u6A21\u578B \u2192 dsh \u9ED8\u8BA4\u6A21\u578B" : provider && model ? `\u624B\u52A8\u56FA\u5B9A\uFF1A${provider}/${model}` : "\u624B\u52A8\u503C\u672A\u586B\u5B8C\u6574\uFF0C\u6682\u6309\u81EA\u52A8\u8DDF\u968F" }),
        models.failures.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { fontSize: 11, opacity: 0.6, paddingTop: 2 }, children: [
          "\u90E8\u5206\u63D0\u4F9B\u65B9\u6A21\u578B\u5217\u8868\u8BFB\u53D6\u5931\u8D25\uFF08",
          models.failures.map((f) => f.name).join("\u3001"),
          "\uFF09\u2014\u2014\u53EF\u76F4\u63A5\u7528\u201C\u81EA\u5B9A\u4E49\u2026\u201D\u8F93\u5165\u3002"
        ] })
      ] });
    })(),
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
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", padding: "10px 0", borderTop: "1px solid rgba(128,128,128,0.25)", marginTop: 4 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: exporting, onClick: () => {
        void doExport();
      }, style: { padding: "6px 10px" }, children: exporting ? "\u5BFC\u51FA\u4E2D\u2026" : "\u5BFC\u51FA\u5907\u4EFD" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: importing, onClick: () => fileRef.current?.click(), style: { padding: "6px 10px" }, children: importing ? "\u5BFC\u5165\u4E2D\u2026" : "\u5BFC\u5165\u5907\u4EFD" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "input",
        {
          ref: fileRef,
          type: "file",
          accept: ".db,.sqlite,.sqlite3",
          style: { display: "none" },
          onChange: (e) => {
            void doImport(e.target.files?.[0]);
          }
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { fontSize: 12, opacity: 0.7 }, children: [
        "\u5BFC\u51FA\u4E3A\u5B8C\u6574 .db \u5FEB\u7167\uFF08\u542B\u8BB0\u5FC6\u3001\u4F1A\u8BDD\u6458\u8981\u3001\u5BA1\u8BA1\u4E0E\u7EA0\u9519\u8F68\u8FF9\uFF09\uFF1B\u5BFC\u5165\u5C06",
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("b", { children: "\u66FF\u6362" }),
        "\u5168\u90E8\u73B0\u6709\u6570\u636E\uFF0C\u5BFC\u5165\u524D\u81EA\u52A8\u5B58\u56DE\u6EDA\u5907\u4EFD\u3002"
      ] })
    ] }),
    backupNote && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { fontSize: 12, color: "#0a7a2f" }, children: backupNote }),
    backupError && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { fontSize: 12, color: "#c00" }, children: backupError }),
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
  const loadModels = async () => {
    const resp = await fetch("/memory/models", { cache: "no-store" });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error ?? `HTTP ${resp.status}`);
    return {
      default: data.default && typeof data.default === "object" ? data.default : {},
      candidates: Array.isArray(data.candidates) ? data.candidates : [],
      failures: Array.isArray(data.failures) ? data.failures : []
    };
  };
  const exportBackup = async () => {
    try {
      const resp = await fetch("/memory/backup/export", { cache: "no-store" });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        return { ok: false, error: data.error ?? `HTTP ${resp.status}: ${resp.statusText}` };
      }
      const blob = await resp.blob();
      const name = resp.headers.get("content-disposition")?.match(/filename="?([^";]+)"?/)?.[1] ?? "dsh-memory-backup.db";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "\u7F51\u7EDC\u9519\u8BEF" };
    }
  };
  const importBackup = async (file) => {
    try {
      const buf = await file.arrayBuffer();
      const resp = await fetch("/memory/backup/import", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: buf
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.ok) return { ok: false, memories: 0, episodes: 0, error: data.error ?? `HTTP ${resp.status}: ${resp.statusText}` };
      return { ok: true, memories: data.memories ?? 0, episodes: data.episodes ?? 0 };
    } catch (e) {
      return { ok: false, memories: 0, episodes: 0, error: e instanceof Error ? e.message : "\u7F51\u7EDC\u9519\u8BEF" };
    }
  };
  const dispose = ctx.slots.inject("settings.section", () => ctx.slots.register(
    {
      name: "settings.section",
      id: "memory",
      order: 50,
      label: () => "\u8BB0\u5FC6",
      icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MemoryIcon, {}),
      inject: () => ({ scope, loadIdentity, saveIdentity, openEditor, runNow, loadMemoryView, exportBackup, importBackup, loadModels })
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
