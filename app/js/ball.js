// Poké Ball Plus via Web Bluetooth.
// Événements émis : 'top' (bouton du dessus), 'stick' (clic du stick),
// 'connected' {battery}, 'disconnected'.
const INPUT_SERVICE = '6675e16c-f36d-4567-bb55-6b51e27a23e5';
const INPUT_CHAR = '6675e16c-f36d-4567-bb55-6b51e27a23e6';

export const supported = 'bluetooth' in navigator;

export class PokeBall extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.lastButtons = 0;
  }

  // Doit être appelé depuis un geste utilisateur (clic).
  async connect() {
    if (!this.device) {
      this.device = await navigator.bluetooth.requestDevice({
        filters: [{ name: 'Pokemon PBP' }],
        optionalServices: [INPUT_SERVICE, 'battery_service'],
      });
      this.device.addEventListener('gattserverdisconnected', () => {
        this.dispatchEvent(new Event('disconnected'));
      });
    }
    const server = await this.device.gatt.connect();

    const service = await server.getPrimaryService(INPUT_SERVICE);
    const input = await service.getCharacteristic(INPUT_CHAR);
    input.addEventListener('characteristicvaluechanged', e => this.onInput(e.target.value));
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

  onInput(value) {
    const buttons = value.getUint8(1);
    const pressed = buttons & ~this.lastButtons; // front montant uniquement
    this.lastButtons = buttons;
    if (pressed & 0x01) this.dispatchEvent(new Event('top'));
    if (pressed & 0x02) this.dispatchEvent(new Event('stick'));
  }

  get connected() {
    return !!(this.device && this.device.gatt.connected);
  }
}
