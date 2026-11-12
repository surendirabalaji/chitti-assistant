---
description: Walk through the four-prompt routing test and check the logs
---
Guide the user through the routing test on target: $ARGUMENTS (laptop or cloud).

Steps: send the four prompts from doc/a3/REQUIREMENTS.md "Video script" in one chat (quit Ollama before prompt 3, restart before prompt 4, wait for the health change each time), then show the log command for the target (laptop: gateway log/stdout filter for component "a3-router"; cloud: the gcloud command in doc/a3/ROUTER_SPEC.md). Compare the observed routes to expected local → cloud → held → local and report pass/fail per prompt with reasons. Ask the user to paste outputs; never assume results. Save a summary to evidence/ with a dated filename after the user confirms.
