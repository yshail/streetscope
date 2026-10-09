"""Build the Lambda bundle in build/lambda: both packages, the twin data, and Linux wheels.

Run:  python scripts/package_lambda.py
Then: cd infra && sam build --use-container=false ; sam deploy --guided
"""
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "build" / "lambda"

if OUT.exists():
    shutil.rmtree(OUT)
OUT.mkdir(parents=True)

# Linux wheels for the Lambda runtime (python3.12, x86_64). boto3 already exists in the runtime.
reqs = [r for r in (ROOT / "agent" / "requirements.txt").read_text().split() if not r.startswith("boto3")]
subprocess.check_call([
    sys.executable, "-m", "pip", "install", "--quiet", "--target", str(OUT), "--platform", "manylinux2014_x86_64",
    "--python-version", "3.12", "--implementation", "cp", "--only-binary=:all:", *reqs,
])
shutil.copytree(ROOT / "pipeline" / "streetscope", OUT / "streetscope", ignore=shutil.ignore_patterns("__pycache__"))
shutil.copytree(ROOT / "agent" / "streetscope_agent", OUT / "streetscope_agent", ignore=shutil.ignore_patterns("__pycache__"))
twins = OUT / "twins"
for site in (ROOT / "web" / "data").iterdir():
    if (site / "twin.json").exists():
        twins.mkdir(exist_ok=True)
        shutil.copytree(site, twins / site.name, ignore=shutil.ignore_patterns("osm.raw.json"))
size = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file()) / 1e6
print(f"bundle ready in {OUT} ({size:.0f} MB unzipped; Lambda limit is 250 MB)")
