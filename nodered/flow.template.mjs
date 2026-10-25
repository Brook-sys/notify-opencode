/**
 * Node-RED flow template for opencode-notify-nodered.
 *
 * Exports the flow definition with readable function-bodies. The webhook
 * token is the __OC_WEBHOOK_TOKEN__ placeholder — scripts/apply-nodered-flow.mjs
 * replaces it with the real token (read from ~/.config/opencode/opencode.jsonc)
 * before deploying, so the token never lives in this repository.
 *
 * Endpoints deployed by this flow:
 *   POST /opencode/event    — webhook called by the OpenCode plugin
 *   GET  /opencode/events   — last 30 processed events (JSON), for quick checks
 */

export const TAB_ID = "aa170c01e0000001"

const validateFunc = `// Valida o token do webhook e formata o evento vindo do OpenCode.
// Saída 1: http response | Saída 2: lane de notificação
const TOKEN = "__OC_WEBHOOK_TOKEN__";

const headers = msg.req && msg.req.headers ? msg.req.headers : {};
if ((headers["x-webhook-token"] || "") !== TOKEN) {
    msg.statusCode = 401;
    msg.payload = { error: "unauthorized" };
    return [msg, null];
}

const body = msg.payload || {};
const type = body.type || "unknown";

const meta = {
    question:   { priority: "high",   icon: "❓", label: "Pergunta" },
    permission: { priority: "high",   icon: "🔐", label: "Permissão aguardando" },
    done:       { priority: "normal", icon: "✅", label: "Terminou" },
    error:      { priority: "urgent", icon: "❗", label: "Erro" },
}[type] || { priority: "normal", icon: "🔔", label: type };

let title = meta.label;
let text = "";

if (type === "question") {
    if (body.header) title = "❓ " + body.header;
    text = body.question || "(pergunta sem texto)";
    if (Array.isArray(body.options) && body.options.length) {
        text += "\\nOpções: " + body.options.join(", ");
    }
} else if (type === "permission") {
    title = "🔐 Permissão: " + (body.action || "ação");
    text = Array.isArray(body.resources) && body.resources.length
        ? body.resources.join("\\n")
        : "(sem detalhes)";
} else if (type === "done") {
    if (body.title) title = "✅ " + body.title;
    text = (body.preview || "").trim() || "Turno concluído.";
    if (typeof body.durationSec === "number") text += "\\n(" + body.durationSec + "s)";
} else if (type === "error") {
    if (body.title) title = "❗ " + body.title;
    text = (body.preview || "").trim() || "Falha no turno.";
}

msg.notify = {
    type: type,
    priority: meta.priority,
    sessionID: body.sessionID || "",
    project: body.from || "",
    ts: body.ts || Date.now(),
    title: title,
    text: text,
    raw: body,
};

msg.statusCode = 200;
msg.payload = { ok: true };
return [msg, msg];`

const recordFunc = `// Guarda os últimos 30 eventos no flow context (memória: some ao reiniciar
// o Node-RED) e monta a notificação para o canal ntfy.
const events = flow.get("ocnotify:events") || [];
events.unshift({
    ts: msg.notify.ts,
    receivedAt: Date.now(),
    type: msg.notify.type,
    priority: msg.notify.priority,
    title: msg.notify.title,
    text: String(msg.notify.text).slice(0, 300),
    sessionID: msg.notify.sessionID,
    project: msg.notify.project,
});
if (events.length > 30) events.length = 30;
flow.set("ocnotify:events", events);

// Canal ntfy: publica pela API JSON (POST https://ntfy.sh/ com corpo JSON).
// Headers HTTP não aceitam nada além de Latin-1 — emoji no header "Title"
// faz o Node recusar o request ("invalid character in header content").
// No corpo JSON, emoji e acentos são bem-vindos.
// O tópico é preenchido pelo script de deploy a partir do placeholder reservado.
const NTFY_TOPIC = "__OC_NTFY_TOPIC__";
const NTFY_PRIORITY = { urgent: 5, high: 4, normal: 3 };
const NTFY_TAG = {
    question: "question",
    permission: "lock",
    done: "white_check_mark",
    error: "warning",
};
msg.headers = { "Content-Type": "application/json" };
msg.payload = JSON.stringify({
    topic: NTFY_TOPIC,
    title: String(msg.notify.title).slice(0, 250),
    message: String(msg.notify.text).slice(0, 1900),
    priority: NTFY_PRIORITY[msg.notify.priority] ?? 3,
    tags: ["opencode", NTFY_TAG[msg.notify.type]].filter(Boolean),
});
return msg;`

