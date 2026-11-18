# Deployment Authorization Guardrail

**Status:** Standing operating control  
**Scope:** LexiBite and connected Nolmark project work performed against this repository  
**Authority:** Explicit user authorization is required for every deployment or promotion action.

## Non-negotiable rule

Do not initiate a Vercel deployment, preview deployment, production deployment, promotion, alias/domain reassignment, rollback, or production cutover unless the user has explicitly authorized that specific action.

This prohibition applies even when:
- a code change is complete;
- lint, tests, typecheck, build, or migration replay pass;
- a pull request is approved or merged;
- a deployment would normally be the next step in an automated workflow;
- a preview URL would be convenient for review.

## Permitted without deployment authorization

- Repository inspection, code changes and commits on non-production branches.
- Static analysis, unit/integration tests, typecheck and local build verification.
- PostgreSQL migration replay in isolated CI/test databases.
- Pull-request creation and CI execution, provided no merge or deploy is triggered.
- Preparing deployment instructions, release checklists and rollback plans without executing them.

## Required execution sequence

1. Inspect the current repository, branch, deployment configuration and environment.
2. Identify the precise change and its blast radius.
3. Implement on a non-production branch.
4. Run relevant tests and verify the exact commit.
5. Report the evidence and remaining release dependencies.
6. Stop before any Vercel or production action.
7. Obtain explicit authorization naming the target environment and action before deployment.

## Protected actions

Never infer authorization to:
- deploy to Vercel;
- promote a preview to production;
- change production environment variables or secrets;
- change domains, aliases or project settings;
- apply migrations or write to production databases;
- alter production credentials or provider bindings;
- merge a release PR or initiate a cutover.

A successful CI run is verification evidence, not deployment authorization.
