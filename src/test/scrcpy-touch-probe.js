const net = require('net');
const { spawn } = require('child_process');
const path = require('path');
const { loadConfig, resolveAdbPath } = require('../config');

const SCRCPY_VERSION = '3.0.2';
const MSG_INJECT_TOUCH = 2;
const ACTION_DOWN = 0;
const ACTION_UP = 1;
const POINTER_ID = BigInt('0xffffffffffffffff');
const BUTTON_PRIMARY = 1;

function buildTouchMsg(action, x, y, width, height) {
  const buf = Buffer.alloc(32);
  buf.writeUInt8(MSG_INJECT_TOUCH, 0);
  buf.writeUInt8(action, 1);
  buf.writeBigUInt64BE(POINTER_ID, 2);
  buf.writeUInt32BE(x, 10);
  buf.writeUInt32BE(y, 14);
  buf.writeUInt16BE(width, 18);
  buf.writeUInt16BE(height, 20);
  buf.writeUInt16BE(action === ACTION_DOWN ? 0xffff : 0, 22);
  buf.writeUInt32BE(BUTTON_PRIMARY, 24);
  buf.writeUInt32BE(action === ACTION_DOWN ? BUTTON_PRIMARY : 0, 28);
  return buf;
}

function waitForData(socket, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket timeout')), timeoutMs);
    socket.once('data', (data) => {
      clearTimeout(timer);
      resolve(data);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function connectControl(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => resolve(socket));
    socket.on('error', reject);
  });
}

async function main() {
  const config = loadConfig();
  const adbPath = resolveAdbPath(config);
  const serial = config.deviceSerial || '';
  const scidHex = Math.floor(Math.random() * 0x7fffffff).toString(16).padStart(8, '0');
  const socketName = `scrcpy_${scidHex}`;
  const port = 27183 + Math.floor(Math.random() * 1000);
  const qtDir = path.dirname(String(config.qtscrcpy?.path || ''));
  const serverJar = path.join(qtDir, 'scrcpy-server');
  const width = config.deviceScreenWidth || 1080;
  const height = config.deviceScreenHeight || 2340;
  const x = Math.round(width / 2);
  const y = Math.round(height * 0.44);

  const adbBase = serial ? ['-s', serial] : [];

  const runAdb = (args) =>
    new Promise((resolve) => {
      const proc = spawn(adbPath, [...adbBase, ...args], { windowsHide: true });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => {
        stdout += d;
      });
      proc.stderr.on('data', (d) => {
        stderr += d;
      });
      proc.on('close', (code) => resolve({ code, stdout, stderr }));
    });

  console.log('push server', serverJar);
  await runAdb(['push', serverJar, '/data/local/tmp/scrcpy-server.jar']);
  await runAdb(['forward', '--remove', `tcp:${port}`]);
  const fwd = await runAdb(['forward', `tcp:${port}`, `localabstract:${socketName}`]);
  console.log('forward', fwd);

  const serverArgs = [
    'shell',
    `CLASSPATH=/data/local/tmp/scrcpy-server.jar app_process / com.genymobile.scrcpy.Server ${SCRCPY_VERSION} scid=${scidHex} tunnel_forward=true audio=false video=false control=true send_device_meta=false send_dummy_byte=true cleanup=false log_level=info`,
  ];
  const serverProc = spawn(adbPath, [...adbBase, ...serverArgs], { windowsHide: true });
  serverProc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  await new Promise((r) => setTimeout(r, 1500));

  console.log('connect control', { port, socketName, scidHex, tap: { x, y } });
  const socket = await connectControl(port);
  const dummy = await waitForData(socket, 8000);
  console.log('dummy byte', dummy);

  socket.write(buildTouchMsg(ACTION_DOWN, x, y, width, height));
  await new Promise((r) => setTimeout(r, 120));
  socket.write(buildTouchMsg(ACTION_UP, x, y, width, height));
  console.log('touch sent');
  socket.end();

  serverProc.kill();
  await runAdb(['forward', '--remove', `tcp:${port}`]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
