# Streetscope

**Open data in, measured street twin out.** Pick any junction. Streetscope builds a 3D twin from open data, computes where people walk in the sun, simulates traffic and signals, and lets an AI "doctor" propose fixes. The doctor can only quote numbers that its measuring tools returned, and a checker flags any number that did not come from a tool.

Built for the WeMakeDevs x AWS *Environmental Hacks* (Heat and Water track), October 2026.

## The problem

Cities plan streets from flat maps and old drawings. Heat is 3D: shade depends on building height, tree crowns and the sun's angle. A junction can look fine on a map and still leave walkers in direct sun for ten hours a day. The 3D data that could show this exists, but it sits in expert tools.

## What it does

| Part | What it gives you |
|---|---|
| **Twin Builder** (`pipeline/`) | OpenStreetMap in, twin out: roads with width and the *source* of that width, buildings with the source of their height, trees, bus stops, crossings. Then a real sun position and a numpy shade engine give hourly shade on every walkway cell. |
| **Real-data viewer** (`web/viewer.html`) | Renders the twin in 3D with a sun slider, shade overlay, and a "how much is real" panel. Assumed values are coloured differently and listed under "gaps we will not hide". |
| **Doctor** (`agent/`) | A Strands agent on Amazon Bedrock with eight allow-listed tools. A number checker verifies every figure in each answer. Falls back to a labelled offline answer if Bedrock is not reachable. |
| **Google 3D Tiles page** (`web/earth.html`) | Real Google Photorealistic 3D Tiles with the same real OpenStreetMap data on top. Display only; see Rules. |
| **Simulator demo** (`web/demo/`) | A generated junction with a car-following traffic simulator, signals, bus lanes, six fixes and before/after. Clearly labelled as generated. |

## Honest limits

- Level of data: all sites here are built from open data only. Where LiDAR or an own scan exists, it should replace the assumed numbers.
- OpenStreetMap often lacks widths and heights. The viewer shows the percentages, for example 17% of building heights are real at the AIIMS site.
- Trees come from OpenStreetMap plus the Meta and WRI 1 m canopy height map (AWS Open Data). At AIIMS that is 369 tree tops and 24% cover where OpenStreetMap mapped none. The map's average error is 2.8 m and touching crowns merge, so counts are a lower bound. Dense Shibuya shows only 8 canopy tops, which is true to a concrete district.
- Planted-tree results assume an 8 m tree with a 3 m crown. Costs use an assumed unit rate and are not quotes.
- The simulator demo is not a calibrated traffic model. Its bus-lane result assumes 40% of car trips move to buses.

## Run it

```bash
python -m pip install numpy pytest rasterio strands-agents boto3
python scripts/serve.py            # http://localhost:8765/  (viewer.html, earth.html, demo/)
python scripts/dev_api.py          # http://localhost:8766/ask  (the doctor; add USE_LLM=0 for offline only)
```

Windows: double-click `scripts/run.bat`.

Build a new site (needs internet for the Overpass download):

```bash
set PYTHONPATH=pipeline
python -m streetscope build --lat 28.5672 --lon 77.2100 --radius 300 --name aiims --out web/data
```

The canopy window is cached as `canopy.bin` in the site folder; use `--no-canopy` to skip it. Add the site to `web/data/index.json` to see it in the viewer. Use `--tz` for the site's UTC offset and `--date` for the day to model.

Tests (30):

```bash
set PYTHONPATH=pipeline;agent
python -m pytest pipeline/tests agent/tests
```

### Google 3D Tiles page

`earth.html` needs your own key. Enable **Map Tiles API** in Google Cloud, create an API key restricted to that API and to `http://localhost:8765/*`, set a budget alert, then paste it into the page. The key stays in your browser. Without a Google billing account you can paste a free Cesium ion token instead.

## Deploy to AWS

```bash
python scripts/package_lambda.py
cd infra
sam build && sam deploy --guided      # asks for BedrockModelId and AskToken
```

Creates an S3 bucket behind CloudFront for the web files and a Lambda (Function URL) running the doctor with Bedrock access. Then sync `web/` to the bucket and set `web/config.js` to the printed `AskUrl` and your token. The template is checked with cfn-lint but has not been deployed from this repo yet.

## Architecture

```
OpenStreetMap (Overpass) --> Twin Builder (numpy) --> twin.json + shade.bin + walk.bin
                                                         |                |
                                              web/viewer.html     agent tools (deterministic)
                                                                          |
                                                      Strands agent on Amazon Bedrock
                                                                          |
                                                    number checker: every figure traced to a tool
```

## Data and licences

- Map data: (c) OpenStreetMap contributors, ODbL. Downloads use the Overpass API.
- Sun position: NOAA general solar position formulas.
- 3D rendering: three.js (MIT) and CesiumJS (Apache 2.0). Google Photorealistic 3D Tiles are display only under Google's terms: no geodata extraction, no object detection on the tiles.
- Fonts: Big Shoulders Display, Hanken Grotesk, JetBrains Mono (SIL OFL) via Google Fonts.
- Trees: Meta and WRI canopy height map, CC BY 4.0, read from AWS Open Data with rasterio.
- Planned: USGS 3DEP LiDAR (AWS Open Data) for level 1 sites in the US.

## Rules check

- New work only: this repository's history starts on 9 October 2026, during the event.
- AWS: Amazon Bedrock and Strands Agents (open source) power the doctor; CloudFront, S3 and Lambda host it.
- Libraries and public APIs are credited above.

## AI tools used

In the product: Amazon Bedrock (Amazon Nova) through the Strands Agents SDK. The agent cannot read data directly and its answers are number-checked.

While building: add your own honest list here before submitting, as the hackathon asks.

## Layout

```
pipeline/   Twin Builder: geo, osm, twin, shade, cli + tests
agent/      Strands agent, tools, number verifier, Lambda handler + tests
web/        viewer, Google 3D Tiles page, simulator demo, sample twins (data/)
infra/      AWS SAM template
scripts/    serve, dev API, Lambda packaging
```

## Licence

MIT. See `LICENSE`.
