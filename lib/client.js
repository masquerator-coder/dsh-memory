window.__ModuleLoader__.load({
  id: "memory",
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
  (0, import_react.useEffect)(() => setDraft(props.value), [props.value]);
  const save = async () => {
    setSaving(true);
    const ok = await props.onSave(draft);
    setSaving(false);
    if (!ok) setDraft(props.value);
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
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: saving, onClick: () => {
      void save();
    }, style: { marginTop: 6 }, children: saving ? "\u4FDD\u5B58\u4E2D\u2026" : "\u4FDD\u5B58" })
  ] });
}
function MemorySettingsPanel(props) {
  const snap = useScope(props.scope);
  const value = snap.value ?? {};
  const ready = snap.status === "ready" && snap.writable;
  const [identity, setIdentity] = (0, import_react.useState)({ soul: "", user: "" });
  (0, import_react.useEffect)(() => {
    props.loadIdentity().then(setIdentity).catch(() => {
    });
  }, [props.loadIdentity]);
  const set = (field, next) => {
    void props.scope.set(field, next);
  };
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
        label: "user.md \u81EA\u52A8\u8FDB\u5316",
        hint: "\u81EA\u52A8\u628A\u7A33\u5B9A\u7528\u6237\u8BB0\u5FC6\u589E\u91CF\u5199\u5165 user.md\uFF08\u65E0\u65B0\u589E\u5185\u5BB9\u5219\u4E0D\u5199\uFF09",
        checked: value.identityAuto ?? true,
        disabled: !ready,
        onChange: (next) => set("identityAuto", next)
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
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: { display: "flex", alignItems: "center", gap: 10, padding: "8px 0" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { flex: 1 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { children: "\u8EAB\u4EFD\u7EF4\u62A4\u626B\u63CF\u95F4\u9694\uFF08\u5C0F\u65F6\uFF09" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { fontSize: 12, opacity: 0.7 }, children: "user.md \u81EA\u52A8\u540C\u6B65\u7684\u5468\u671F" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "input",
        {
          type: "number",
          min: 1,
          step: 1,
          disabled: !ready,
          value: Math.round((value.identityIntervalMs ?? 6 * 36e5) / 36e5),
          onChange: (e) => {
            const h = Math.max(1, Math.round(Number(e.target.value) || 1));
            set("identityIntervalMs", h * 36e5);
          },
          style: { width: 64 }
        }
      )
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(FileEditor, { label: "soul.md\uFF08AI \u4EBA\u683C/\u884C\u4E3A\u51C6\u5219\uFF0C\u4EBA\u5199\uFF09", value: identity.soul, onSave: (content) => props.saveIdentity("soul", content) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(FileEditor, { label: "user.md\uFF08\u7528\u6237\u753B\u50CF\uFF0C\u81EA\u52A8\u540C\u6B65 + \u53EF\u7F16\u8F91\uFF09", value: identity.user, onSave: (content) => props.saveIdentity("user", content) })
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
      return resp.ok;
    } catch {
      return false;
    }
  };
  const dispose = ctx.slots.inject("settings.section", () => ctx.slots.register(
    {
      name: "settings.section",
      id: "memory",
      order: 50,
      label: () => "\u8BB0\u5FC6",
      inject: () => ({ scope, loadIdentity, saveIdentity })
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
