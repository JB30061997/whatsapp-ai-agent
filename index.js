// 1️⃣ Imports
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');
const { execFile } = require('child_process');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const axios = require('axios');
const OpenAI = require('openai');

// 2️⃣ Env
const {
  LARAVEL_API_URL,
  LARAVEL_API_TOKEN,
  OPENAI_API_KEY,
  SESSION_NAME = 'stockgaine-agent',
  ENABLE_TTS = 'false',
  FORCE_TEXT_ON_AUDIO = 'true',
  API_MIN_INTERVAL_MS = '1200',
  API_MAX_RETRIES = '3',
  ENABLE_LLM_ANCHORS = 'false'
} = process.env;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const ENABLE_TTS_BOOL = ENABLE_TTS === 'true';
const FORCE_TEXT_ON_AUDIO_BOOL = FORCE_TEXT_ON_AUDIO === 'true';
const USE_LLM_ANCHORS = ENABLE_LLM_ANCHORS === 'true';
const API_MIN_INTERVAL = parseInt(API_MIN_INTERVAL_MS, 10);
const MAX_RETRIES = parseInt(API_MAX_RETRIES, 10);

// 3️⃣ Clean Chrome Singleton locks (يعاون فـ macOS)
const AUTH_DIR = path.join(process.cwd(), '.wwebjs_auth', `session-${SESSION_NAME}`);
try {
  for (const f of ['SingletonLock','SingletonCookie','SingletonSocket']) {
    const p = path.join(AUTH_DIR, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
} catch (e) {
  console.warn('⚠️ Could not clean Chrome Singleton locks:', e.message);
}

// 4️⃣ WhatsApp Client
const client = new Client({
  authStrategy: new LocalAuth({ clientId: SESSION_NAME }),
  puppeteer: {
    executablePath: process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : undefined,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  },
  takeoverOnConflict: true,
  takeoverTimeoutMs: 10_000
});

// 5️⃣ FS & Audio helpers
function saveTemp(buffer, ext) {
  const p = path.join('/tmp', `wa-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
  fs.writeFileSync(p, buffer);
  return p;
}
function ffmpegConvert(inPath, outPath) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-y', '-i', inPath, '-acodec', 'libmp3lame', '-ar', '44100', '-ac', '1', outPath], (err) => {
      if (err) return reject(err);
      resolve(outPath);
    });
  });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ⏳ Whisper rate-limit gate
let LAST_TRANSCRIBE_AT = 0;
async function waitForTranscribeSlot() {
  const now = Date.now();
  const elapsed = now - LAST_TRANSCRIBE_AT;
  if (elapsed < API_MIN_INTERVAL) await sleep(API_MIN_INTERVAL - elapsed);
  LAST_TRANSCRIBE_AT = Date.now();
}

async function transcribeAudio(filePath) {
  let attempt = 0;
  while (attempt <= MAX_RETRIES) {
    try {
      await waitForTranscribeSlot();
      const res = await openai.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: 'whisper-1',
        language: 'fr',
        prompt:
          "Termes: entrées, sorties, stock, GSB, GAB, GL, GS (toujours avec G au début). " +
          "Après GSB/GAB/GL/GS il y a des chiffres seulement (ex: GSB11). " +
          "Mois FR: janvier, février, mars, avril, mai, juin, juillet, août, septembre, octobre, novembre, décembre."
      });
      return res.text?.trim() || '';
    } catch (e) {
      const status = e?.status || e?.response?.status;
      const is429 = status === 429 || /rate|quota/i.test(e?.message || '');
      if (is429 && attempt < MAX_RETRIES) {
        const backoff = Math.min(2000 * Math.pow(2, attempt), 8000) + Math.floor(Math.random() * 300);
        console.error(`⚠️ Whisper 429 (retry ${attempt + 1}/${MAX_RETRIES}) — ${backoff}ms`);
        await sleep(backoff);
        attempt++;
        continue;
      }
      console.error('⚠️ Whisper error final:', status || e?.message);
      return '';
    }
  }
  return '';
}

async function synthesizeTTS(text) {
  try {
    const speech = await openai.audio.speech.create({
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      input: text
    });
    const buffer = Buffer.from(await speech.arrayBuffer());
    const outPath = saveTemp(buffer, 'mp3');
    return outPath;
  } catch (e) {
    console.error('⚠️ TTS error:', e.status || e.message);
    return null;
  }
}

// 6️⃣ NLP utils (dates + anchors + fallback)

// Normalize (keep accents for months)
function normKeepAccents(s){ return String(s||'').toLowerCase().normalize('NFKC').replace(/\s+/g,' ').trim(); }

const FR_MONTHS = {
  "janvier":1,"fevrier":2,"février":2,"mars":3,"avril":4,"mai":5,"juin":6,
  "juillet":7,"aout":8,"août":8,"septembre":9,"octobre":10,"novembre":11,"decembre":12,"décembre":12
};
const pad2 = n => String(n).padStart(2,'0');

function parseFrenchDatePhrase(fr){
  if(!fr) return null;
  let s = normKeepAccents(fr).replace(/\sle\s+/g,' ').trim();

  // yyyy-mm-dd
  if(/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // dd-mm-yyyy | dd/mm/yyyy
  if(/^\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}$/.test(s)){
    const sep = s.includes('/') ? '/' : '-';
    let [d,m,y] = s.split(sep).map(v=>parseInt(v,10));
    if (y < 100) y += 2000;
    return `${y}-${pad2(m)}-${pad2(d)}`;
  }

  // 1er|premier|dd mois yyyy
  const m = s.match(/\b(1er|premier|\d{1,2})\s+([a-zéûôîùàâç]+)\s+(\d{4})\b/i);
  if (m) {
    let d = m[1].toLowerCase();
    d = (d==='1er'||d==='premier') ? '1' : d;
    const mo = FR_MONTHS[m[2].toLowerCase()];
    const y  = parseInt(m[3],10);
    if (mo) return `${y}-${pad2(mo)}-${pad2(parseInt(d,10))}`;
  }
  return null;
}

// ---- Anchors Parser (les / de / le, du ... au ...)
function extractByAnchors(text){
  const t = normKeepAccents(text);

  // intent after "les"
  let intent = null;
  const intentM = t.match(/\bles\s+(entr[ée]es?|sorties?|stock)\b/i);
  if (intentM) {
    const kw = intentM[1].toLowerCase();
    if (kw.startsWith('entr')) intent = 'entrees';
    else if (kw.startsWith('sort')) intent = 'sorties';
    else intent = 'stock';
  }

  // gaine after "de"
  let gaine = null;
  const gaineM = t.match(/\bde\s+((?:gsb|gab|gl|gs)\s*-?\s*\d{1,5})\b/i);
  if (gaineM) {
    const raw = gaineM[1].toLowerCase().replace(/[\s\-]/g,'');
    gaine = { type: 'prefix', value: raw }; // gsb11
  }

  // time: "du X au Y" OR "le X"
  let time = {};
  const rangeM = t.match(/\bdu\s+(.+?)\s+au\s+(.+?)\b/i);
  if (rangeM) {
    const d1 = parseFrenchDatePhrase(rangeM[1]);
    const d2 = parseFrenchDatePhrase(rangeM[2]);
    if (d1 && d2) time = { from: d1, to: d2 };
  } else {
    const singleM = t.match(/\ble\s+(.+?)$/i);
    if (singleM) {
      const d = parseFrenchDatePhrase(singleM[1]);
      if (d) time = { date: d };
    }
  }

  if (intent && gaine) return { intent, gaine, time };
  return null;
}

// ---- Fallback (keywords/regex)
function detectIntent(t) {
  const low = normKeepAccents(t);
  if (low.includes('entr')) return 'entrees';
  if (low.includes('sort')) return 'sorties';
  if (low.includes('stock')) return 'stock';
  return null;
}
function extractGaine(t) {
  const m = t.match(/\b(gs(?:b)?|gab|gl|gs)\s*-?\s*(\d{1,5})\b/i);
  if (m) return { type:'prefix', value: `${m[1].toLowerCase()}${m[2]}` };
  return null;
}
function extractTime(t) {
  const singleM = t.match(/\b(1er|premier|\d{1,2})\s+([a-zéûôîùàâç]+)\s+(\d{4})\b/i);
  if (singleM) {
    const d = parseFrenchDatePhrase(singleM[0]);
    if (d) return { date: d };
  }
  const DATE_TOKEN_RE = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})\b/g;
  const tokens = (t.match(DATE_TOKEN_RE) || []);
  if (tokens.length >= 1) {
    const s = tokens[0];
    if (/^\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}$/.test(s)) {
      const sep = s.includes('/') ? '/' : '-';
      let [d,m,y] = s.split(sep).map(v=>parseInt(v,10));
      if (y < 100) y += 2000;
      return { date: `${y}-${pad2(m)}-${pad2(d)}` };
    }
    return { date: s };
  }
  return {};
}

// ---- Normalizers (للـLLM)
function normalizeGaineValue(v) {
  if (!v) return null;
  const s = String(v).toLowerCase().replace(/\s|-/g, '');
  const m = s.match(/^(gsb|gab|gl|gs)(\d{1,5})$/);
  return m ? `${m[1]}${m[2]}` : null;
}
function normalizeIntent(i) {
  if (!i) return null;
  const t = String(i).toLowerCase();
  if (t.startsWith('entr')) return 'entrees';
  if (t.startsWith('sort')) return 'sorties';
  if (t.startsWith('stock')) return 'stock';
  return null;
}
function normalizeTime(t) {
  if (!t || typeof t !== 'object') return {};
  // support {date} or {"single": "..."} styles
  const single = t.date || t.single;
  if (single) {
    const iso = parseFrenchDatePhrase(single) || parseFrenchDatePhrase(String(single));
    return iso ? { date: iso } : {};
  }
  if (t.from && t.to) {
    const f = parseFrenchDatePhrase(t.from);
    const to = parseFrenchDatePhrase(t.to);
    if (f && to) return { from: f, to: to };
  }
  return {};
}

// 7️⃣ LLM Anchors Parser (اختياري)
async function llmAnchorsParse(text) {
  if (!USE_LLM_ANCHORS) return null;
  try {
    const sys = [
      "Tu es un extracteur d'informations pour des requêtes de stock.",
      "Règles d'ancrage: 'les X' → intent (entrées/sorties/stock). 'de Y' → gaine. 'le Z' ou 'du A au B' → date/intervalle.",
      "La gaine commence toujours par GSB/GAB/GL/GS suivie de chiffres uniquement (ex: gsb11).",
      "Réponds UNIQUEMENT en JSON suivant ce schema:",
      `{"intent":"entrees|sorties|stock","gaine":{"value":"gsb11"},"time":{"date":"YYYY-MM-DD"} }`,
      "Pour une période: time = {\"from\":\"YYYY-MM-DD\",\"to\":\"YYYY-MM-DD\"}.",
      "Si une info manque, mets des champs vides plutôt que du texte libre."
    ].join('\n');

    const user = `Phrase: """${text}"""\nExtraire intent/gaine/time.`;

    const chat = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user }
      ],
      temperature: 0
    });

    const raw = chat.choices?.[0]?.message?.content?.trim();
    if (!raw) return null;

    let obj;
    try { obj = JSON.parse(raw); } catch { return null; }

    const intent = normalizeIntent(obj.intent);
    const gv = normalizeGaineValue(obj?.gaine?.value);
    const time = normalizeTime(obj.time || {});

    if (intent && gv) {
      return {
        intent,
        gaine: { type: 'prefix', value: gv },
        time
      };
    }
    return null;
  } catch (e) {
    console.error('LLM anchors parse error:', e.message);
    return null;
  }
}

// 8️⃣ Build payload (Audio only)
function buildAudioPayload(text, phone) {
  // 1) جرّب LLM (إذا مفعل)
  const useLLM = { ok: false, data: null };
  // note: llmAnchorsParse async → هنديروه فـ handleAudioSmart (باش نستناوه)

  // 2) Anchors محلي
  const anchored = extractByAnchors(text);
  if (anchored) {
    return {
      mode: 'audio_nlp',
      phone,
      intent: anchored.intent,
      gaine: anchored.gaine,
      time: anchored.time || {}
    };
  }

  // 3) Fallback keywords/regex
  const intent = detectIntent(text);
  const gaine  = extractGaine(text);
  const time   = extractTime(text);
  return { mode:'audio_nlp', phone, intent, gaine, time };
}

// 9️⃣ Audio handler (No step-by-step)
async function handleAudioSmart(text, phone) {
  // حاول أولاً LLM إلى كان مفعّل
  let payload;
  if (USE_LLM_ANCHORS) {
    const llm = await llmAnchorsParse(text);
    if (llm) {
      payload = { mode:'audio_nlp', phone, intent: llm.intent, gaine: llm.gaine, time: llm.time || {} };
    }
  }
  // وإلا خذ المحلي
  if (!payload) payload = buildAudioPayload(text, phone);

  if (!payload.intent) {
    return "🎯 حدّد واش بغيتي *Entrées* ولا *Sorties* ولا *Stock* (مثال: «les sorties de gsb11 le 01-10-2025»).";
  }
  if (!payload.gaine) {
    return "🧵 عطيني الڭاين بهاذ الشكل: *gsb11* / *gab22* / *gl90* (غير أرقام بعد البادئة).";
  }

  try {
    const res = await axios.post(`${LARAVEL_API_URL}/api/ai/route`, payload, {
      headers: { Authorization: `Bearer ${LARAVEL_API_TOKEN}` },
      timeout: 20000
    });
    const reply = (res?.data?.reply || '').toString().trim();
    return reply || "🤖 ماجات حتى استجابة واضحة من السيرفر.";
  } catch (e) {
    console.error('⚠️ Laravel (audio_nlp) error:', e.response?.status || e.message);
    return "⚠️ كاين عطب مؤقت فالسيرفر. جرّب من بعد عفاك.";
  }
}

// 🔟 Events
client.on('qr', qr => qrcode.generate(qr, { small: true }));
client.on('ready', () => console.log('✅ WhatsApp client prêt'));

// ✅ Anti-duplicate
const processedMsgIds = new Set();

// 1️⃣1️⃣ Message handler
client.on('message', async (msg) => {
  try {
    if (msg.fromMe) return;

    const mid = msg.id?._serialized;
    if (!mid || processedMsgIds.has(mid)) return;
    processedMsgIds.add(mid);

    // Ignore groups
    const chat = await msg.getChat();
    if (chat.isGroup) return;

    const from = msg.from;
    const phone = from.split('@')[0];

    let text = (msg.body || '').trim();
    const isAudioLike = msg.hasMedia && (msg.type === 'ptt' || msg.type === 'audio' || msg.type === 'voice');

    // 🎙️ AUDIO FLOW (هنا فقط كنخدمو التعديلات؛ مسار النص ما بدّلناهش)
    if (isAudioLike) {
      try { await msg.react('🎙️'); } catch (_) {}
      const media = await msg.downloadMedia();
      if (media?.data) {
        const buffer = Buffer.from(media.data, 'base64');
        const inPath = saveTemp(buffer, 'ogg');
        const outPath = inPath.replace(/\.ogg$/, '.mp3');

        try {
          await ffmpegConvert(inPath, outPath);
          const transcript = await transcribeAudio(outPath);
          if (!transcript) {
            try { await msg.reply('🕒 Service de transcription saturé, réessaie dans un moment.'); } catch(_) {}
            return;
          }

          const smartReply = await handleAudioSmart(transcript, phone);

          // احترام القاعدة: audio in → text out (ولا TTS إلا بغيتي)
          const mustForceText = FORCE_TEXT_ON_AUDIO_BOOL;
          if (!mustForceText && ENABLE_TTS_BOOL) {
            const voicePath = await synthesizeTTS(smartReply);
            if (voicePath) {
              const vmedia = MessageMedia.fromFilePath(voicePath);
              await client.sendMessage(from, vmedia, { sendAudioAsVoice: true });
            } else {
              await client.sendMessage(from, smartReply);
            }
          } else {
            await client.sendMessage(from, smartReply);
          }

          console.log(`💬 AudioSmart → ${phone} :: ${transcript}`);
          return;
        } catch (e) {
          console.error('⚠️ Audio convert/transcribe error:', e.message);
          try { await msg.reply('⚠️ Ma3rfnach ntratw l-audio daba. 7awel melli t9dar.'); } catch(_) {}
          return;
        }
      }
    }

    // 💬 TEXT FLOW (بلا تغيير — خليه كيف كان)
    if (!text) return;
    let reply = 'OK.';
    try {
      const res = await axios.post(
        `${LARAVEL_API_URL}/api/ai/route`,
        { text, phone },
        { headers: { Authorization: `Bearer ${LARAVEL_API_TOKEN}` }, timeout: 15000 }
      );
      reply = (res?.data?.reply || '').toString().trim() || 'OK.';
    } catch (e) {
      console.error('⚠️ Laravel API error:', e.response?.status || e.message);
      try { await msg.reply('🤖 Désolé, problème côté serveur. Réessaie un peu plus tard.'); } catch(_) {}
      return;
    }

    await client.sendMessage(from, reply);
    console.log(`💬 Text → ${phone}`);
  } catch (err) {
    console.error('⚠️ Agent error (global):', err.message);
    try { await msg.reply('🤖 Erreur inattendue.'); } catch (_) {}
  }
});

// 1️⃣2️⃣ start
client.initialize();
