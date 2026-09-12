# Recordings

Recorded Workers AI responses, used by `npm run evals:replay` to score the judged
rules hermetically — no account, no spend, no run-to-run variance.

Generate them with:

```bash
export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=...
npm run evals:record
```

Each file is keyed by a hash of the **prompt text**, so editing a prompt in
`src/codex/judge.ts` invalidates its recording rather than silently scoring the
old one. A missing recording is reported as a degraded rule, never as a miss.