const listFunc = `// Devolve os últimos eventos processados (para conferência rápida).
const events = flow.get("ocnotify:events") || [];
msg.payload = { count: events.length, events: events };
msg.statusCode = 200;
return msg;`

export const flowNodes = [
  {
    id: "aa170c01e0000001",
    type: "tab",
    label: "OpenCode Notify",
    disabled: false,
    info: "Webhook de eventos do plugin opencode-notify-nodered.\nPOST /opencode/event  — recebe eventos (question/permission/done/error)\nGET  /opencode/events — últimos 30 eventos processados\n\nCanal ntfy: o nó 'Registra evento' publica pela API JSON do ntfy\n(POST https://ntfy.sh/ com topic/title/message/priority/tags no corpo).\nO tópico vem de options.ntfyTopic no opencode.jsonc, via script de deploy.",
    env: [],
  },
  {
    id: "aa170c01e0000002",
    type: "http in",
    z: TAB_ID,
    name: "POST /opencode/event",
    url: "/opencode/event",
    method: "post",
    upload: false,
    swaggerDoc: "",
    x: 180,
    y: 100,
    wires: [["aa170c01e0000003"]],
  },
  {
    id: "aa170c01e0000003",
    type: "function",
    z: TAB_ID,
    name: "Valida token + formata",
    func: validateFunc,
    outputs: 2,
    timeout: 0,
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 400,
    y: 100,
    wires: [["aa170c01e0000004"], ["aa170c01e0000005"]],
  },
  {
    id: "aa170c01e0000004",
    type: "http response",
    z: TAB_ID,
    name: "Resposta",
    statusCode: "",
    headers: {},
    x: 630,
    y: 60,
    wires: [],
  },
  {
    id: "aa170c01e0000005",
    type: "switch",
    z: TAB_ID,
    name: "Tipo de evento",
    property: "msg.notify.type",
    propertyType: "msg",
    rules: [
      { t: "eq", v: "question", vt: "str" },
      { t: "eq", v: "permission", vt: "str" },
      { t: "eq", v: "done", vt: "str" },
      { t: "eq", v: "error", vt: "str" },
      { t: "else" },
    ],
    checkall: "true",
    repair: false,
    outputs: 5,
    x: 640,
    y: 180,
    wires: [
      ["aa170c01e0000006"],
      ["aa170c01e0000006"],
      ["aa170c01e0000006"],
      ["aa170c01e0000006"],
      ["aa170c01e0000006"],
    ],
  },
  {
    id: "aa170c01e0000006",
    type: "function",
    z: TAB_ID,
    name: "Registra evento",
    func: recordFunc,
    outputs: 1,
    timeout: 0,
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 860,
    y: 180,
    wires: [["aa170c01e0000007", "aa170c01e0000008"]],
  },
  {
    id: "aa170c01e0000007",
    type: "debug",
    z: TAB_ID,
    name: "Evento OpenCode",
    active: true,
    tosidebar: true,
    console: false,
    tostatus: false,
    complete: "notify",
    targetType: "msg",
    statusVal: "",
    statusType: "auto",
    x: 1080,
    y: 140,
    wires: [],
  },
  {
    id: "aa170c01e0000008",
    type: "http request",
    z: TAB_ID,
    name: "CANAL ntfy (ntfy.sh)",
    method: "POST",
    ret: "txt",
    paytoqs: "ignore",
    url: "https://ntfy.sh/",
    tls: "",
    persist: false,
    proxy: "",
    insecureHTTPParser: false,
    authType: "",
    senderr: false,
    headers: [],
    x: 1120,
    y: 240,
    wires: [],
  },
  {
    id: "aa170c01e0000009",
    type: "http in",
    z: TAB_ID,
    name: "GET /opencode/events",
    url: "/opencode/events",
    method: "get",
    upload: false,
    swaggerDoc: "",
    x: 180,
    y: 320,
    wires: [["aa170c01e000000a"]],
  },
  {
    id: "aa170c01e000000a",
    type: "function",
    z: TAB_ID,
    name: "Lista últimos eventos",
    func: listFunc,
    outputs: 1,
    timeout: 0,
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 420,
    y: 320,
    wires: [["aa170c01e000000b"]],
  },
  {
    id: "aa170c01e000000b",
    type: "http response",
    z: TAB_ID,
    name: "Resposta (JSON)",
    statusCode: "",
    headers: { "content-type": "application/json" },
    x: 650,
    y: 320,
    wires: [],
  },
]
