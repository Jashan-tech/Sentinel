# Vision test images: human review guide

These six real photographs come from Wikimedia Commons and are used to test SENTINEL's Vision Agent. They are **online reference images, not photographs taken by SENTINEL**. Full provenance for each image is in [`manifest.json`](manifest.json): source page, direct URLs, creator, license, SHA-256 hash, and the date the source reports.

**Using the images:**
- Every image is either reusable with attribution (CC BY / CC BY-SA) or in the public domain or under CC0. If you redistribute a CC BY / CC BY-SA image, credit its creator and keep the same license.
- The image files are Wikimedia's resized thumbnails of the originals.
- `capture_timestamp` is always `null`, because SENTINEL did not take these photos and does not know exactly when they were captured.

**How to use this guide.** The "visible" lists were written by a person looking at each image. They are **not defect ground truth**: nobody inspected the real equipment.
- A good Vision Agent report repeats the visible facts as observations.
- It marks everything in the "cannot confirm" column as unknown or uncertain.
- It **never** turns an observation into a cause, such as "an empty port caused an outage" or "a red LED means a failed server".

| Image | License (creator) | Good for testing | Clearly visible | Cannot be confirmed from the photo |
|---|---|---|---|---|
| `rack-switches-patch-panels.jpg` | CC BY-SA 4.0 (Dsimic) | Rack with equipment, connected switches, tidy cabling | Two patch panels, a keystone panel, two D-Link "Web Smart Switch" units and a Cisco-branded device. Grey patch cables are routed neatly through cable managers. Green and amber switch LEDs are lit. Some panel ports are empty | What each cable connects to, whether the empty ports are expected, what the LED colours mean, device health |
| `switch-cable-nest.jpg` | CC BY-SA 2.5 (J.smith, en.wikipedia) | Cable organization problems, occluded ports | HP ProCurve modular switch with a status-legend panel. Dense, crossing cables partly cover its front. Some upper-module ports appear empty | Port numbers of most cables, whether the cabling affects airflow or reliability, link status |
| `switch-24port-fastethernet.jpg` | CC BY-SA 4.0 (Mvdiogo) | Port occupancy, small low-resolution LEDs | Two stacked D-Link switches. Many blue cables in the right-hand port area. Small green power LEDs | Exact number of occupied ports, per-port LED states, exact model number |
| `switch-5port-led-closeup.jpg` | CC BY-SA 3.0 (Simon A. Eugster) | Close-up of status indicators, connected vs. empty ports | NETGEAR GS105. Legend reads "On=Link, Blink=ACT; Both=1000M". A cable is in port 3 (yellow) and port 5 (red). Ports 1, 2 and 4 are empty. The power LED and port-5 LEDs are lit green | Whether the far end of the yellow cable is connected (the source text says it isn't, but the photo doesn't show it), link speed, any fault |
| `rack-rear-nersc-closeup.jpg` | CC0 (Derrick Coetzee) | Rack with labels, LEDs and organized cabling | Rack "A" labelled SGI-07A. A stack of 1U servers, each with a blue LCD and an "LBNL AHJ" asset label. One white cable per server. Green, blue and red LEDs on the servers, amber LEDs on a switch | Meaning of the red and amber indicators, server health, full LCD text |
| `cable-closet.jpg` | Public domain (Brian Hankins) | Severe cable disorganization, total occlusion | Patch panels almost completely covered by blue and grey cable. A loose orange coil. A NETGEAR switch with green LEDs. The photographer calls it "messy Cat5" | Any port occupancy, impact on airflow or service, where cables go |

**Manual test steps**
1. On the dashboard, select a rack and upload one of these files.
2. Choose the source **Online reference**, then paste the `source_page`, creator and license from the manifest.
3. Click **Run Visual Inspection**.
4. Compare the findings with the table above:
   - Visible facts should come back marked certain.
   - Small text or LEDs should come back uncertain or unknown.
   - There should be no invented port numbers, model numbers, cable destinations or faults.

**Automated live check:** `npx tsx scripts/probe-vision.ts test-assets/vision/<file>`.
