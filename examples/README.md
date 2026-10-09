# Demo projects

TtySage has no knowledge of any of these tools. They are here so you can watch the generic pipeline handle them.

| Demo | Setup | Run |
|---|---|---|
| Drizzle (SQLite) | `cd drizzle && npm install && node reset.mjs` | `ttysage run "npx drizzle-kit push"` |
| Prisma (SQLite) | `cd prisma && npm install && ./reset.sh` | `ttysage run "npx prisma migrate dev"` |
| Terraform (built-in provider, offline) | `cd terraform && terraform init` | `ttysage run "terraform apply"` then `ttysage run "terraform apply -var release=v2"` |
| npm | any empty dir | `ttysage run "npm init"` |
| git | a repo with ≥3 commits | `GIT_EDITOR=vim ttysage run "git rebase -i HEAD~3"` |

`reset.*` recreates a v1 database with three rows and switches the schema to v2: rename `name → full_name`, drop
`legacy_email`, add `email`. The push or migration therefore hits rename ambiguity and data-loss prompts.

All of these, plus `git add -p`, `npm create vite`, `ssh`, `aws configure`, and `sudo`, are automated in
`tests/real-tools` (`pnpm test:real`).
