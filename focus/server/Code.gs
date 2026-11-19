/**
 * Focus — server side (Google Apps Script web app): a passcode-checked relay to the AI.
 *
 * Keeps the AI API key OFF the public website. The /focus/ page sends
 * { pass, action: "ai", system, user, schema, fast } — the instructions come from focus/brain.js in the repo —
 * and this script checks the passcode, adds the secret key, asks the AI for JSON matching the schema and
 * returns { ok, data, provider }. Changing how the AI asks or plans is an edit to brain.js: no redeploy here.
 *
 * AI provider — set ONE key (Script properties):
 *   GEMINI_API_KEY    = free key from aistudio.google.com (no card needed; free tier is rate-limited and
 *                       Google may use free-tier prompts to improve its products)
 *   ANTHROPIC_API_KEY = paid key from console.anthropic.com (Claude)
 *   If both are set, AI_PROVIDER = "gemini" or "claude" picks one (default: gemini).
 *   GEMINI_MODEL (optional) pins a Gemini model id; otherwise current models are found automatically
 *   (a fast "flash-lite" for quick answers, "flash" for analysis) and remembered for a week.
 *
 * Setup (once):
 *  1. script.google.com → New project → paste this file.
 *  2. Project Settings → Script properties → add the key above and
 *       FOCUS_PASSCODE    = a long passcode you make up (also typed into /focus/ ⚙ on each device)
 *  3. Press ▶ Run (runs testAI, the first function) → Allow. The log must say "✓ AI answered".
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
  var props = PropertiesService.getScriptProperties(), ai = provider_(props);
  if (!props.getProperty("FOCUS_PASSCODE")) Logger.log("✗ FOCUS_PASSCODE is missing in Script properties");
  if (!ai) { Logger.log("✗ No GEMINI_API_KEY (or ANTHROPIC_API_KEY) in Script properties"); return; }
  Logger.log("Provider: " + ai.name + (ai.name === "gemini" ? " · model: " + (geminiModel_(ai, true, true) || "NONE FOUND (key wrong?)") : ""));
  var t0 = Date.now();
  var got = askAI_(ai, "Reply with ONE tiny next action in Thai to start working.", "I want to start working.", { type: "object", properties: { action: { type: "string" } }, required: ["action"], additionalProperties: false }, "low", 1024);
  Logger.log("Took " + ((Date.now() - t0) / 1000).toFixed(1) + " s");
  Logger.log(got.ok ? "✓ AI answered: " + got.data.action : "✗ AI error: " + got.error + (got.detail ? " — " + got.detail : ""));
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
  if (req.ping) return json_({ ok: true, pong: true, provider: ai.name, relay: 1 });
  if (req.action !== "ai") return json_({ ok: false, error: "server_outdated", detail: "this page is newer or older than the script" });

  // the relay: the page (focus/brain.js in the repo) sends the instructions; this script adds the secret key
  var system = String(req.system || "").slice(0, 12000), user = String(req.user || "").slice(0, 80000), schema = req.schema;
  if (!system || !user || !schema || typeof schema !== "object" || JSON.stringify(schema).length > 4000) return json_({ ok: false, error: "bad_request" });
  if (!countToday_(props)) return json_({ ok: false, error: "daily_limit" });
  var fast = req.fast !== false, maxTokens = Math.max(256, Math.min(8000, parseInt(req.max_tokens, 10) || 1024));
  var got = askAI_(ai, system, user, schema, fast ? "low" : "medium", maxTokens);
  if (!got.ok) return json_({ ok: false, error: got.error, detail: clip_(got.detail, 200) });
  return json_({ ok: true, data: got.data, provider: ai.name });
}

// ===== provider choice =====
function provider_(props) {
  var g = props.getProperty("GEMINI_API_KEY"), c = props.getProperty("ANTHROPIC_API_KEY");
  var pick = String(props.getProperty("AI_PROVIDER") || "").toLowerCase();
  if (g && (pick !== "claude" || !c)) return { name: "gemini", key: g, props: props };
  if (c) return { name: "claude", key: c, props: props };
  return null;
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
  return callGemini_(ai, system, user, schema, maxTokens, effort === "low");
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
