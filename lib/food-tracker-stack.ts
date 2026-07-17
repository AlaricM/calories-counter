import * as path from "path";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as iam from "aws-cdk-lib/aws-iam";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";

interface FoodTrackerStackProps extends cdk.StackProps {
  /** Optional email address for AWS Budgets cost alerts. */
  alertEmail?: string;
  /** Monthly budget ceiling in USD that trips the cost alarm. Default: 1. */
  monthlyBudgetUsd?: number;
}

export class FoodTrackerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: FoodTrackerStackProps = {}) {
    super(scope, id, props);

    // --- Storage: food items -------------------------------------------
    // Composite key isolates each user's foods in their own partition:
    //   partition = userId, sort = itemLower (normalized name).
    // A lookup is a Query scoped to userId, so one user can never read another's
    // data. Provisioned (not on-demand) to stay in DynamoDB's Always-Free
    // 25 RCU / 25 WCU allowance, which is shared across all tables in the account.
    const itemsTable = new dynamodb.Table(this, "FoodItemsTable", {
      tableName: "food-tracker-items",
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "itemLower", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: 5,
      writeCapacity: 5,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // don't lose food logs on `cdk destroy`
    });

    // --- Storage: users (API keys) -------------------------------------
    // partition = apiKeyHash (SHA-256 of the key). One key = one user. Reads on
    // every request (auth); writes are rare (admin adds/revokes users), hence
    // low write capacity.
    const usersTable = new dynamodb.Table(this, "UsersTable", {
      tableName: "food-tracker-users",
      partitionKey: { name: "apiKeyHash", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: 5,
      writeCapacity: 1,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // don't lock everyone out on `cdk destroy`
    });

    // --- Storage: daily tracker ----------------------------------------
    // Composite key isolates each user's daily entries in their own partition:
    //   partition = userId, sort = dayOrder (day + padded item order).
    // The query for the latest item uses begins_with(day) to get today's last entry.
    const dailyTable = new dynamodb.Table(this, "DailyTrackerTable", {
      tableName: "food-tracker-daily",
      partitionKey: { name: "userId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "dayOrder", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: 5,
      writeCapacity: 5,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // --- Compute --------------------------------------------------------
    const mcpFn = new NodejsFunction(this, "McpServerFunction", {
      entry: path.join(import.meta.dirname, "../lambda/mcp-server/index.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64, // Graviton2: faster + cheaper; pure-JS deps so zero compat risk
      memorySize: 256,
      timeout: cdk.Duration.seconds(15),
      environment: {
        TABLE_NAME: itemsTable.tableName,
        DAILY_TABLE_NAME: dailyTable.tableName,
        USERS_TABLE_NAME: usersTable.tableName,
      },
      bundling: {
        minify: true,
        sourceMap: false,
        // No explicit `target`: NodejsFunction derives a matching esbuild
        // target from `runtime`, so we don't depend on esbuild already knowing
        // a "node24" target string.
      },
    });

    // Least privilege, per table — exactly the actions the code in
    // lambda/mcp-server/db.ts issues, nothing more:
    //   items — Get / Put / Query / Delete (add, upsert, lookup, delete).
    //   daily — Get / Put / Query / Delete (log, list, delete + reorder).
    //   users — READ ONLY. The Lambda authenticates against this table but must
    //           never be able to mint or alter keys; that's an admin-only op
    //           (scripts/manage-users.ts, run with your deploy credentials).
    itemsTable.grant(mcpFn, "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:DeleteItem");
    dailyTable.grant(mcpFn, "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:DeleteItem");
    usersTable.grant(mcpFn, "dynamodb:GetItem");

    // --- Public HTTPS endpoint ------------------------------------------
    // Function URLs are free and, unlike API Gateway, support the chunked
    // responses the MCP Streamable HTTP transport can use. IAM auth is NONE by
    // design (Joey can't sign SigV4 requests); access is gated per-user by the
    // API key checked inside the Lambda — see lambda/mcp-server/index.ts.
    const fnUrl = mcpFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: ["*"],
        allowedHeaders: ["Content-Type", "Accept", "Authorization", "Mcp-Session-Id"],
      },
    });

    // --- Cost guardrail -------------------------------------------------
    // Everything above sits in the permanent Always-Free tier, so any nonzero
    // spend is a signal that something is misconfigured. A tiny monthly budget
    // acts as a canary. Email alerts are added only if ALERT_EMAIL is set.
    const budgetName = "food-tracker-monthly";
    const budgetLimitUsd = props.monthlyBudgetUsd ?? 1;
    const notificationsWithSubscribers = props.alertEmail
      ? [
          {
            notification: {
              notificationType: "ACTUAL",
              comparisonOperator: "GREATER_THAN",
              threshold: 80,
              thresholdType: "PERCENTAGE",
            },
            subscribers: [{ subscriptionType: "EMAIL", address: props.alertEmail }],
          },
          {
            notification: {
              notificationType: "FORECASTED",
              comparisonOperator: "GREATER_THAN",
              threshold: 100,
              thresholdType: "PERCENTAGE",
            },
            subscribers: [{ subscriptionType: "EMAIL", address: props.alertEmail }],
          },
        ]
      : undefined;

    const monthlyBudget = new budgets.CfnBudget(this, "MonthlyCostBudget", {
      budget: {
        budgetName,
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: budgetLimitUsd, unit: "USD" },
      },
      notificationsWithSubscribers,
    });

    // --- Cost kill switch (budget action) -------------------------------
    // When ACTUAL month-to-date spend crosses the budget limit, AWS Budgets
    // attaches a blanket Deny policy to this stack's Lambda execution role,
    // cutting the app off from Lambda / S3 / DynamoDB until you intervene.
    // The app goes dark, but so does the cost driver (DynamoDB reads/writes).
    //
    // Caveat: this denies what the app's *identity* can do. The Function URL
    // can still invoke the Lambda (invocation isn't gated by the execution
    // role), so trivial compute cost may continue — but every DynamoDB call
    // fails, so the request does nothing. For a hard stop, remove the Function
    // URL or disable the function manually once alerted.
    //
    // A budget action requires at least one subscriber, so the kill switch is
    // only wired up when ALERT_EMAIL is set.
    if (props.alertEmail) {
      // The policy Budgets attaches when the threshold trips. Broad by design:
      // deny every Lambda, S3, and DynamoDB action on every resource. An
      // explicit Deny overrides the least-privilege grants above.
      const overBudgetDeny = new iam.ManagedPolicy(this, "OverBudgetDenyPolicy", {
        managedPolicyName: "food-tracker-over-budget-deny",
        description:
          "Attached by AWS Budgets when the monthly budget is exceeded: denies all Lambda, S3, and DynamoDB actions.",
        statements: [
          new iam.PolicyStatement({
            sid: "DenyAllAppServices",
            effect: iam.Effect.DENY,
            actions: ["lambda:*", "s3:*", "dynamodb:*"],
            resources: ["*"],
          }),
        ],
      });

      // Role that AWS Budgets assumes to enforce the action. Least privilege:
      // it may only attach/detach the deny policy on this stack's Lambda role.
      const budgetActionRole = new iam.Role(this, "BudgetActionRole", {
        roleName: "food-tracker-budget-action",
        assumedBy: new iam.ServicePrincipal("budgets.amazonaws.com"),
        description: "Assumed by AWS Budgets to enforce the over-budget kill switch.",
      });
      budgetActionRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ["iam:AttachRolePolicy", "iam:DetachRolePolicy"],
          resources: [mcpFn.role!.roleArn],
          // Restrict to attaching only the deny policy, nothing else.
          conditions: {
            ArnEquals: { "iam:PolicyARN": overBudgetDeny.managedPolicyArn },
          },
        }),
      );

      const killSwitch = new budgets.CfnBudgetsAction(this, "OverBudgetKillSwitch", {
        budgetName,
        actionType: "APPLY_IAM_POLICY",
        // Trip the moment ACTUAL spend reaches the dollar limit ("above $1").
        actionThreshold: { value: budgetLimitUsd, type: "ABSOLUTE_VALUE" },
        notificationType: "ACTUAL",
        // AUTOMATIC = apply without waiting for manual approval.
        approvalModel: "AUTOMATIC",
        executionRoleArn: budgetActionRole.roleArn,
        definition: {
          iamActionDefinition: {
            policyArn: overBudgetDeny.managedPolicyArn,
            roles: [mcpFn.role!.roleName], // IamActionDefinition wants role NAMES
          },
        },
        subscribers: [{ type: "EMAIL", address: props.alertEmail }],
      });
      // The action references the budget by name; make the ordering explicit.
      killSwitch.addDependency(monthlyBudget);
    }

    // --- Output ---------------------------------------------------------
    // One base URL for everyone. Each user's own API key (from
    // `npm run user -- add`) is what authenticates them:
    //   Joey   -> use this URL + header  `Authorization: Bearer <their key>`
    //   Claude -> use  <this URL>/<their key>  (secret in the path)
    new cdk.CfnOutput(this, "McpServerUrl", {
      value: `${fnUrl.url}mcp`,
      description:
        "Base MCP endpoint. Create a key with `npm run user -- add`; Joey uses this URL + a Bearer header, Claude uses <url>/<key>.",
    });
  }
}
