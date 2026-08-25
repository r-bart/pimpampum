# Architecture

Document your architecture patterns and rules here.

## General Guidelines

- Keep related code together
- Avoid circular dependencies
- Separate concerns appropriately

---

## Quality Checks

Run after every change:

```bash
npm run test
```

### Rules

- All code must pass type checking
- All code must pass linting
- Tests must pass before committing
- No `any` types without explicit reason