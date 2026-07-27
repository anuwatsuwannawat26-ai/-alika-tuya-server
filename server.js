// ALIKA · Tuya control server
// -----------------------------------------------------------------------
// เซิร์ฟเวอร์เล็กๆ ตัวนี้ทำหน้าทีเป็น "ตัวกลาง" ระหว่างเว็บไซต์โชว์ของ Alika
// กับ Tuya Cloud API — เก็บ Client ID / Client Secret ไว้อย่างปลอดภยที่นี่
// (ไม่ฝังไว้ในเว็บไซต์) แล้วเปิด endpoint ให้เว็บไซต์เรียกใช้:
//
//   POST /api/plug/blacklight   body: { "on": [{"code":"switch_1","value":true}] }
//   POST /api/plug/tableLight   body: { "on": [{"code":"switch_1","value":false}] }
//
//   GET  /api/show-status       -> { started: true/false, startedAt: <ms> | null }
//   POST /api/show-status       body: { "started": true }  หรือ { "started": false }
//   (ใช้เป็นสัญญาณกลาง ให้หน้าเว็บที่เปิดค้างไว้ที่ทีวี รว่า iPad กด "เริ่มโชว์" แล้วหรือยง)
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

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const REGION_HOSTS = {
  eu: 'https://openapi.tuyaeu.com',
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
  ambient: process.env.TUYA_AMBIENT_LIGHT_DEVICE_ID,
};
const BRIGHTNESS_CODE = process.env.TUYA_BRIGHTNESS_CODE || 'bright_value_v2';

let cachedToken = null;
let showStatus = { started: false, startedAt: null, videoUrl: "" };

function sha256Hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function hmacSign(str) {
  return crypto.createHmac('sha256', CLIENT_SECRET).update(str, 'utf8').digest('hex').toUpperCase();
}

function buildSign({ method, path, body, accessToken }) {
  const t = Date.now().toString();
  const bodyHash = sha256Hex(body ? JSON.stringify(body) : '');
  const headersStr = '';
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
  const v = Math.max(0, Math.min(1000, Math.round
