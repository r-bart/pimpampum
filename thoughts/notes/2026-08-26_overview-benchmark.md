# Overview Benchmark

**Date**: 2026-08-26  
**Host**: macOS 26.5.2, arm64  
**Command**: `npm run benchmark:overview`

The reproducible benchmark creates an in-memory SQLite database with 500 ready projects and 5,000 open tasks. Markdown bodies are populated to ensure the overview query continues to omit them. It warms the query once, records five overview-only samples, and independently verifies that `availableWork` agrees with `listWork`.

Observed result:

```json
{
  "fixture": { "projects": 500, "tasks": 5000 },
  "availableWork": 5000,
  "samplesMilliseconds": [6.833, 7.109, 7.264, 7.386, 7.456],
  "minMilliseconds": 6.833,
  "medianMilliseconds": 7.264,
  "maxMilliseconds": 7.456,
  "thresholdEnforced": false
}
```

The 100 ms product target is comfortably met on the reference machine. The script deliberately reports rather than enforces that target because shared CI and future hardware can have materially different timing characteristics; correctness, bounds, and query-field exclusions remain hard test gates.
