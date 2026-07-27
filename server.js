// ALIKA · Tuya control server
// -----------------------------------------------------------------------
// เซิร์ฟเวอร์เล็กๆ ตัวนี้ทำหน้าที่เป็น "ตัวกลาง" ระหว่างเว็บไซต์โชว์ของ Alika
// กับ Tuya Cloud API — เก็บ Client ID / Client Secret ไว้อย่างปลอดภัยที่นี่
// (ไม่ฝังไว้ในเว็บไซต์) แล้วเปิด endpoint 2 อันให้เว็บไซต์เรียกใช้:
//
//   POST /api/plug/blacklight   body: { "on": true }
//   POST /api/plug/tableLight   body: { "on": false }
//
// ต้องตั้งค่า Environment Variables ก่อนรัน (ดู .env.example):
//   TUYA_CLIENT_ID, TUYA_CLIENT_SECRET, TUYA_REGION,
//   TUYA_BLACKLIGHT_DEVICE_ID, TUYA_TABLELIGHT_DEVICE_ID,
//   TUYA_SWITCH_CODE (ปกติคือ "switch_1" — เช็คได้จาก Tuya IoT Platform)
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

const DEVICE_IDS = {
  blacklight: process.env.TUYA_BLACKLIGHT_DEVICE_ID,
  tableLight: process.env.TUYA_TABLELIGHT_DEVICE_ID,
  ambient: process.env.TUYA_AMBIENT_LIGHT_DEVICE_ID, // ไฟ RGB/LED strip ที่ใช้หรี่แสง
};
const BRIGHTNESS_CODE = process.env.TUYA_BRIGHTNESS_CODE || 'bright_value_v2';

let cachedToken = null; // { token, expiresAt }

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

app.post('/api/plug/:name', async (req, res) => {
  const { name } = req.params;
  const { on } = req.body;
  const deviceId = DEVICE_IDS[name];
  if (!deviceId) {
    return res.status(400).json({ ok: false, error: `ไม่รู้จักปลั๊กชื่อ "${name}" หรือยังไม่ได้ตั้งค่า Device ID` });
  }
  try {
    const result = await sendCommand(deviceId, on);
    res.json({ ok: !!result.success, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/', (req, res) => res.send('ALIKA Tuya control server is running.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Alika Tuya server listening on port ${PORT}`));
