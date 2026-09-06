"""Poké Ball Plus BLE sniffer — affiche les paquets bruts + décodage boutons/stick.

Usage : mettre la ball en pairing (bouton du dessus, LED blanche clignotante),
puis `python pbp_sniff.py`.
"""

import asyncio
import sys

from bleak import BleakClient, BleakScanner

DEVICE_NAME = "Pokemon PBP"
INPUT_CHAR = "6675e16c-f36d-4567-bb55-6b51e27a23e6"

BUTTONS = {0x00: "--", 0x01: "TOP", 0x02: "STICK", 0x03: "TOP+STICK"}


def on_notify(_, data: bytearray):
    raw = data.hex(" ")
    buttons = BUTTONS.get(data[1], f"?{data[1]:02x}")
    # X : nibble haut de l'octet 2 + nibble bas de l'octet 3 ; Y : octet 4 (~32-192)
    x = ((data[3] & 0x0F) << 4) | (data[2] >> 4)
    y = data[4]
    print(f"[{data[0]:3d}] btn={buttons:<10} x={x:3d} y={y:3d}  raw: {raw}")


async def main():
    print(f"Scan BLE à la recherche de « {DEVICE_NAME} »…")
    print("→ Appuie sur le bouton du dessus de la ball (LED blanche clignotante).")
    device = await BleakScanner.find_device_by_name(DEVICE_NAME, timeout=30)
    if device is None:
        sys.exit("Introuvable. Reset (trombone dans le trou près de l'USB-C) puis réessaie.")

    print(f"Trouvé : {device}. Connexion…")
    async with BleakClient(device) as client:
        print("Connecté. Services GATT exposés :")
        for service in client.services:
            print(f"  service {service.uuid}")
            for char in service.characteristics:
                print(f"    char {char.uuid}  [{','.join(char.properties)}]")

        await client.start_notify(INPUT_CHAR, on_notify)
        print("\nNotifications actives — bouge le stick / appuie sur les boutons (Ctrl+C pour quitter).")
        while True:
            await asyncio.sleep(1)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nBye.")
