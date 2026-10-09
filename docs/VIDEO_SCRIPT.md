# 3-minute video script

Target length 2:50. Record the screen at 1080p. Read the voice-over slowly; it is written to be said aloud.
Run `scripts/run_all.bat` first and use Chrome. Every link below opens the exact state, so nothing needs clicking to find it.

## Before you record

- Close other tabs. Zoom the browser to 100%.
- Check the doctor API window says "Claude Sonnet 5.5 via Claude Code (your login)". That needs Claude Code installed and logged in; no key.
- Do one dry run of every link so the data is cached.
- If you want the real Google tiles shot, load `http://localhost:8765/earth.html` with your key first.

## Shots

| Time | On screen | Voice-over |
|---|---|---|
| 0:00 | Landing page `http://localhost:8765/` | "Maps are flat. Heat is 3D. A junction can look fine on a map and still leave walkers in direct sun for ten hours a day." |
| 0:12 | Open `viewer.html?site=dupont` and let the reveal play. Then click **Street level** and **Overview**. | "Every junction becomes a 3D gaussian-splat scene, the format used by modern 3D capture, built from open data only. No survey, no budget." |
| 0:24 | Click **See the AIIMS junction fix** on the landing page. Viewer opens in top view with 134 lime-green trees. | "This is the AIIMS junction in Delhi." |
| 0:30 | Click **Today**, turn on **Sun and shade overlay**, press **Play the day** and let the shadows sweep. | "Orange is walkway in direct sun. At midday only four percent of it is shaded. The shadows follow the real sun position for today." |
| 0:42 | Scroll the right panel to **How much is real**. | "We do not hide what we do not know. Only 23 percent of road widths and 17 percent of building heights exist in OpenStreetMap. Every number carries a tag: measured, estimated, computed, simulated or assumed." |
| 0:58 | Click **Plant 134 street trees**. Read the result box. | "OpenStreetMap mapped zero trees here; the canopy map on AWS Open Data finds 369. Now a fix: 134 street trees on the sunniest walkway spots. Day-mean walkway shade goes from 8.5 to 18.3 percent. The cost is tagged assumed: our unit rate, not a quote." |
| 1:20 | Open `viewer.html?site=dupont&area=1`. Dots crawl round the circle. | "Junctions also jam. The traffic screen builds peak-hour trips from building floor area and routes them through the real road network. Red is over capacity, and the dots slow down there. No traffic counts are used, so this is a ranking, not a count." |
| 1:40 | Click the first fix card, **Divert some trips to a parallel street**. | "Every fix is re-run in the model. Diverting fifteen percent of through trips drops this area from 1.24 to 1.06 times capacity, and network delay by about thirteen percent. The assumption sits right on the card." |
| 2:00 | Click **Open .ply / .splat** and drop in your own trained capture (for example a LichtFeld export). | "Have a drone or phone scan? Drop it in. The same renderer shows a real capture, turned the right way up automatically." |
| 2:12 | Open `viewer.html?site=times`. Point at the LiDAR line. | "In the US we go further. At Times Square, USGS airborne LiDAR measured 91 of 102 building heights." |
| 2:25 | Open `viewer.html?site=dupont&brief=1`. Show the brief, the badge and the green check. | "The doctor is Claude Sonnet 5.5, running through Claude Code on this laptop. It can only call our measuring tools. Here it writes an engineer's brief, and a checker traces every number back to a tool." |
| 2:45 | Landing page, then the GitHub repo. | "Streetscope: open data in, measured street twin out." |

## Bonus shot: the same analysis on real 3D (30 seconds)

Open `http://localhost:8765/earth.html?site=dupont&tour=1` with a Cesium ion token or Google key loaded. The guided tour flies in from space, shows roads and widths, sweeps the sun, flies to the three sunniest spots, grows the planted trees, visits the top traffic hot spot and previews its best fix, and ends with a street-level walk.

Voice-over: "The same analysis sits on top of real photoreal 3D. Google's tiles are display only, so every number still comes from our own data and maths."

## If something breaks on camera

- Doctor says it cannot be reached: start `scripts/dev_api.py`. If Claude Code is not installed or not logged in, it gives offline answers and the badge says "offline templates".
- Google tiles are blank: skip that shot. The real-twin viewer is the product.
- A slow shot: cut it. 2:50 of clear beats 3:00 of rushed.

## Claims you can make, and what backs them

| Claim | Where it comes from |
|---|---|
| 8.5% to 18.3% shade, 134 trees | `web/data/aiims/twin.json` scenarios, id `trees` |
| 369 tree tops, 24.3% cover | `stats.canopy` in the same file |
| 23% widths, 17% heights real | "How much is real" panel |
| Dupont area 1.24 to 1.06, delay -12.8% | `web/data/dupont/twin.json` traffic.solutions, area 1, `route_diversion` |
| 91 of 102 heights measured | `web/data/times/twin.json` stats.lidar |
| Every number traced to a tool | `agent/streetscope_agent/verify.py`, tested in `agent/tests` |

## Things not to say

- Do not call the cost a quote. It is assumed.
- Do not call the traffic numbers counts or a forecast. They are simulated from assumed demand.
- The renderer is real 3DGS, but do not call the twin a photo capture. Its gaussians are generated from map data.
- Do not say the Google 3D Tiles were analysed. They are display only.
- Do not say the simulator demo is calibrated. It is a generated scene.
