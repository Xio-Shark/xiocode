## What changed

<!-- One paragraph. Lead with the behaviour change, not the file list. -->

## Why

<!-- The bug, gap, or user-visible problem this closes. Link the issue if there is one. -->

## Evidence

<!-- Real commands and their real output. Paste the failing case too when there was one. -->

```text
$ npm run check
$ npm run test:unit
```

## Risk and rollback

- Risk:
- Rollback:

## Checklist

- [ ] Surgical diff, no unrelated reformatting
- [ ] Tests cover the new behaviour (or the reason they cannot is stated)
- [ ] No secrets, API keys, tokens, or private paths in the diff
- [ ] README / docs updated when user-visible behaviour changed
- [ ] If this touches the process layer: `npx vitest run src/runtime/process/` is green
