// ALIKA · Tuya control server
// -----------------------------------------------------------------------
// เซิร์ฟเวอร์เล็กๆ ตัวนี้ทำหน้าที่เป็น "ตัวกลาง" ระหว่างเว็บไซต์โชว์ของ Alika
// กับ Tuya Cloud API — เก็บ Client ID / Client Secret ไว้อย่างปลอดภัยที่นี่
// (ไม่ฝังไว้ในเว็บไซต์) แล้วเปิด endpoint ให้เว็บไซต์เรียกใช้:
//
//   POST /api/plug/blacklight   body: { "on": [{"code":"switch_1","value":true}] }
//   POST /api/plug/tableLight   body: { "on": [{"code":"switch_1","value":false}] }
//   POST /api/plug/ambient      body: { "on": [{"code":"switch_1","value":true}] }
//        (= "ไฟสี" — ใช้ endpoint เดิมนี้ได้เลย ไม่ต้องมี endpoint ใหม่)
//   POST /api/plug/frontLight   body: { "on": [{"code":"switch_1","value":true}] }
//        (= "ไฟหน้าบ้าน" / ไฟส่องพระพุทธรูปทางเข้า — เพิ่ม 2026-08-25)
//
//   POST /api/spotlight/:head   body: { "on": true, "brightness": 0-100, "hue": "white"|"gold"|"amber"|"orange"|"red"|"purple"|"blue"|"cyan"|"green"|"pink"|"yellow" }
//        head = 0,1,2,3 (หัวที่ 1-4)
//
//   GET  /api/show-status       -> { started, startedAt, videoUrl, seekSeconds, seekToken }
//   POST /api/show-status       body: { "started": true }  หรือ { "started": false }
//                                    หรือ { "seekSeconds": 123.4 }  (ใหม่ — สั่งเลื่อนวิดีโอ)
//   (ใช้เป็นสัญญาณกลาง ให้หน้าเว็บที่เปิดค้างไว้ที่ทีวี รู้ว่า iPad กด "เริ่มโชว์"/เลื่อนวิดีโอ แล้วหรือยัง)
//
//   GET  /api/tuya-test         -> เช็คจริงว่าคุยกับ Tuya Cloud ได้ไหม (ขอ token + เช็คสถานะทุกอุปกรณ์)
//
// ต้องตั้งค่า Environment Variables ก่อนรัน (ดู .env.example):
//   TUYA_CLIENT_ID, TUYA_CLIENT_SECRET, TUYA_REGION,
//   TUYA_BLACKLIGHT_DEVICE_ID, TUYA_TABLELIGHT_DEVICE_ID,
//   TUYA_AMBIENT_LIGHT_DEVICE_ID   (= "ไฟสี" — ใส่ตอนที่รู้ว่าจับคู่ Tuya ได้จริงไหม)
//   TUYA_FRONTLIGHT_DEVICE_ID      (= "ไฟหน้าบ้าน" — เพิ่ม 2026-08-25)
//   TUYA_SPOTLIGHT_1_DEVICE_ID .. TUYA_SPOTLIGHT_4_DEVICE_ID   (ใส่พรุ่งนี้หลังจับคู่หลอด Spotlight)
//   TUYA_SWITCH_CODE (ปกติคือ "switch_1"), TUYA_BRIGHTNESS_CODE (ปกติคือ "bright_value_v2")
//   TUYA_COLOR_MODE_CODE (ปกติคือ "work_mode"), TUYA_COLOR_DATA_CODE (ปกติคือ "colour_data_v2")
//     — ถ้าหลอด LSC ใช้ชื่อ DP ต่างจากนี้ เช็คได้จาก Tuya IoT Platform > อุปกรณ์ > Debug Device
// -----------------------------------------------------------------------

