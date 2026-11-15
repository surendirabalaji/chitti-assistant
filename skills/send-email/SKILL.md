---
name: send-email
description: "The only way to send an email. Every send needs the owner's approval and goes only to allowlisted recipients. Use gog for reading mail and creating drafts."
metadata:
  {
    "openclaw":
      {
        "emoji": "✉️",
        "requires": { "bins": ["send-email"] },
      },
  }
---

# send-email

`gog` cannot send mail on this agent (`gog gmail send`, `gog gmail drafts send` and replies are blocked).
To send an email, use `send-email`:

1. Write the plain-text body to a file in the workspace, for example `drafts/message.txt`.
2. Run:

```bash
send-email --to chittia3assistant@gmail.com --subject "Short subject" --body-file drafts/message.txt
```

Rules:

- Exactly one recipient. No `--cc` or `--bcc`. Recipients outside the allowlist are refused (exit 3); do not retry with another address and do not try other ways to send.
- The owner must approve every send in Telegram. If approval is denied or times out, tell the user the email was not sent.
- Scheduled jobs (briefing, recap, alerts) never send. They create a draft with `gog gmail drafts create --to ... --subject ... --body-file ...` and tell the user a draft is waiting.
- Exit codes: 0 sent, 2 bad usage (fix the arguments), 3 recipient not allowed, 4 Gmail error.
