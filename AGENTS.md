# LogTap Agent Instructions

When debugging frontend issues, inspect LogTap output before changing code.

Find the relevant project under:

.agent/logtap/projects/<project-id>/

Read these files first:

- summaries/latest.md
- logs/client.jsonl

Use the summary to identify:

- top client errors
- repeated warnings
- failed network requests
- recent breadcrumbs before failure
- mapped source file/line if available
- observed vs stored event counts
- suppressed duplicate counts

Prefer fixing root causes over suppressing warnings.

Do not remove logging, retention, dedupe, rate-limit, or redaction safeguards unless explicitly asked.

If source-map mapping failed, inspect the raw stack and verify artifact configuration.