const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// อนุญาตให้เว็บไซต์ของเธอเรียก endpoint นี้ข้ามโดเมนได้ (CORS)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const REGION_HOSTS = {
  eu: 'https://openapi.tuyaeu.com',   // Western European Data Center
  us: 'https://openapi.tuyaus.com',
  cn: 'https://openapi.tuyacn.com',
  in: 'https://openapi.tuyain.com',
};

const CLIENT_ID = process.env.TUYA_CLIENT_ID;
const CLIENT_SECRET = process.env.TUYA_CLIENT_SECRET;
const HOST = REGION_HOSTS[process.env.TUYA_REGION || 'eu'];
const SWITCH_CODE = process.env.TUYA_SWITCH_CODE || 'switch_1';
// Spotlight (LSC smart GU10) uses a different on/off DP code than the
// M10EM plugs — confirmed via Tuya IoT Platform > Device Debugging on
// 2026-08-22: switch_led (Boolean), not switch_1. Using switch_1 on this
// device causes Tuya to reject the whole command with "command or value
// not support", which also blocked the brightness/colour commands sent
// in the same call.
const SPOTLIGHT_SWITCH_CODE = process.env.TUYA_SPOTLIGHT_SWITCH_CODE || 'switch_led';
const BRIGHTNESS_CODE = process.env.TUYA_BRIGHTNESS_CODE || 'bright_value_v2';
const COLOR_MODE_CODE = process.env.TUYA_COLOR_MODE_CODE || 'work_mode';
const COLOR_DATA_CODE = process.env.TUYA_COLOR_DATA_CODE || 'colour_data_v2';

const DEVICE_IDS = {
  blacklight: process.env.TUYA_BLACKLIGHT_DEVICE_ID,
  tableLight: process.env.TUYA_TABLELIGHT_DEVICE_ID,
  // "ไฟสี" (ambient) เป็นปลั๊กตัวเดียวกับ "ไฟโต๊ะ" (M10EM 3) ตามที่ Alika ยืนยัน
  // (ไม่ใช่อุปกรณ์แยก) — ใช้ Device ID เดียวกันเป็นค่าเริ่มต้น ยกเว้นถ้ามีการตั้ง
  // TUYA_AMBIENT_LIGHT_DEVICE_ID แยกไว้ที่ Render ก็ให้ใช้ค่านั้นแทน
  // (แก้ 2026-08-22 หลังพบว่าไฟโต๊ะ/ไฟสีค้างเปิดตลอดทั้งโชว์ ไม่เคยถูกสั่งเลย)
  ambient: process.env.TUYA_AMBIENT_LIGHT_DEVICE_ID || process.env.TUYA_TABLELIGHT_DEVICE_ID,
  // "ไฟหน้าบ้าน" — ไฟส่องพระพุทธรูป 2 องค์หน้าทางเข้า (เพิ่ม 2026-08-25)
  frontLight: process.env.TUYA_FRONTLIGHT_DEVICE_ID,
};

// 4-head Spotlight (LSC Smart Connect), index 0-3 = หัวที่ 1-4.
// Empty until paired tomorrow — every call below no-ops safely until then.
const SPOTLIGHT_DEVICE_IDS = [
  process.env.TUYA_SPOTLIGHT_1_DEVICE_ID,
  process.env.TUYA_SPOTLIGHT_2_DEVICE_ID,
  process.env.TUYA_SPOTLIGHT_3_DEVICE_ID,
  process.env.TUYA_SPOTLIGHT_4_DEVICE_ID,
];

// Named colours used by the V2 cue engine -> approximate Tuya HSV.
// h: 0-360, s/v: 0-1000. 'white' skips colour mode entirely (uses the
// bulb's white channel instead, which is usually brighter/cleaner).
// blue/cyan/green/pink/yellow added 2026-08-24 per Alika's request —
// cyan ("ฟ้า", sky blue) is distinct from blue ("น้ำเงิน", deeper/navy blue).
const HUE_MAP = {
  gold:   { h: 45,  s: 900,  v: 1000 },
  amber:  { h: 35,  s: 950,  v: 1000 },
  orange: { h: 25,  s: 1000, v: 1000 },
  red:    { h: 0,   s: 1000, v: 1000 },
  purple: { h: 280, s: 900,  v: 1000 },
  blue:   { h: 225, s: 900,  v: 1000 },
  cyan:   { h: 190, s: 800,  v: 1000 },
  green:  { h: 120, s: 900,  v: 1000 },
  pink:   { h: 330, s: 650,  v: 1000 },
  yellow: { h: 55,  s: 1000, v: 900  },
};

