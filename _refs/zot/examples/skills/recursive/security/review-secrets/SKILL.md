---
name: secret-review
description: Check a change for accidentally exposed credentials and private data.
allowed-tools: [read, bash]
---

# Review for secrets

Use this skill before publishing a change or opening a pull request.

- Search the diff for API keys, tokens, private keys, passwords, and session data.
- Check newly added fixtures and examples as well as source code.
- Replace real-looking values with clearly synthetic placeholders.
- Report the file and line containing every suspicious value.
- Never copy a discovered secret into a report or chat message.
