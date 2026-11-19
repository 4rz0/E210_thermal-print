# E210 Printer

A small web app for printing to the **E210** Bluetooth thermal printer (YICHIP YC3121 based,
originally used with the "QLabel" app) from a phone or a PC, with no install and no account.

It runs entirely in the browser and talks to the printer directly over Bluetooth.
Nothing you print leaves your device.

## Features

- **Text** with auto-fit or fixed size, alignment, font and bold
- **Pictures** with dithering (for photos) or threshold (for logos), brightness and contrast;
  paste (Ctrl+V) or drop images onto the preview
- **QR codes** with an optional caption beside the code
- **Barcodes**: Code 128, EAN-13, EAN-8, UPC, Code 39, ITF
- Continuous **receipt rolls** (the length follows the content) and **labels** (gap, black mark, holes)
- **To-scale preview** of the paper, the 48 mm print area and the result
- **Printer status**: ready / busy, paper present
- Rotation, border, invert, darkness, copies, extra feed after the print
- Installable as an app (PWA) and works offline once loaded; settings are remembered

## Using it

Open the page in a browser that supports Web Bluetooth:

| Device | Browser |
|---|---|
| Android | Chrome or Edge |
| Windows / macOS / Linux | Chrome or Edge |
| iPhone / iPad | Bluefy (free on the App Store) (Safari has no Web Bluetooth) |

1. Switch the printer on.
2. Tap **Bluetooth** and choose **E210** in the list.
3. Design your print, check the preview and tap **Print**.

On desktop Chrome/Edge you can also connect through the printer's classic Bluetooth serial port
(**COM port** button) once the printer is paired in the system settings.

The printer accepts one connection at a time, so disconnect other devices first.

## Printer notes

- The print head is **48 mm (384 dots, 203 dpi)** wide. On 52–58 mm rolls the rest is margin,
  so prints are limited to 48 mm and the app centres them.
- **Darkness 13** gives the blackest result. Higher values make the printer print faster and lighter,
  so the slider stops at 14. Large solid black areas always come out somewhat grey.
- The printer has a paper sensor but **no lid sensor**: an open lid is reported as "out of paper".
- On rolls the printer always feeds a little after each print so it clears the tear-off edge.
- If prints look squished or faint, check that the paper roll turns freely.

## Running it locally

Web Bluetooth only works on `https://` or `http://localhost`. To run it on a PC without hosting:

```sh
python -m http.server 8210
```

and open <http://localhost:8210/>.

## Files

| File | Purpose |
|---|---|
| `index.html`, `style.css` | Page and layout |
| `app.js` | Rendering, preview, settings, status panel |
| `printer.js` | Printer protocol and the Bluetooth LE / serial transports |
| `sw.js`, `manifest.webmanifest`, `icon*` | Offline support and app install |
| `vendor/` | [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) and [JsBarcode](https://github.com/lindell/JsBarcode) (MIT) |

## Protocol

The printer does not use ESC/POS. A print job is:

```
1C 21 n                       darkness 0..16
1C 25 t                       paper: 0 roll, 1 holes, 2 gap labels, 3 black mark
1B 33                         start of job
1B 29 rows+1 w h 00           u16 little endian; w, h in 0.1 mm
1B 19 01 len skip data...     one raster row (1 = black, MSB = left), repeated
1B 4A 00                      end of image
1B 69  or  1B 4A n            next label  /  feed n dots on a roll
```

`1B 06` returns the status (`1B 06 s0 s1`, bit 0 of `s0` = no paper).
Over Bluetooth LE the data goes to characteristic `FF02` of service `FF00`, and replies arrive on `FF01`.

Protocol details are based on
[yc3121-e210-label-printer-reversing](https://github.com/InverseCubeSquared/yc3121-e210-label-printer-reversing)
plus testing on a real E210.
