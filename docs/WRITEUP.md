# Streetscope: writeup for judges

**Open data in, measured street twin out.** Environmental Hacks, Heat and Water track.

## One user, one moment

A city engineer has to decide where to plant the next 100 trees along a busy junction before the summer. Today she has a flat map and an old drawing. Streetscope shows her, in minutes and for any street, which walkways are in direct sun, how much shade a planting plan would add, and how sure we are about each number.

## What we built

1. **Twin Builder** (`pipeline/`, Python and numpy). From OpenStreetMap it builds roads, buildings, trees, stops and crossings, and records where every width and height came from. It adds trees from the Meta and WRI canopy height map, or, in the US, measured building heights and tree tops from USGS airborne LiDAR, both read from AWS Open Data. A numpy shade engine uses the real NOAA sun position to give hourly shade on every walkway cell.
2. **Real-data viewer** (`web/viewer.html`, three.js). 3D twin, sun slider, shade overlay, "how much is real" panel and a "gaps we will not hide" list.
3. **Try a fix.** Plant street trees on the sunniest walkway spots, widen footpaths, or both. Shade, shaded walking area and an assumed cost are recomputed from the same maths.
4. **Doctor** (`agent/`). A Strands agent on Amazon Bedrock with nine allow-listed tools. It cannot read raw data. A number checker traces every figure in its answer to a tool result and flags any that did not come from one. Without Bedrock it falls back to a clearly labelled offline answer.
5. **Extras.** A Google 3D Tiles page with the real data on top (display only, per Google's terms) and a simulator demo for traffic and signals.

## Results from the real data

| Site | Data level | Finding |
|---|---|---|
| AIIMS junction, Delhi | 3 (open data) | OSM maps 0 trees; canopy map finds 369 tops, 24% cover. 132 street trees lift day-mean walkway shade 8.9% to 20%. |
| Connaught Place, Delhi | 3 | 321 canopy tree tops. Shade 19% to 27% with trees. |
| Shibuya, Tokyo | 3 | Dense and already 61% shaded; canopy map finds only 8 tree tops, which fits a concrete district. |
| Times Square, New York | 1 (LiDAR) | 91 of 103 building heights measured. |
| Dupont Circle, Washington DC | 1 (LiDAR) | 143 of 162 heights measured, 489 tree tops. Shade 56% to 66% with trees. |

## Why we can be trusted

- **Deterministic core.** Shade, widths and counts come from code, not from a language model. The model only chooses which tool to call and explains the result.
- **Verification.** Every number in a doctor answer is checked against tool output (`verify.py`, tested).
- **Honesty on screen.** Tags on every number (measured, computed, estimated, simulated, assumed). Defaults are listed. Tree counts from satellite data are labelled a lower bound.
- **Tests.** 39 automated tests cover geometry, sun position, shadows, canopy and LiDAR processing, scenarios, the verifier and the Lambda handler.

## Limits we state plainly

- OpenStreetMap lacks many widths and heights. We use class defaults and show the percentage.
- The two LiDAR surveys carry no vegetation labels, so trees come from multiple-return pulses. Touching crowns merge.
- Tree fixes assume an 8 m tree with a 3 m crown. Costs use assumed unit rates and are not quotes.
- The AWS template is linted but not yet deployed from this repository.

## AWS and open source used

- Amazon Bedrock and the Strands Agents SDK (Apache 2.0) for the doctor.
- AWS Open Data: USGS 3DEP LiDAR (`usgs-lidar-public`) and the Meta and WRI canopy height map.
- AWS SAM template: S3 and CloudFront for the site, Lambda with a Function URL for the doctor.
- three.js, CesiumJS, numpy, laspy, rasterio, pyproj. Map data (c) OpenStreetMap contributors, ODbL.

## AI tools used

- In the product: Amazon Bedrock (Amazon Nova) through Strands Agents.
- While building: _add your own list here before you submit. The hackathon asks for an honest list of the AI tools used._

## Rules check

- Student project, new work: repository history starts on 9 October 2026, during the event.
- Public repository: make the repo public before submitting.
- Video: see `docs/VIDEO_SCRIPT.md`.
