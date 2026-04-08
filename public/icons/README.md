# PWA icons

The manifest references three files in this directory:

- `icon-192.png` — 192×192, opaque
- `icon-512.png` — 512×512, opaque
- `icon-512-maskable.png` — 512×512, with safe-zone padding for maskable display

Generate them however you like — Figma export, an online PWA icon generator,
or `npx pwa-asset-generator logo.svg public/icons --background "#09090b"`.

Until real icons are added, the PWA will install but show a default icon.
