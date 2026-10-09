# 3-minute video script

Target length 2:50. Record the screen at 1080p. Read the voice-over slowly; it is written to be said aloud.
Run `scripts/run_all.bat` first and use Chrome. Every link below opens the exact state, so nothing needs clicking to find it.

## Before you record

- Close other tabs. Zoom the browser to 100%.
- Check the doctor API window says it is running.
- Do one dry run of every link so the data is cached.
- If you want the real Google tiles shot, load `http://localhost:8765/earth.html` with your key first.

## Shots

| Time | On screen | Voice-over |
|---|---|---|
| 0:00 | Landing page `http://localhost:8765/` | "Maps are flat. Heat is 3D. A junction can look fine on a map and still leave walkers in direct sun for ten hours a day." |
| 0:15 | Click **See the AIIMS junction fix**. Viewer opens in top view with 132 yellow trees. | "This is the AIIMS junction in Delhi, built from open data only. No survey, no budget." |
| 0:30 | Click **Today**. Point at the orange overlay on the walkways. Drag the sun slider from 9 to 15. | "Orange is walkway in direct sun. At midday only four percent of it is shaded. Move the sun and the shadows move, using the real sun position for today." |
| 0:55 | Scroll the right panel to **How much is real**. | "We do not hide what we do not know. Only 16 percent of road widths and 17 percent of building heights exist in OpenStreetMap. The rest are defaults, and every number carries a tag: measured, estimated, computed or assumed." |
| 1:20 | Show the trees: lighter green = canopy map. | "OpenStreetMap mapped zero trees here. The Meta and WRI canopy map on AWS Open Data finds 369 tree tops, 24 percent cover." |
| 1:35 | Click **Plant 132 street trees**. Chart shows dashed today vs green fix. Read the result box. | "Now a fix. 132 street trees on the sunniest walkway spots, eight metres apart. Day-mean walkway shade goes from 8.9 to 20 percent. Shaded walking area more than doubles. The cost, 7.9 lakh rupees, is tagged assumed because the unit rate is ours, not a quote." |
| 2:00 | Click **Widen footpaths by 1.5 m**. | "Widening a footpath adds walking space but barely changes shade. We show that instead of hiding it." |
| 2:15 | Open `http://localhost:8765/viewer.html?site=times`. Show the hour slider and the LiDAR line. | "In the US we go further. At Times Square, USGS airborne LiDAR from AWS Open Data measured 91 of 103 building heights. Same pipeline, better data." |
| 2:30 | Back to AIIMS. Type or click **Where should we plant first?** Show the answer, the tools line and the green check. | "The doctor is a Strands agent on Amazon Bedrock. It can only call measuring tools. A checker traces every number in the answer back to a tool, and flags any that did not come from one." |
| 2:50 | Landing page, then the GitHub repo. | "Streetscope: open data in, measured street twin out. Code is open source." |

## If something breaks on camera

- Doctor says it cannot be reached: start `scripts/dev_api.py`. It falls back to an offline answer without AWS credentials, and says so in the first words.
- Google tiles are blank: skip that shot. The real-twin viewer is the product.
- A slow shot: cut it. 2:50 of clear beats 3:00 of rushed.

## Claims you can make, and what backs them

| Claim | Where it comes from |
|---|---|
| 8.9% to 20% shade, 132 trees | `web/data/aiims/twin.json` scenarios[0] |
| 369 tree tops, 24.3% cover | `stats.canopy` in the same file |
| 16% widths, 17% heights real | "How much is real" panel |
| 91 of 103 heights measured | `web/data/times/twin.json` stats.lidar |
| Every number traced to a tool | `agent/streetscope_agent/verify.py`, tested in `agent/tests` |

## Things not to say

- Do not call the cost a quote. It is assumed.
- Do not say the Google 3D Tiles were analysed. They are display only.
- Do not say the simulator demo is calibrated. It is a generated scene.
