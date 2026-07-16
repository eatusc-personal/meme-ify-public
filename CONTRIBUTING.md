# Contributing

Contributions are welcome, especially deterministic tests, provider adapters,
accessibility improvements, and clearer risk explanations.

Before opening a pull request:

```bash
npm ci
npm run check
npm audit
```

Keep secrets, database dumps, wallet activity, generated assets, and local
infrastructure details out of commits. New live-trading behavior must preserve
the Phantom approval boundary and include tests for accounting, failure, and
bad-data paths.
