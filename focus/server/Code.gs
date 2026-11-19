/**
 * Focus — server side (Google Apps Script web app): a passcode-checked relay to the AI.
 *
 * Keeps the AI API key OFF the public website. The /focus/ page sends
 * { pass, action: "ai", system, user, schema, fast } — the instructions come from focus/brain.js in the repo —
 * and this script checks the passcode, adds the secret key, asks the AI for JSON matching the schema and
 * returns { ok, data, provider }. Changing how the AI asks or plans is an edit to brain.js: no redeploy here.
 *
 * AI providers — add one or more FREE keys in Script properties; they are tried in order until one answers
 * (Gemini → Groq → Cerebras → OpenRouter → Mistral → Claude), so a busy free tier just moves on to the next:
 *   GEMINI_API_KEY (aistudio.google.com) · GROQ_API_KEY (console.groq.com) · CEREBRAS_API_KEY (cloud.cerebras.ai)
 *   OPENROUTER_API_KEY (openrouter.ai/keys, ":free" models only) · MISTRAL_API_KEY (console.mistral.ai, free plan)
 *   ANTHROPIC_API_KEY (paid, optional). Free tiers are rate-limited and may use prompts to improve their products.
 *   AI_ORDER (optional) changes the order. Models are picked automatically from each provider's list and
 *   remembered for a week; <NAME>_MODEL (e.g. GEMINI_MODEL, GROQ_MODEL) pins one.
 *
 * Setup (once):
 *  1. script.google.com → New project → paste this file.
 *  2. Project Settings → Script properties → add the key above and
 *       FOCUS_PASSCODE    = a long passcode you make up (also typed into /focus/ ⚙ on each device)
 *  3. Press ▶ Run (runs testAI, the first function) → Allow. The log shows ✓ or ✗ for every provider you added.
 *  4. Deploy → New deployment → Web app → Execute as: Me · Who has access: Anyone → copy the /exec URL.
 *     After pasting a newer version of this file: Deploy → Manage deployments → Edit → Version: New version.
 *     ("Anyone" is needed so the page can call it without a Google sign-in; the passcode is the lock.)
 *
 * Nothing is stored here except a per-day request counter (DAILY_LIMIT caps use if the passcode leaks).
 * Whatever the page sends (goal, steps, its own focus log for 📊) is passed to the AI and not stored here.
 */

// Run this once from the editor (it is the first function, so just press ▶ Run): it asks for permission to call the AI over the
// internet (click Allow), then shows in the log whether the key and model work.
function testAI() {
  var props = PropertiesService.getScriptProperties(), list = providers_(props);
  if (!props.getProperty("FOCUS_PASSCODE")) Logger.log("✗ FOCUS_PASSCODE is missing in Script properties");
  if (!list.length) { Logger.log("✗ No AI key in Script properties (GEMINI_API_KEY, GROQ_API_KEY, CEREBRAS_API_KEY, OPENROUTER_API_KEY, MISTRAL_API_KEY)"); return; }
  Logger.log("Order: " + list.map(function (p) { return p.name; }).join(" → "));
  list.forEach(function (ai) {
    var model = ai.name === "gemini" ? geminiModel_(ai, true, true) : ai.name === "claude" ? MODEL : compatModel_(ai, true);
    var t0 = Date.now();
    var got = askAI_(ai, "Reply with ONE tiny next action in Thai to start working.", "I want to start working.", { type: "object", properties: { action: { type: "string" } }, required: ["action"], additionalProperties: false }, "low", 1024);
    Logger.log((got.ok ? "✓ " : "✗ ") + ai.name + " · " + (model || "NO MODEL FOUND (key wrong?)") + " · " + ((Date.now() - t0) / 1000).toFixed(1) + " s · " +
      (got.ok ? got.data.action : got.error + (got.detail ? " — " + got.detail : "") + (ai.why ? " — " + ai.why : "")));
  });
}

var MODEL = "claude-opus-5-5";
var DAILY_LIMIT = 150;








function doGet() {
  return json_({ ok: true, service: "focus" });
}

function doPost(e) {
  try { return handle_(e); } catch (x) { // never answer with an HTML error page: say what broke
    return json_({ ok: false, error: "server_exception", detail: clip_(x && x.message, 200) });
  }
}

