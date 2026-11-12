---
description: Scan the repo for secrets before a commit or submission
---
Search the repo (including evidence/ and doc/) for anything that looks like a credential: API keys, OAuth tokens, refresh tokens, `tskey-`, Telegram bot tokens (digits:alphanumeric), private keys, passwords, gateway tokens, email passwords, Tailscale share links, and `.env` files other than `.env.example`. Use grep/rg; do not print matched secret values in full (show file, line, and the first 4 characters only). Report findings and suggest fixes. Also check .gitignore covers .env, evidence raw exports with tokens, and any local auth files. $ARGUMENTS
