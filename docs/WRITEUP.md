# Streetscope: writeup for judges

**Open data in, measured street twin out.** Environmental Hacks, Heat and Water track.

## One user, one moment

A city engineer has to decide where to plant the next 100 trees along a busy junction before the summer, and the same junction jams every evening. Today she has a flat map and an old drawing. Streetscope shows her, in minutes and for any street, which walkways are in direct sun, how much shade a planting plan would add, which corners of the junction are most likely to queue, which fixes are worth a proper study, and how sure we are about each number.

## What we built

1. **Twin Builder** (`pipeline/`, Python and numpy). From OpenStreetMap it builds roads, buildings, trees, stops, crossings and traffic signals, and records where every width and height came from. It adds trees from the Meta and WRI canopy height map, or, in the US, measured building heights and tree tops from USGS airborne LiDAR, both read from AWS Open Data. A numpy shade engine uses the real NOAA sun position to give hourly shade on every walkway cell.
2. **Real-data viewer** (`web/viewer.html`, three.js). 3D twin, sun slider with *Play the day*, shade overlay, "how much is real" panel, "gaps we will not hide" list, and a 45-second guided tour.
3. **Try a fix.** Plant street trees on the sunniest walkway spots, widen footpaths, or both. Shade, shaded walking area and an assumed cost are recomputed from the same maths.
4. **Traffic screen** (`pipeline/streetscope/traffic.py`). The road network is split at junctions. Peak-hour trips come from building floor area plus through traffic at the edge, and are routed in four congestion-aware stages using the BPR delay curve. Junction areas are ranked by load and conflicts (links meeting, crossings, bus stops, signals). Each candidate fix (bus lane, signal timing, foot overbridge, route diversion, extra lane) is applied to the model and re-run, so every card shows a before and after. In 3D: load-coloured roads, moving dots that slow past capacity, pulsing numbered hot spots, and a preview of each fix on the street.
5. **Gaussian view** (`web/gs.js`). A real 3D Gaussian Splatting renderer written for this project in WebGL2: anisotropic gaussians, EWA projection, a depth sort in a worker, back-to-front blending. The twin becomes about half a million gaussians (ground, road markings, facades with windows, roofs, leaf-like tree crowns), with ground shadows from the shade engine. It loads with a Luma-style reveal and moves with smooth arcing camera flights. It also opens a real trained capture (3DGS `.ply` or `.splat`) and exports the scene as `.splat`.
6. **Doctor** (`agent/`). Claude Sonnet 5.5 with eleven allow-listed tools. It cannot read raw data. A number checker traces every figure in its answer to a tool result and flags any that did not come from one. It can write a short engineer's brief (where it hurts, what we would try, how sure we are). Locally it runs through the Claude Code command line with the user's own login, so no API key is needed; the tools reach it through a small MCP server and it gets no file, shell or web access. When deployed it runs on Amazon Bedrock. Without a key it falls back to clearly labelled offline templates over the same tools.
7. **Real 3D page** (`web/earth.html`, CesiumJS). The same analysis on Google Photorealistic 3D Tiles (display only, per Google's terms), with cameras, glow and a guided tour. A simulator demo shows a generated junction with cars and signals.

8. **GreenCityAI** (`app/`, React, TypeScript, CesiumJS, Three.js). The product face: a full-screen 3D city on Google Photorealistic 3D Tiles (or a dark open-data city without a key) with spatial infographics anchored to the map, click-to-fly junctions, an *Analyze Area* scan with three located findings, a Before / Proposed simulation with animated proposals and a metric strip, an effect-against-cost comparison, live weather and air quality, and a LiDAR point-cloud inspector with picking and measurement. Every number carries its basis: observed, computed, simulated, proposed or assumed.

## Results from the real data

| Site | Data level | Shade finding | Traffic screen (simulated) |
|---|---|---|---|
| AIIMS junction, Delhi | 3 (open data) | OSM maps 0 trees; canopy map finds 369 tops, 24% cover. 134 street trees lift day-mean walkway shade 8.5% to 18.3%. | 10 links over assumed capacity. Top area scores 79.2 with no signal mapped; adding signal control cuts its load 10.7%. |
| Connaught Place, Delhi | 3 | 321 canopy tree tops. Shade 18.9% to 26.2% with trees. | Middle Circle and Radial Road 2: a diversion cuts area load 14.8% and network delay 24%. |
| Shibuya, Tokyo | 3 | Dense and already 61% shaded; canopy map finds only 8 tree tops, which fits a concrete district. | 11 links over capacity; top area scores 99.1. |
| Times Square, New York | 1 (LiDAR) | 91 of 102 building heights measured. | 7th Avenue and West 44th Street: signal retiming cuts area load 10.7%. |
| Dupont Circle, Washington DC | 1 (LiDAR) | 143 of 162 heights measured, 489 tree tops. Shade 56.9% to 67.1% with trees. | The circle scores 98.4; diverting 15% of through trips cuts area load from 1.24 to 1.06 times capacity. |

## Why we can be trusted

- **Deterministic core.** Shade, widths, counts and traffic load come from code, not from a language model. The model only chooses which tool to call and explains the result.
- **Verification.** Every number in a doctor answer is checked against tool output (`verify.py`, tested).
- **Honesty on screen.** Tags on every number (measured, computed, estimated, simulated, assumed). Defaults are listed. Tree counts from satellite data are labelled a lower bound. Traffic results are labelled simulated and come with the sentence "No traffic counts were used."
- **Tests.** 64 automated tests cover geometry, sun position, shadows, canopy and LiDAR processing, scenarios, the traffic screen, the verifier, the Claude tool loop and the Claude Code path (with stand-ins), the MCP tool server and the Lambda handler. The Claude Code path was also run live.

## Limits we state plainly

- OpenStreetMap lacks many widths and heights. We use class defaults and show the percentage.
- The two LiDAR surveys carry no vegetation labels, so trees come from multiple-return pulses. Touching crowns merge.
- Tree fixes assume an 8 m tree with a 3 m crown. Costs use assumed unit rates and are not quotes.
- The traffic screen has no counts. Demand is derived from floor area and scaled so the busiest links sit near capacity, so it ranks places and compares fixes; it does not predict vehicle numbers. A real study needs counts.
- The gaussian view is real 3DGS rendering, but the twin's gaussians are generated from map data, not trained from photos. A photo-real twin needs a scan (level 2), which the same viewer can open.
- The AWS template is linted but not yet deployed from this repository.

## AWS and open source used

- Claude Sonnet 5.5 on Amazon Bedrock for the deployed doctor (Anthropic Python SDK). Optional Strands Agents SDK path.
- AWS Open Data: USGS 3DEP LiDAR (`usgs-lidar-public`) and the Meta and WRI canopy height map.
- AWS SAM template: S3 and CloudFront for the site, Lambda with a Function URL for the doctor.
- three.js, CesiumJS, numpy, laspy, rasterio, pyproj. Map data (c) OpenStreetMap contributors, ODbL.

## AI tools used

- In the product: Claude Sonnet 5.5 (Anthropic), through Claude Code locally, the Anthropic API, or Amazon Bedrock.
- While building: _add your own list here before you submit. The hackathon asks for an honest list of the AI tools used._

## Rules check

- Student project, new work: repository history starts on 9 October 2026, during the event.
- Public repository: make the repo public before submitting.
- Video: see `docs/VIDEO_SCRIPT.md`.
