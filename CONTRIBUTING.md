# Contributing to diffelens

Thank you for your interest in contributing!

## Getting Started

1. Fork this repository
2. Clone your fork and install dependencies:
   ```bash
   git clone https://github.com/<your-username>/diffelens.git
# or
git clone git@github.com:<your-username>/diffelens.git
   cd diffelens
   npm install
   ```
3. Create a feature branch:
   ```bash
   git checkout -b feat/your-feature
   ```

## Development

```bash
# Type check
npx tsc --noEmit

# Run tests
npm test

# Lint
npm run lint
```

## Submitting Changes

1. Ensure all checks pass (`tsc --noEmit`, `npm test`, `npm run lint`)
2. Commit using [Conventional Commits](https://www.conventionalcommits.org/) format:
   ```
   feat(backend): add new lens type
   fix: correct severity filtering logic
   ```
3. Push your branch and open a Pull Request against `main`

## Reporting Issues

Use [GitHub Issues](https://github.com/Mizune/diffelens/issues) with the provided templates.

## Code of Conduct

Be respectful and constructive. We are all here to build great software together.
