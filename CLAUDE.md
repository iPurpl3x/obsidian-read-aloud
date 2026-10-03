# CLAUDE.md

## Threadline — the current work record

Use Threadline for current requests, tasks, decisions and handoffs: run `tl start`, then `tl guide`
(load a focused topic such as `tl guide curation` or `tl guide inbox` only when the work needs it).
Claude's native hooks capture each prompt automatically; `tl run claude PROMPT_FILE --project
PROJECT_ID` is the supervised fallback when they are unavailable. Ask the user questions through the
Threadline Inbox (`review.ask`), not in chat. Pause normal work if the recording service is down.
