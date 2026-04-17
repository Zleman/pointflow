# Contributing

## Dev setup

```bash
git clone https://github.com/Zleman/pointflow.git
cd pointflow
npm install
```

Start the demo:

```bash
npm run dev:demo
```

Run tests:

```bash
npm test
```

Run benchmarks:

```bash
npm run bench
```

Full release check (tests + benchmarks + typecheck + build):

```bash
npm run release:check
```

## Pull requests

- Tests are required for new behaviour. Run `npm test` before opening a PR.
- New dependencies need discussion first — open an issue before adding one.
- Keep changes focused. Bug fixes shouldn't include unrelated refactors.
- The `demo/` directory is for the hosted demo only. Don't modify it in library PRs.

## Reporting bugs

Open an issue with a minimal reproduction. Include your browser, OS, and whether you're on the WebGPU or WebGL path (`onRendererResolved` will tell you).
