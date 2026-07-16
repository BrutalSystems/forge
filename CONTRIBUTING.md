# Contributing to Forge

Thanks for your interest in contributing! This guide covers how to get set up
and how to submit changes.

## Ways to contribute

- **Report a bug or request a feature** — open an [issue](https://github.com/BrutalSystems/forge/issues).
- **Submit a fix or improvement** — open a pull request (see below).

## Development setup

Forge requires **Node.js >= 20**.

```bash
# 1. Fork the repo on GitHub, then clone your fork
git clone git@github.com:<your-username>/forge.git
cd forge

# 2. Install dependencies (this also installs the web dashboard deps and builds it)
npm install

# 3. Run the test suite
npm test
```

Useful scripts:

| Command | What it does |
| --- | --- |
| `npm test` | Run the Jest test suite |
| `npm run test:watch` | Run tests in watch mode |
| `npm run build:web` | Build the web dashboard |
| `npm run dev:web` | Run the web dashboard in dev mode |

## Submitting a pull request

Outside contributors don't have write access to this repo, so changes come in
through the standard **fork-and-pull-request** flow:

1. **Fork** the repository to your own account and clone your fork (see setup above).
2. **Create a branch** for your change:
   ```bash
   git checkout -b my-fix
   ```
3. **Make your change.** Please add or update tests where it makes sense, and
   keep changes focused — smaller PRs are easier to review and merge.
4. **Run the tests** locally and make sure they pass:
   ```bash
   npm test
   ```
5. **Push to your fork** and open a PR against `main`:
   ```bash
   git push origin my-fix
   ```
   Then open a pull request from your branch to `BrutalSystems/forge:main`.

### What to expect

- **CI runs on every PR** across macOS, Linux, and Windows. For first-time
  contributors, a maintainer needs to approve the workflow run before it starts.
- `main` is protected: a PR needs a **passing CI run** and **approval from a
  maintainer** (code owner) before it can be merged. Please don't be discouraged
  if review takes a little time.
- Keep your branch up to date with `main` if CI asks for it.

## Commit messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/)
style where practical, e.g.:

```
fix(daemon): skip port-less processes in allocatePorts
feat(cli): add `forge logs --follow`
docs: clarify release process
```

This isn't strictly enforced, but consistent history helps.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](./LICENSE) that covers this project.
