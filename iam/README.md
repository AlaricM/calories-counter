# IAM least-privilege setup

Two identities operate this project. Both are locked down here so a leaked
credential can touch **only** this stack's resources — not the whole account.

| Identity | What it is | Policy file |
|---|---|---|
| **Deploy/operator user** | The human/CI IAM user whose keys run `cdk deploy` and `npm run user` | [`deploy-user-policy.json`](deploy-user-policy.json) |
| **CDK CloudFormation execution role** | `cdk-hnb659fds-cfn-exec-role-*`, the role CloudFormation assumes to create resources during a deploy. **AdministratorAccess by default.** | [`cdk-exec-scoped-policy.json`](cdk-exec-scoped-policy.json) |
| **Permissions boundary** | A cap attached to *every role this stack creates* (chat Lambda runtime role, budget-action role, and the CDK `BucketDeployment` / auto-delete custom-resource roles), so none can ever exceed the app's real needs — even if a broader policy is attached. | [`permissions-boundary-policy.json`](permissions-boundary-policy.json) |

> The chat Lambda **runtime** role is created by the stack and is already
> least-privilege in code (`lib/food-tracker-stack.ts` — DynamoDB actions on the
> three tables only; it reaches OpenAI over the internet, which needs no IAM).
> The boundary is a second, independent ceiling. Because a boundary is an
> *intersection*, the extra S3/CloudFront entries below don't grant the chat
> Lambda anything — its identity policy is DynamoDB-only — they exist so the
> deploy-time custom-resource roles (which upload the site + invalidate the CDN)
> can function under the same cap.

### What each policy now covers

- **`cdk-exec-scoped-policy.json`** grew two statements: `ManageStackSiteBucket`
  (create/configure the private site bucket, scoped to `foodtrackermcpstack-*`)
  and `ManageStackCloudFront`. CloudFront's `Create*` actions **don't support
  resource-level scoping**, so that statement uses `Resource: "*"` — the operator
  identity is otherwise locked to this stack, so the blast radius is limited to
  CloudFront management. `lambda:InvokeFunction` was added so CloudFormation can
  drive the `BucketDeployment` custom resource during a deploy.
- **`permissions-boundary-policy.json`** grew `SiteDeploymentS3Access` (read the
  CDK assets bucket, write the site bucket) and `SiteDeploymentCloudFrontInvalidate`,
  which the `BucketDeployment` / auto-delete Lambdas need.

Before applying: replace `<ACCOUNT_ID>` in all three files, and confirm the region
is `us-east-1` (change if you deploy elsewhere). The `hnb659fds` string is CDK's
default bootstrap qualifier — change it only if you bootstrapped with a custom one.

## Why both

The user policy alone isn't enough: with the default CDK model, the operator only
needs `sts:AssumeRole` on the CDK roles — but the deploy then runs as the
**exec role**, which is `AdministratorAccess`. So a leaked operator key could still
deploy anything. Scoping the exec role (below) closes that.

## Apply safely (you run these — admin session)

The golden rule: **add the new permissions, verify a deploy still works, and only
then remove admin.** Never the reverse — you can lock yourself out of your own
deploy path. Keep a break-glass admin (root+MFA, or a second admin user) for
`cdk bootstrap` and recovery.

### 1. Scope the CDK execution role + boundary (re-bootstrap)

Order matters: the boundary policy must exist **first**, because the scoped exec
policy refers to it (it only lets deploys create roles that carry the boundary).

```sh
# a) Create the permissions boundary (the ceiling on all stack-created roles):
aws iam create-policy \
  --policy-name food-tracker-boundary \
  --policy-document file://iam/permissions-boundary-policy.json

# b) Create the scoped CDK execution policy:
aws iam create-policy \
  --policy-name food-tracker-cdk-exec \
  --policy-document file://iam/cdk-exec-scoped-policy.json

# c) Re-bootstrap: deploys now run under the scoped policy AND stamp the boundary
#    onto every role the stack creates:
npx cdk bootstrap aws://<ACCOUNT_ID>/us-east-1 \
  --cloudformation-execution-policies "arn:aws:iam::<ACCOUNT_ID>:policy/food-tracker-cdk-exec" \
  --custom-permissions-boundary food-tracker-boundary

# d) Verify a deploy still works end-to-end:
npx cdk deploy
```

If the deploy fails with an `AccessDenied`, add the named action to
`cdk-exec-scoped-policy.json` (or, if a stack role is blocked at runtime, to
`permissions-boundary-policy.json`), bump the policy (`aws iam
create-policy-version --set-as-default`), and redeploy. This is the normal
tightening loop — these policies are a correct-shape starting point derived from
the current code, not guaranteed complete for future resources you add.

### 2. Lock down the operator user

```sh
aws iam put-user-policy \
  --user-name <YOUR_DEPLOY_USER> \
  --policy-name food-tracker-deploy \
  --policy-document file://iam/deploy-user-policy.json

# Test: cdk diff + npm run user -- list should both work.
# THEN remove admin from the day-to-day user:
aws iam detach-user-policy \
  --user-name <YOUR_DEPLOY_USER> \
  --policy-arn arn:aws:iam::aws:policy/AdministratorAccess
```

## How the escalation hole is closed

Without a boundary, the scoped exec role could still create an IAM role named
`FoodTrackerMcpStack-*` and attach wide permissions to it — privilege escalation.
Two things (both in step 1) shut that down:

1. **The boundary** (`permissions-boundary-policy.json`) caps every stack-created
   role to logs + the three DynamoDB tables + the site/asset S3 buckets +
   CloudFront invalidation + the kill-switch attach. Even if a broader policy
   were attached, effective permissions = policy ∩ boundary.
2. **The exec policy's `iam:PermissionsBoundary` condition** means the exec role
   can *only* create roles that carry that boundary — a boundary-less role can't
   be created during a deploy at all.

Deleting/replacing the boundary is a bootstrap-level op that needs the break-glass
admin, so a locked-down deploy path can't quietly widen it.

## Notes

- `cdk bootstrap` itself needs near-admin rights (it creates roles + buckets).
  It's a one-time / rare op — run it from the break-glass admin, not the
  locked-down operator user.
- Strongest single win regardless of the above: use short-lived credentials
  (`aws configure sso`) instead of long-lived access keys.