let cachedToken = null; // { token, expiresAt }

// ------------------------------------------------------------
// สถานะโชว์แบบง่ายๆ เก็บไว้ในหน่วยความจำของ server (ไม่ต้องใช้ฐานข้อมูล)
// อยู่รอดตราบใดที่ server ยังไม่รีสตาร์ท (บน free plan ของ Render
// server จะ "หลับ" เมื่อไม่มีคนใช้งาน แต่ค่านี้จะรีเซ็ตเป็น false ทุกครั้งที่ตื่นใหม่)
//
// seekSeconds/seekToken: ใหม่ — ใช้ส่งคำสั่ง "เลื่อนวิดีโอไปวินาทีนี้" จาก
// iPad ไปให้หน้าจอทีวี (คนละเครื่อง คนละ browser กัน เดิมไม่มีช่องทางนี้เลย
// ทำให้ลากปุ่มเลื่อนแล้ววิดีโอบนทีวีไม่ตาม — นี่คือจุดที่แก้ให้ตรงนี้).
// seekToken เปลี่ยนค่าทุกครั้งที่มีการเลื่อนใหม่ ทีวี poll แล้วเทียบค่านี้
// เพื่อรู้ว่า "นี่เป็นคำสั่งเลื่อนใหม่ที่ยังไม่เคยทำ" ไม่ใช่ค่าเดิมที่เคยเห็นแล้ว.
// ------------------------------------------------------------
let showStatus = { started: false, startedAt: null, videoUrl: "", seekSeconds: null, seekToken: 0 };

function sha256Hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function hmacSign(str) {
  return crypto.createHmac('sha256', CLIENT_SECRET).update(str, 'utf8').digest('hex').toUpperCase();
}

// สร้างลายเซ็นตามกติกาของ Tuya (HMAC-SHA256), ใช้ได้ทั้งตอนขอ token
// และตอนเรียก API ทั่วไป (ที่ต้องแนบ access_token เพิ่ม)
function buildSign({ method, path, body, accessToken }) {
  const t = Date.now().toString();
  const bodyHash = sha256Hex(body ? JSON.stringify(body) : '');
  const headersStr = ''; // ไม่ใช้ signHeaders ในตัวอย่างนี้
  const stringToSign = [method, bodyHash, headersStr, path].join('\n');
  const base = CLIENT_ID + (accessToken || '') + t + stringToSign;
  return { sign: hmacSign(base), t };
}

async function getToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30000) {
    return cachedToken.token;
  }
  const path = '/v1.0/token?grant_type=1';
  const { sign, t } = buildSign({ method: 'GET', path });
  const resp = await fetch(HOST + path, {
    method: 'GET',
    headers: {
      client_id: CLIENT_ID,
      sign,
      t,
      sign_method: 'HMAC-SHA256',
    },
  });
  const data = await resp.json();
  if (!data.success) throw new Error('Tuya token error: ' + JSON.stringify(data));
  cachedToken = {
    token: data.result.access_token,
    expiresAt: Date.now() + data.result.expire_time * 1000,
  };
  return cachedToken.token;
}

async function tuyaGet(path, accessToken) {
  const { sign, t } = buildSign({ method: 'GET', path, accessToken });
  const resp = await fetch(HOST + path, {
    method: 'GET',
    headers: {
      client_id: CLIENT_ID,
      access_token: accessToken,
      sign,
      t,
      sign_method: 'HMAC-SHA256',
    },
  });
  return resp.json();
}

