# How to install this handoff into chitti-assistant

1. Unzip into the repo root (it does not overwrite PROCESS_LOG.md, README.md, .env.example, or opencode.json):
   - `AGENTS.md` → repo root (OpenCode loads it automatically)
   - `doc/a3/` → design, plan, status, router spec, requirements, and the HTML design
   - `.opencode/commands/` → slash commands `/next`, `/lesson`, `/hint`, `/explain`, `/review`, `/done`, `/check-requirements`, `/secret-scan`, `/router-test`
   - `.opencode/agents/mentor.md` → a mentor agent that explains and reviews but cannot edit files (switch with Tab)
   - `local/Modelfile.a3-e2b` → the official Gemma Modelfile
2. Merge the `instructions` entry from `opencode.instructions.example.json` into your existing `opencode.json` (keep your other settings), so STATUS.md is always in context. Then delete the example file.
3. In PROCESS_LOG.md, add a heading `## Development notes` if it doesn't exist (the `/done` command appends there).
4. Start OpenCode in the repo, switch to the **mentor** agent, and run `/lesson A1`. See `doc/a3/LEARNING_PATH.md` for the full path and who writes what.
