# Demo and submission checklist

## Five minutes before recording

- [ ] `scripts/run_all.bat` is running (web on 8765, doctor on 8766).
- [ ] `http://localhost:8765/` loads and the four headline numbers appear.
- [ ] Each link in `docs/VIDEO_SCRIPT.md` opens the right state.
- [ ] Doctor answers in the viewer and shows the green "every number came from a tool" line.
- [ ] The badge next to "Ask the doctor" says what you expect (Claude Sonnet 5.5 or offline templates).
- [ ] Browser zoom 100%, notifications off, other tabs closed.

## Optional: live Claude answers

Pick one. Type the key only in your own terminal, never in a file in the repo.

- [ ] **Anthropic API:** in the terminal that runs the doctor, `set ANTHROPIC_API_KEY=...` then `python scripts/dev_api.py`. The first line printed names the model.
- [ ] **Amazon Bedrock:** `aws configure` with your own credentials, turn on model access for Claude Sonnet 5.5 in the Bedrock console, then `set LLM_BACKEND=bedrock` and `python scripts/dev_api.py`.
- [ ] If the model call fails, the doctor falls back to the offline answer and says why.

## Optional: deploy to AWS

- [ ] `python scripts/package_lambda.py`
- [ ] `cd infra` then `sam build` and `sam deploy --guided` (asks for the Claude model id and a secret token).
- [ ] Upload `web/` to the new bucket, then set `web/config.js` to the printed `AskUrl` and the token. Re-upload `config.js`.
- [ ] Open the CloudFront URL and ask the doctor a question.

## Before you submit

- [ ] Repo is public: GitHub, Settings, Danger Zone, Change visibility.
- [ ] README "AI tools used" and `docs/WRITEUP.md` list the tools you actually used.
- [ ] No keys in the repo. `git grep -nE "AIza|AKIA|sk-ant|eyJ"` should only match the word in `earth.html` that checks for a Cesium token prefix.
- [ ] Video is on YouTube and the link is in the submission.
- [ ] Writeup pasted from `docs/WRITEUP.md`.