function handle_(e) {
  var req;
  try { req = JSON.parse(e.postData.contents); } catch (x) { return json_({ ok: false, error: "bad_request" }); }

  var props = PropertiesService.getScriptProperties();
  var pass = props.getProperty("FOCUS_PASSCODE"), ai = provider_(props);
  if (!pass || !ai) return json_({ ok: false, error: "server_not_configured" });
  if (!sameText_(String(req.pass || ""), pass)) { Utilities.sleep(800); return json_({ ok: false, error: "unauthorized" }); }
  if (req.ping) return json_({ ok: true, pong: true, provider: ai.name, providers: providers_(props).map(function (p) { return p.name; }), relay: 2 });
  if (req.action !== "ai") return json_({ ok: false, error: "server_outdated", detail: "this page is newer or older than the script" });

  // the relay: the page (focus/brain.js in the repo) sends the instructions; this script adds the secret key
  var system = String(req.system || "").slice(0, 12000), user = String(req.user || "").slice(0, 80000), schema = req.schema;
  if (!system || !user || !schema || typeof schema !== "object" || JSON.stringify(schema).length > 4000) return json_({ ok: false, error: "bad_request" });
  if (!countToday_(props)) return json_({ ok: false, error: "daily_limit" });
  var fast = req.fast !== false, maxTokens = Math.max(256, Math.min(8000, parseInt(req.max_tokens, 10) || 1024));
  var got = askAny_(props, system, user, schema, fast ? "low" : "medium", maxTokens);
  if (!got.ok) return json_({ ok: false, error: got.error, detail: clip_(got.detail, 400) });
  return json_({ ok: true, data: got.data, provider: got.provider });
}

// ===== providers: every free AI API with a key in Script properties, tried in order until one answers =====
// Free tiers (each needs its own free key; add as many as you like — more keys = fewer "busy" errors):
//   GEMINI_API_KEY     aistudio.google.com
//   GROQ_API_KEY       console.groq.com            (very fast)
//   CEREBRAS_API_KEY   cloud.cerebras.ai           (very fast)
//   OPENROUTER_API_KEY openrouter.ai/keys          (only its ":free" models are used)
//   MISTRAL_API_KEY    console.mistral.ai          (free "Experiment" plan)
//   ANTHROPIC_API_KEY  console.anthropic.com       (paid, optional, tried last)
// AI_ORDER (optional) changes the order, e.g. "groq, gemini, openrouter". <NAME>_MODEL (e.g. GROQ_MODEL) pins a model.
var ORDER = ["gemini", "groq", "cerebras", "openrouter", "mistral", "claude"];
var COMPAT = { // OpenAI-compatible chat APIs; the model is picked from the provider's own model list (names change often)
  groq: { base: "https://api.groq.com/openai/v1", key: "GROQ_API_KEY",
    skip: /whisper|guard|tts|playai|compound|embed|vision|distil|saba|prompt/i, prefer: [/gpt-oss-120b/i, /llama-3\.3-70b/i, /qwen/i, /llama/i, /gpt-oss/i] },
  cerebras: { base: "https://api.cerebras.ai/v1", key: "CEREBRAS_API_KEY",
    skip: /embed|vision/i, prefer: [/gpt-oss/i, /qwen/i, /llama-3\.3-70b/i, /llama/i] },
  openrouter: { base: "https://openrouter.ai/api/v1", key: "OPENROUTER_API_KEY", freeOnly: true,
    skip: /vision|image|audio|embed/i, prefer: [/deepseek/i, /qwen/i, /llama-3\.3-70b/i, /gemma/i, /mistral/i, /llama/i] },
  mistral: { base: "https://api.mistral.ai/v1", key: "MISTRAL_API_KEY",
    skip: /embed|moderation|ocr|codestral|pixtral|voxtral/i, prefer: [/^mistral-small-latest$/i, /^mistral-medium-latest$/i, /small/i, /medium/i] }
};
function providers_(props) {
  var keyName = { gemini: "GEMINI_API_KEY", claude: "ANTHROPIC_API_KEY" };
  Object.keys(COMPAT).forEach(function (n) { keyName[n] = COMPAT[n].key; });
  var order = String(props.getProperty("AI_ORDER") || "").toLowerCase().split(/[\s,]+/).filter(function (n) { return keyName[n]; });
  if (String(props.getProperty("AI_PROVIDER") || "").toLowerCase() === "claude") order.unshift("claude"); // older setting
  ORDER.forEach(function (n) { if (order.indexOf(n) < 0) order.push(n); });
  var seen = {};
  return order.filter(function (n) { if (seen[n]) return false; seen[n] = 1; return !!props.getProperty(keyName[n]); })
    .map(function (n) { return { name: n, key: props.getProperty(keyName[n]), props: props }; });
}
function provider_(props) { return providers_(props)[0] || null; } // "is anything configured?"
// ask each configured provider in turn until one answers; stop trying new ones after ~25 s so the page gets an answer
function askAny_(props, system, user, schema, effort, maxTokens) {
  var list = providers_(props), errs = [], last = { ok: false, error: "server_not_configured" }, t0 = Date.now();
  for (var i = 0; i < list.length; i++) {
    if (i > 0 && Date.now() - t0 > 25000) break;
    var r = askAI_(list[i], system, user, schema, effort, maxTokens);
    if (r.ok) { r.provider = list[i].name; return r; }
    last = r; errs.push(list[i].name + ": " + r.error + (r.detail ? " (" + clip_(r.detail, 70) + ")" : ""));
  }
  return { ok: false, error: last.error, detail: errs.join(" · ") };
}
function askAI_(ai, system, user, schema, effort, maxTokens) {
  if (ai.name === "claude") {
    return callClaude_(ai.key, {
      model: MODEL, max_tokens: maxTokens, system: system,
      messages: [{ role: "user", content: user }],
      output_config: { effort: effort, format: { type: "json_schema", schema: schema } },
      fallbacks: "default"
    });
  }
  if (ai.name === "gemini") return callGemini_(ai, system, user, schema, maxTokens, effort === "low");
  return callCompat_(ai, system, user, schema, maxTokens);
}

