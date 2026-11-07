// Hermes — Calendar widget for Scriptable (iPhone lock screen + home screen)
// Data: Apps Script JSON endpoint (same source as the web page)
// Install: Scriptable → + → paste → name it "ตาราง" → add widget

const API = "https://script.google.com/macros/s/AKfycbz7tH4iscyXCdtJB4T8GL34Ppp9PuEuUIsw8MjQ-ii3_4Ie6DvusFw8PfhAZ8gjKEJA/exec?format=json&t=";
const PAGE = "https://cheetahgit9999.github.io/cal/";
const TZ_OFFSET_MIN = 7 * 60;   // Asia/Bangkok (UTC+7)
const REFRESH_MIN = 15;          // iOS floor is ~15 min; asking sooner is ignored
const MAX_LINES_RECT = 3;        // lock screen rectangular fits ~3 rows
const MAX_LINES_HOME = 6;

function localParts(date) {
  const d = new Date(date.getTime() + TZ_OFFSET_MIN * 60000);
  return {
    y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(),
    hh: d.getUTCHours(), mm: d.getUTCMinutes(),
    wd: d.getUTCDay(),
    key: `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`,
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}

function hm(date) {
  const p = localParts(date);
  return `${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`;
}

const WD = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];
const MON = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

function dayLabel(date) {
  const p = localParts(date);
  return `${WD[p.wd]}. ${p.d} ${MON[p.m - 1]}`;
}

function untilText(ms) {
  const mins = Math.round(ms / 60000);
  if (mins <= 0) return "ตอนนี้";
  if (mins < 60) return `อีก ${mins} น.`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `อีก ${h} ชม. ${m} น.` : `อีก ${h} ชม.`;
}

// Lock screen rows truncate hard; strip noise and clamp so the countdown survives.
function shorten(s, max) {
  let t = String(s)
    .replace(/\([^)]*\)/g, " ")
    .replace(/^เรียน\s+/, "")
    .replace(/^Live\s*/, "Live ")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trimEnd() + "…";
}

function rowText(ev, now) {
  const s = new Date(ev.start), e = new Date(ev.end);
  const running = now >= s && now < e;
  const prefix = running ? "▶ " : "";
  const when = ev.allDay ? "ทั้งวัน" : hm(s);
  return `${prefix}${when} ${ev.title}`;
}

async function loadPayload() {
  const req = new Request(API + Date.now());
  req.timeoutInterval = 25;
  const body = await req.loadJSON();
  if (!body || !Array.isArray(body.events)) throw new Error("รูปแบบข้อมูลไม่ถูกต้อง");
  return body;
}

function pickEvents(events, now, limit) {
  const live = events
    .map((ev) => ({ ev, s: new Date(ev.start), e: new Date(ev.end) }))
    .filter((x) => x.e > now)
    .sort((a, b) => a.s - b.s);
  const running = live.filter((x) => x.s <= now && x.e > now);
  const upcoming = live.filter((x) => x.s > now);
  return running.concat(upcoming).slice(0, limit);
}

function buildWidget(payload, family) {
  const now = new Date();
  const isLock = family.indexOf("accessory") === 0;
  const limit = isLock ? 2 : (family === "small" ? 3 : MAX_LINES_HOME);
  const picked = pickEvents(payload.events, now, limit);

  const w = new ListWidget();
  w.url = PAGE;
  if (isLock) {
    w.setPadding(2, 6, 2, 6);
  } else {
    w.setPadding(12, 14, 12, 14);
    w.backgroundColor = new Color("#0e1116");
    const grad = new LinearGradient();
    grad.colors = [new Color("#132030"), new Color("#0e1116")];
    grad.locations = [0, 1];
    w.backgroundGradient = grad;
  }

  // Lock screen: the rectangular slot fits ~3 lines total, so no header — rows only.
  if (!isLock) {
    const head = w.addText("ตารางวันนี้");
    head.font = Font.boldSystemFont(12);
    head.textColor = new Color("#8b949e");
    head.lineLimit = 1;
  }

  if (!picked.length) {
    const none = w.addText("ไม่มีนัดแล้ว");
    none.font = isLock ? Font.systemFont(12) : Font.systemFont(13);
    if (!isLock) none.textColor = new Color("#6e7681");
    none.lineLimit = 1;
    return w;
  }

  if (isLock) {
    // Line 1 = the actionable number, never truncated; lines 2-3 = what is next.
    const a = picked[0];
    const runningNow = a.s <= now && a.e > now;
    const lead = w.addText(runningNow
      ? `▶ เหลือ ${Math.max(1, Math.round((a.e - now) / 60000))} น.`
      : `▶ ${untilText(a.s - now)}`);
    lead.font = Font.semiboldSystemFont(12);
    lead.lineLimit = 1;

    for (let i = 0; i < picked.length; i++) {
      const x = picked[i];
      const when = x.ev.allDay ? "ทั้งวัน" : hm(x.s);
      const t = w.addText(`${when} ${shorten(x.ev.title, i === 0 ? 16 : 18)}`);
      t.font = Font.systemFont(12);
      t.lineLimit = 1;
      t.minimumScaleFactor = 0.8;
    }
    w.refreshAfterDate = new Date(Date.now() + REFRESH_MIN * 60000);
    return w;
  }

  for (let i = 0; i < picked.length; i++) {
    const x = picked[i];
    let text = rowText(x.ev, now);
    if (i === 0 && x.s <= now && x.e > now) {
      text += ` · เหลือ ${Math.max(1, Math.round((x.e - now) / 60000))} น.`;
    }
    const t = w.addText(text);
    t.font = Font.systemFont(13);
    t.lineLimit = 1;
    t.minimumScaleFactor = 0.75;
    t.textColor = new Color(i === 0 ? "#e6edf3" : "#adbac7");
  }

  if (!isLock && family !== "small") {
    w.addSpacer();
    const a = picked[0];
    const runningNow = a.s <= now && a.e > now;
    const foot = w.addText(runningNow
      ? `จบ ${hm(a.e)} · ${dayLabel(a.e)}`
      : `${untilText(a.s - now)} · ${dayLabel(a.s)}`);
    foot.font = Font.systemFont(10);
    foot.textColor = new Color("#6e7681");
    foot.lineLimit = 1;
  }

  w.refreshAfterDate = new Date(Date.now() + REFRESH_MIN * 60000);
  return w;
}

let payload;
try {
  payload = await loadPayload();
} catch (err) {
  const w = new ListWidget();
  const t = w.addText("โหลดตารางไม่ได้\n" + err.message);
  t.font = Font.systemFont(11);
  t.lineLimit = 3;
  w.refreshAfterDate = new Date(Date.now() + 5 * 60000);
  if (config.runsInWidget) {
    Script.setWidget(w);
  } else {
    await w.presentMedium();
  }
  Script.complete();
}

if (payload) {
  if (config.runsInWidget) {
    Script.setWidget(buildWidget(payload, config.widgetFamily || "medium"));
  } else {
    // preview inside the app
    await buildWidget(payload, "medium").presentLarge();
    await buildWidget(payload, "accessoryRectangular").presentAccessoryRectangular();
  }
  Script.complete();
}
