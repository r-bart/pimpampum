---
alwaysApply: true
---

# Code Quality Checks

After implementing a new feature or modifying existing code, **always run the following checks** before considering the task complete.

## Package Manager Detection

Before running any commands, detect the project's package manager by checking for lockfiles:
- `pnpm-lock.yaml` → Use `pnpm`
- `yarn.lock` → Use `yarn`
- `bun.lockb` → Use `bun`
- `package-lock.json` or none → Use `npm`

Use the detected PM for all commands below (examples show npm but adapt accordingly).

## Required Validation Steps

### 1. Type Checking

<!-- CUSTOMIZE: Update command for your project -->

```bash
npm run typecheck
```

- Fix any type errors before proceeding
- Do not use `any` to bypass errors—find the correct type

### 2. Linting

<!-- CUSTOMIZE: Update command for your project -->

```bash
npm run lint
```

- Fix all linting errors and warnings
- Use `npm run lint:fix` for auto-fixable issues
- For unused variables that are intentional (destructuring), prefix with `_`

### 3. Formatting

<!-- CUSTOMIZE: Update command for your project -->

```bash
npm run format
```

- Run this to ensure consistent code style
- Use `npm run format:check` to verify without modifying

## Order of Operations

```
1. typecheck  →  catches type errors early
2. lint       →  enforces code quality rules
3. format     →  ensures consistent styling
```

## Quick Reference

<!-- CUSTOMIZE: Update for your project -->

```bash
# All checks in sequence
npm run typecheck && npm run lint && npm run format
```

## When to Skip

Only skip these checks if:
- The user explicitly says the change is WIP/draft
- The user specifically asks to skip validation

## Project-Specific Checks

<!-- CUSTOMIZE: Add checks specific to your project -->

Examples to add:
- i18n consistency: `npm run i18n:check`
- Database migrations: `npm run db:check`
- API schema: `npm run api:validate`
- Bundle size: `npm run analyze`

## Pre-Commit Hook (Recommended)

Consider adding a pre-commit hook to automate these checks:

```bash
# Using husky + lint-staged
npx husky install
npm pkg set scripts.prepare="husky install"
npx husky add .husky/pre-commit "npx lint-staged"
```

```json
// package.json
{
  "lint-staged": {
    "*.{ts,tsx}": ["eslint --fix", "prettier --write"],
    "*.{json,md}": ["prettier --write"]
  }
}
```