// ===== OpenAI-compatible free APIs (Groq, Cerebras, OpenRouter, Mistral) =====
function callCompat_(ai, system, user, schema, maxTokens) {
  var c = COMPAT[ai.name], model = compatModel_(ai, false);
  if (!model) return { ok: false, error: "no_model", detail: ai.why || "" };
  var res = compatPost_(ai, c, model, system, user, schema, maxTokens, true);
  var msg = function () { return (res && res.data && res.data.error && (res.data.error.message || res.data.error)) || ""; };
  if (res && res.code === 400 && /response_format|json/i.test(String(msg()))) res = compatPost_(ai, c, model, system, user, schema, maxTokens, false);
  if (res && (res.code === 404 || (res.code === 400 && /model/i.test(String(msg()))))) { // model gone: pick again
    model = compatModel_(ai, true);
    if (!model) return { ok: false, error: "no_model", detail: ai.why || "" };
    res = compatPost_(ai, c, model, system, user, schema, maxTokens, true);
  }
  if (!res || res.failed) return { ok: false, error: "network", detail: (res && res.failed) || "" };
  var why = String(msg());
  if (res.code === 429) return { ok: false, error: "rate_limited", detail: why };
  if (res.code !== 200) return { ok: false, error: "upstream_" + res.code, detail: why };
  var ch = ((res.data || {}).choices || [])[0], text = String((ch && ch.message && ch.message.content) || "");
  text = text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  var a = text.indexOf("{"), b = text.lastIndexOf("}");
  try { return { ok: true, data: JSON.parse(a >= 0 && b > a ? text.slice(a, b + 1) : text) }; } catch (x) { return { ok: false, error: "bad_output" }; }
}
function compatPost_(ai, c, model, system, user, schema, maxTokens, jsonMode) {
  var body = { model: model, max_tokens: maxTokens, temperature: 0.6, messages: [
    { role: "system", content: system + " Reply with only a JSON object matching this JSON Schema: " + JSON.stringify(schema) },
    { role: "user", content: user }] };
  if (jsonMode) body.response_format = { type: "json_object" };
  try {
    var r = UrlFetchApp.fetch(c.base + "/chat/completions", { method: "post", contentType: "application/json",
      headers: { Authorization: "Bearer " + ai.key }, payload: JSON.stringify(body), muteHttpExceptions: true });
    var data = null; try { data = JSON.parse(r.getContentText()); } catch (x) {}
    return { code: r.getResponseCode(), data: data };
  } catch (x) { return { failed: String(x && x.message || x) }; }
}
function compatModel_(ai, refresh) {
  var c = COMPAT[ai.name], P = ai.name.toUpperCase();
  var pinned = ai.props.getProperty(P + "_MODEL");
  if (pinned && !refresh) return pinned;
  var cached = String(ai.props.getProperty(P + "_MODEL_AUTO") || "").split("|");
  if (!refresh && cached[0] && Date.now() - Number(cached[1] || 0) < 7 * 86400000) return cached[0];
  var ids = [];
  try {
    var r = UrlFetchApp.fetch(c.base + "/models", { headers: { Authorization: "Bearer " + ai.key }, muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) ai.why = "list models " + r.getResponseCode();
    else (JSON.parse(r.getContentText()).data || []).forEach(function (m) {
      var id = String(m.id || "");
      if (c.freeOnly && !/:free$/.test(id) && !(m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0)) return;
      if (m.active === false) return;
      if (id && !c.skip.test(id)) ids.push(id);
    });
  } catch (x) { ai.why = String(x && x.message || x); }
  var best = null;
  for (var i = 0; i < c.prefer.length && !best; i++) best = ids.filter(function (id) { return c.prefer[i].test(id); }).sort(function (a, b) { return a.length - b.length; })[0] || null;
  best = best || ids[0] || null;
  if (best) ai.props.setProperty(P + "_MODEL_AUTO", best + "|" + Date.now());
  return best || pinned || cached[0] || null;
}

// ===== Gemini (free tier) =====
var GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/";
function callGemini_(ai, system, user, schema, maxTokens, fast) {
  var model = geminiModel_(ai, false, fast);
  if (!model) return { ok: false, error: "no_model", detail: ai.why || "" };
  var res = geminiPost_(ai, model, system, user, schema, maxTokens, fast);
  if (res && res.code === 404) { // model retired or renamed: find a current one and retry once
    model = geminiModel_(ai, true, fast);
    if (!model) return { ok: false, error: "no_model", detail: ai.why || "" };
    res = geminiPost_(ai, model, system, user, schema, maxTokens, fast);
  }
  if (!res || res.failed) return { ok: false, error: "network", detail: (res && res.failed) || "" };
  var why = (res.data && res.data.error && res.data.error.message) || "";
  if (res.code === 429) return { ok: false, error: "rate_limited", detail: why };
  if (res.code !== 200) return { ok: false, error: "upstream_" + res.code, detail: why };
  var d = res.data || {};
  if (d.promptFeedback && d.promptFeedback.blockReason) return { ok: false, error: "refusal" };
  var c = (d.candidates || [])[0];
  if (!c || c.finishReason === "SAFETY" || c.finishReason === "PROHIBITED_CONTENT") return { ok: false, error: "refusal" };
  var text = ((c.content && c.content.parts) || []).map(function (p) { return p.text || ""; }).join("");
  text = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""); // tolerate a fenced reply
  try { return { ok: true, data: JSON.parse(text) }; } catch (x) { return { ok: false, error: "bad_output" }; }
}
function geminiPost_(ai, model, system, user, schema, maxTokens, fast) {
  // JSON mode + the shape described in the instruction (works across Gemini versions)
  var body = {
    system_instruction: { parts: [{ text: system + " Reply with only a JSON object matching this JSON Schema: " + JSON.stringify(schema) }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: { response_mime_type: "application/json", maxOutputTokens: maxTokens }
  };
  // one short step needs no long "thinking": it made replies take 40 s+. Older/other models may reject the field → retry without it.
  if (fast) body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
  var r1 = geminiSend_(ai, model, body);
  if (fast && r1 && r1.code === 400) { delete body.generationConfig.thinkingConfig; return geminiSend_(ai, model, body); }
  return r1;
}
function geminiSend_(ai, model, body) {
  try {
    var r = UrlFetchApp.fetch(GEMINI_API + "models/" + encodeURIComponent(model) + ":generateContent", {
      method: "post", contentType: "application/json", headers: { "x-goog-api-key": ai.key },
      payload: JSON.stringify(body), muteHttpExceptions: true
    });
    var data = null;
    try { data = JSON.parse(r.getContentText()); } catch (x) {}
    return { code: r.getResponseCode(), data: data };
  } catch (x) { return { failed: String(x && x.message || x) }; } // e.g. "no permission to call UrlFetchApp" until testAI is run once
}
// newest stable "flash" model this key can call; cached for a week, re-found when it disappears
function geminiModel_(ai, refresh, fast) {
  var pinned = ai.props.getProperty("GEMINI_MODEL");
  if (pinned && !refresh) return pinned;
  var KEY = fast ? "GEMINI_MODEL_FAST" : "GEMINI_MODEL_AUTO"; // fast = a "lite" model for the quick next-step answers
  var cached = ai.props.getProperty(KEY) || "", parts = cached.split("|");
  if (!refresh && parts[0] && Date.now() - Number(parts[1] || 0) < 7 * 86400000) return parts[0];
  var names = [];
  try {
    var page = "";
    for (var i = 0; i < 5; i++) {
      var r = UrlFetchApp.fetch(GEMINI_API + "models?pageSize=200" + (page ? "&pageToken=" + encodeURIComponent(page) : ""), { headers: { "x-goog-api-key": ai.key }, muteHttpExceptions: true });
      if (r.getResponseCode() !== 200) {
        try { ai.why = "list models " + r.getResponseCode() + ": " + JSON.parse(r.getContentText()).error.message; } catch (x) { ai.why = "list models " + r.getResponseCode(); }
        break;
      }
      var d = JSON.parse(r.getContentText());
      (d.models || []).forEach(function (m) {
        if ((m.supportedGenerationMethods || []).indexOf("generateContent") >= 0) names.push(String(m.name || "").replace(/^models\//, ""));
      });
      page = d.nextPageToken; if (!page) break;
    }
  } catch (x) { ai.why = String(x && x.message || x); }
  var best = pickGemini_(names, fast);
  if (best) ai.props.setProperty(KEY, best + "|" + Date.now());
  return best || pinned || parts[0] || null;
}
function pickGemini_(names, fast) {
  var skip = /(preview|exp|experimental|image|tts|audio|live|vision|embedding|aqa|learnlm|robotics|thinking|latest|-\d{3,}$)/i;
  function ver(n) { var m = n.match(/gemini-(\d+(?:\.\d+)?)/i); return m ? parseFloat(m[1]) : 0; }
  function rank(list) { return list.sort(function (a, b) { return ver(b) - ver(a) || a.length - b.length; })[0]; }
  var ok = names.filter(function (n) { return /^gemini-/i.test(n) && !skip.test(n); });
  if (fast) { var lite = rank(ok.filter(function (n) { return /flash/i.test(n) && /lite/i.test(n); })); if (lite) return lite; }
  return rank(ok.filter(function (n) { return /flash/i.test(n) && !/lite/i.test(n); }))
      || rank(ok.filter(function (n) { return /flash/i.test(n); }))
      || rank(ok) || null;
}

// one Messages API call with structured output → { ok, data } or { ok:false, error }
function callClaude_(key, body) {
  var res;
  try {
    res = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
      method: "post",
      contentType: "application/json",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2026-10-21",
        "anthropic-beta": "server-side-fallback-2026-07-01"
      },
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });
  } catch (x) {
    return { ok: false, error: "network", detail: String(x && x.message || x) };
  }
  var code = res.getResponseCode(), data;
  try { data = JSON.parse(res.getContentText()); } catch (x) { return { ok: false, error: "bad_upstream" }; }
  if (code !== 200) return { ok: false, error: "upstream_" + code, detail: (data && data.error && data.error.message) || "" };
  if (data.stop_reason === "refusal") return { ok: false, error: "refusal" };
  var text = null;
  (data.content || []).forEach(function (b) { if (b.type === "text" && text === null) text = b.text; });
  try { return { ok: true, data: JSON.parse(text) }; } catch (x) { return { ok: false, error: "bad_output" }; }
}

// ---- helpers ----
function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
function clip_(s, n) {
  return String(s == null ? "" : s).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);
}
function sameText_(a, b) { // compare without stopping at the first difference
  if (a.length !== b.length) return false;
  var d = 0;
  for (var i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function countToday_(props) {
  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    var day = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd");
    var raw = props.getProperty("FOCUS_COUNT") || "", parts = raw.split(":");
    var n = parts[0] === day ? Number(parts[1] || 0) : 0;
    if (n >= DAILY_LIMIT) return false;
    props.setProperty("FOCUS_COUNT", day + ":" + (n + 1));
    return true;
  } finally {
    lock.releaseLock();
  }
}
