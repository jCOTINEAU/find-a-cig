// Poké Ball Plus — deux implémentations derrière la même interface :
//   • Web Bluetooth (PWA / desktop Chrome)
//   • BLE natif Capacitor (APK Android, plugin @capacitor-community/bluetooth-le)
// Événements émis : 'top' (bouton du dessus), 'stick' (clic du stick),
// 'connected' {battery}, 'disconnected'. Décodage identique (octet 1 = boutons).
import { isNative } from './geo.js';

const DEVICE_NAME = 'Pokemon PBP';
const INPUT_SERVICE = '6675e16c-f36d-4567-bb55-6b51e27a23e5';
const INPUT_CHAR = '6675e16c-f36d-4567-bb55-6b51e27a23e6';
const BATTERY_SERVICE = '0000180f-0000-1000-8000-00805f9b34fb';
const BATTERY_CHAR = '00002a19-0000-1000-8000-00805f9b34fb';

// Front montant : n'émet que sur l'appui, pas sur le relâchement.
function decodeButtons(target, value, lastButtons) {
  const buttons = value.getUint8(1);
  const pressed = buttons & ~lastButtons;
  if (pressed & 0x01) target.dispatchEvent(new Event('top'));
  if (pressed & 0x02) target.dispatchEvent(new Event('stick'));
  return buttons;
}

class WebPokeBall extends EventTarget {
  constructor() { super(); this.device = null; this.lastButtons = 0; }

  async connect() {
    if (!this.device) {
      this.device = await navigator.bluetooth.requestDevice({
        filters: [{ name: DEVICE_NAME }],
        optionalServices: [INPUT_SERVICE, 'battery_service'],
      });
      this.device.addEventListener('gattserverdisconnected', () => {
        this.dispatchEvent(new Event('disconnected'));
      });
    }
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(INPUT_SERVICE);
    const input = await service.getCharacteristic(INPUT_CHAR);
    input.addEventListener('characteristicvaluechanged', e => {
      this.lastButtons = decodeButtons(this, e.target.value, this.lastButtons);
    });
    await input.startNotifications();

    let battery = null;
    try {
      const batService = await server.getPrimaryService('battery_service');
      const level = await batService.getCharacteristic('battery_level');
      battery = (await level.readValue()).getUint8(0);
    } catch { /* batterie non exposée : pas bloquant */ }

    this.lastButtons = 0;
    this.dispatchEvent(new CustomEvent('connected', { detail: { battery } }));
  }

  get connected() { return !!(this.device && this.device.gatt.connected); }
}

class NativePokeBall extends EventTarget {
  constructor(Ble) { super(); this.Ble = Ble; this.deviceId = null; this.lastButtons = 0; this._connected = false; }

  async connect() {
    await this.Ble.initialize();
    if (!this.deviceId) {
      const device = await this.Ble.requestDevice({
        name: DEVICE_NAME,
        optionalServices: [INPUT_SERVICE, BATTERY_SERVICE],
      });
      this.deviceId = device.deviceId;
    }
    await this.Ble.connect(this.deviceId, () => {
      this._connected = false;
      this.dispatchEvent(new Event('disconnected'));
    });
    await this.Ble.startNotifications(this.deviceId, INPUT_SERVICE, INPUT_CHAR, value => {
      this.lastButtons = decodeButtons(this, value, this.lastButtons);
    });

    let battery = null;
    try {
      const v = await this.Ble.read(this.deviceId, BATTERY_SERVICE, BATTERY_CHAR);
      battery = v.getUint8(0);
    } catch { /* batterie non exposée : pas bloquant */ }

    this.lastButtons = 0;
    this._connected = true;
    this.dispatchEvent(new CustomEvent('connected', { detail: { battery } }));
  }

  get connected() { return this._connected; }
}

// Fabrique : native dans l'APK (si le plugin BLE est présent), web sinon.
export function createBall() {
  const Ble = isNative() ? window.__CTA_NATIVE__?.BleClient : null;
  return Ble ? new NativePokeBall(Ble) : new WebPokeBall();
}

// Le BLE est disponible en natif (plugin) ou via Web Bluetooth (Chrome/Edge).
export const supported = (isNative() && !!window.__CTA_NATIVE__?.BleClient) || ('bluetooth' in navigator);