async function sendCommand(deviceId, commands) {
  const token = await getToken();
  const path = `/v1.0/devices/${deviceId}/commands`;
  const body = { commands };
  const { sign, t } = buildSign({ method: 'POST', path, body, accessToken: token });
  const resp = await fetch(HOST + path, {
    method: 'POST',
    headers: {
      client_id: CLIENT_ID,
      access_token: token,
      sign,
      t,
      sign_method: 'HMAC-SHA256',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return resp.json();
}

async function setSwitch(deviceId, on) {
  return sendCommand(deviceId, [{ code: SWITCH_CODE, value: !!on }]);
}

async function setBrightness(deviceId, value) {
  // value: 0–1000 ตามมาตรฐาน DP ของ Tuya สำหรับไฟหรี่แสง
  const v = Math.max(0, Math.min(1000, Math.round(value)));
  return sendCommand(deviceId, [{ code: BRIGHTNESS_CODE, value: v }]);
}

// Spotlight: เปิด/ปิด + หรี่ + เปลี่ยนสี ในคำสั่งเดียว (ครบตามที่ V2 cue engine ต้องการ)
// เมื่อ "ปิด" (on=false) จะส่งแค่คำสั่งสวิตช์อย่างเดียว ไม่แนบความสว่าง/สีไปด้วย —
// เพราะ DP ความสว่างของหลอดนี้กำหนดค่าต่ำสุดไว้ที่ 10 (ไม่ใช่ 0) ถ้าส่ง 0 ไปพร้อมกัน
// Tuya จะตีกลับคำสั่งทั้งชุดว่า "value not support" รวมถึงคำสั่งปิดสวิตช์ที่แนบไปด้วย
// ทำให้ไฟไม่ดับ (ค้นพบและแก้ 2026-08-22)
async function setSpotlight(deviceId, on, brightness, hue) {
  if (!on) {
    return sendCommand(deviceId, [{ code: SPOTLIGHT_SWITCH_CODE, value: false }]);
  }
  const commands = [{ code: SPOTLIGHT_SWITCH_CODE, value: true }];
  if (brightness != null) {
    const v = Math.max(10, Math.min(1000, Math.round(brightness * 10)));
    commands.push({ code: BRIGHTNESS_CODE, value: v });
  }
  const hsv = HUE_MAP[hue] || { h: 0, s: 0, v: 1000 }; // default: white via the colour channel, not
  // the separate "white" work_mode — on this bulb the white-mode LEDs spread
  // much wider than the colour-mode LEDs, which is why "หัว 1 เปิด" looked
  // like flood light instead of a narrow spot (reported 2026-08-22).
  commands.push({ code: COLOR_MODE_CODE, value: 'colour' });
  commands.push({ code: COLOR_DATA_CODE, value: hsv });
  return sendCommand(deviceId, commands);
}

app.post('/api/plug/:name', async (req, res) => {
  const { name } = req.params;
  const { on } = req.body;
  const deviceId = DEVICE_IDS[name];
  if (!deviceId) {
    return res.status(400).json({ ok: false, error: `ไม่รู้จักปลั๊กชื่อ "${name}" หรือยังไม่ได้ตั้งค่า Device ID` });
  }
  try {
    const result = await sendCommand(deviceId, on);
    res.json({ ok: !!result.success, result, error: result.success ? undefined : (result.msg || JSON.stringify(result)) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ------------------------------------------------------------
// Spotlight — 4 หัว ควบคุมทีละหัว (เปิด/ปิด/หรี่/เปลี่ยนสีในคำสั่งเดียว)
// ------------------------------------------------------------
app.post('/api/spotlight/:head', async (req, res) => {
  const head = parseInt(req.params.head, 10);
  const deviceId = SPOTLIGHT_DEVICE_IDS[head];
  if (!deviceId) {
    return res.status(400).json({ ok: false, error: `Spotlight หัวที่ ${head + 1} ยังไม่ได้ตั้งค่า Device ID (TUYA_SPOTLIGHT_${head + 1}_DEVICE_ID)` });
  }
  const { on, brightness, hue } = req.body;
  try {
    const result = await setSpotlight(deviceId, on, brightness, hue);
    res.json({ ok: !!result.success, result, error: result.success ? undefined : (result.msg || JSON.stringify(result)) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ------------------------------------------------------------
// Tuya connectivity test — เช็คจริงว่า credential ใช้ได้ไหม และอุปกรณ์แต่ละตัว
// เชื่อมกับ Cloud Project นี้อยู่จริงไหม (คนละเรื่องกับแค่ server ทำงานอยู่)
// ------------------------------------------------------------
app.get('/api/tuya-test', async (req, res) => {
  const out = { credentialsConfigured: !!(CLIENT_ID && CLIENT_SECRET), region: process.env.TUYA_REGION || 'eu' };

  if (!out.credentialsConfigured) {
    return res.json({ ok: false, ...out, error: 'ยังไม่ได้ตั้งค่า TUYA_CLIENT_ID หรือ TUYA_CLIENT_SECRET บน Render' });
  }

  let token;
  try {
    token = await getToken();
    out.tokenOk = true;
  } catch (err) {
    out.tokenOk = false;
    out.tokenError = err.message;
    return res.json({ ok: false, ...out });
  }

  const allDeviceEntries = {
    ...DEVICE_IDS,
    spotlight1: SPOTLIGHT_DEVICE_IDS[0],
    spotlight2: SPOTLIGHT_DEVICE_IDS[1],
    spotlight3: SPOTLIGHT_DEVICE_IDS[2],
    spotlight4: SPOTLIGHT_DEVICE_IDS[3],
  };

  const devices = {};
  for (const [key, deviceId] of Object.entries(allDeviceEntries)) {
    if (!deviceId) {
      devices[key] = { configured: false };
      continue;
    }
    try {
      const info = await tuyaGet(`/v1.0/devices/${deviceId}`, token);
      devices[key] = {
        configured: true,
        deviceId,
        reachable: !!info.success,
        online: info.success ? !!(info.result && info.result.online) : undefined,
        name: info.success ? (info.result && info.result.name) : undefined,
        error: info.success ? undefined : (info.msg || JSON.stringify(info)),
      };
    } catch (err) {
      devices[key] = { configured: true, deviceId, reachable: false, error: err.message };
    }
  }

  const allOk = Object.values(devices).every(d => !d.configured || (d.reachable && d.online));
  res.json({ ok: allOk, ...out, devices });
});

// ------------------------------------------------------------
// Show status endpoints — ใช้ให้หน้าเว็บที่เปิดค้างไว้ในทีวี (tv.html)
// คอยเช็คว่า iPad กด "เริ่มโชว์" แล้วหรือยัง / เลื่อนวิดีโอไปวินาทีไหน
// ------------------------------------------------------------
app.get('/api/show-status', (req, res) => {
  res.json(showStatus);
});

app.post('/api/show-status', (req, res) => {
  const { started, videoUrl, seekSeconds } = req.body;
  const isSeek = seekSeconds !== undefined && seekSeconds !== null;
  showStatus = {
    started: started !== undefined ? !!started : showStatus.started,
    startedAt: started === true ? Date.now() : (started === false ? null : showStatus.startedAt),
    videoUrl: (started === true) ? (videoUrl || showStatus.videoUrl || "") : showStatus.videoUrl,
    seekSeconds: isSeek ? seekSeconds : showStatus.seekSeconds,
    seekToken: isSeek ? (showStatus.seekToken + 1) : showStatus.seekToken,
  };
  res.json({ ok: true, showStatus });
});

app.get('/', (req, res) => res.send('ALIKA Tuya control server is running.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Alika Tuya server listening on port ${PORT}`));
