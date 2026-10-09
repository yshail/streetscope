# Demo and submission checklist

## Five minutes before recording

- [ ] `scripts/run_all.bat` is running (web on 8765, doctor on 8766).
- [ ] `http://localhost:8765/` loads and the four headline numbers appear.
- [ ] Each link in `docs/VIDEO_SCRIPT.md` opens the right state.
- [ ] Doctor answers in the viewer and shows the green "every number came from a tool" line.
- [ ] Browser zoom 100%, notifications off, other tabs closed.

## Optional: live Bedrock answers

- [ ] `aws configure` done (your own credentials, in your own terminal).
- [ ] Model access granted in the Bedrock console for the model id in `agent/streetscope_agent/agent.py` (`BEDROCK_MODEL_ID`). Check the exact id in the console.
- [ ] `python scripts/dev_api.py` (without `USE_LLM=0`). If Bedrock fails it falls back to an offline answer and says so.

## Optional: deploy to AWS

- [ ] `python scripts/package_lambda.py`
- [ ] `cd infra` then `sam build` and `sam deploy --guided` (asks for the model id and a secret token).
- [ ] Upload `web/` to the new bucket, then set `web/config.js` to the printed `AskUrl` and the token. Re-upload `config.js`.
- [ ] Open the CloudFront URL and ask the doctor a question.

## Before you submit

- [ ] Repo is public: GitHub, Settings, Danger Zone, Change visibility.
- [ ] README "AI tools used" and `docs/WRITEUP.md` list the tools you actually used.
- [ ] No keys in the repo. `git grep -nE "AIza|AKIA|eyJ"` should only match the word in `earth.html` that checks for a Cesium token prefix.
- [ ] Video is on YouTube and the link is in the submission.
- [ ] Writeup pasted from `docs/WRITEUP.md`.
