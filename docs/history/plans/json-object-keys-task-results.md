# Henji Harness roadmap step 9 result

- Added `list_json_object_keys` and used it on the real non-secret `deno.v0.json` `tasks` object.
- The real model made two requests, selected the tool once, received one result, and returned all 12
  task names.
- Its JSON array contained spaces while the tool result was compact JSON. The task had completed
  correctly; the local completion check now compares parsed string arrays instead of serialization.
- No retry or second provider attempt was made.
- Direct tool tests: 3 passed. Full v0 suite: 75 passed. Type, format, and diff checks passed.
