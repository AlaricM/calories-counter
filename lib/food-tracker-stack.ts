import * as path from "path";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";

interface FoodTrackerStackProps extends cdk.StackProps {
  /** OpenAI API key for the chat orchestrator + nutrition search (from .env). */
  openaiApiKey?: string;
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

    // --- Compute: chat orchestrator ------------------------------------
    // The backend for the web app. Holds the system prompt, runs the agentic
    // loop against OpenAI, and drives the food/daily tools in-process against
    // DynamoDB. The nutrition web-search is just another tool it can call.
    const chatFn = new NodejsFunction(this, "ChatFunction", {
      entry: path.join(import.meta.dirname, "../lambda/chat/index.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64, // Graviton2: faster + cheaper; pure-JS deps
      memorySize: 512,
      timeout: cdk.Duration.seconds(120), // web search + multi-turn tool loop can exceed 15s
      environment: {
        TABLE_NAME: itemsTable.tableName,
        DAILY_TABLE_NAME: dailyTable.tableName,
        USERS_TABLE_NAME: usersTable.tableName,
        OPENAI_API_KEY: props.openaiApiKey ?? "",
      },
      bundling: {
        minify: true,
        sourceMap: false,
      },
    });

    // Least privilege, per table — exactly the actions the code in
    // lambda/shared/db.ts issues, nothing more:
    //   items — Get / Put / Query / Delete (add, upsert, lookup, delete).
    //   daily — Get / Put / Query / Delete (log, list, delete + reorder).
    //   users — READ ONLY. The Lambda authenticates against this table but must
    //           never be able to mint or alter keys; that's an admin-only op
    //           (scripts/manage-users.ts, run with your deploy credentials).
    itemsTable.grant(chatFn, "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:DeleteItem");
    dailyTable.grant(chatFn, "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:DeleteItem");
    usersTable.grant(chatFn, "dynamodb:GetItem");

    // --- Public streaming endpoint --------------------------------------
    // Function URLs are free and support RESPONSE_STREAM, which lets the browser
    // render the assistant's reply token-by-token (Server-Sent Events). IAM auth
    // is NONE by design; access is gated per-user by the API key checked inside
    // the Lambda — see lambda/chat/index.ts.
    const chatUrl = chatFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
      cors: {
        allowedOrigins: ["*"],
        allowedMethods: [lambda.HttpMethod.POST],
        allowedHeaders: ["Content-Type", "Authorization"],
      },
    });

    // --- Frontend hosting: private S3 + CloudFront (HTTPS) --------------
    // The site is public, but an API key gets typed into it, so it must be
    // served over HTTPS — hence CloudFront in front of a private bucket (Origin
    // Access Control), not an HTTP S3 website endpoint. The bucket holds only
    // build artifacts (no user data), so it's DESTROY + auto-empty on teardown.
    const siteBucket = new s3.Bucket(this, "SiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const distribution = new cloudfront.Distribution(this, "SiteDistribution", {
      defaultRootObject: "index.html",
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100, // US/EU edges — cheapest; free tier covers personal use
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      // Single-page app: route everything back to index.html.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html" },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html" },
      ],
    });

    // Upload the built React app plus a deploy-time config.json carrying the chat
    // API URL (resolved here, at deploy, and fetched by the app at startup — the
    // static bundle stays environment-agnostic). Requires `npm run build:web`
    // first so web/dist exists.
    new s3deploy.BucketDeployment(this, "DeploySite", {
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ["/*"], // invalidate CloudFront cache on each deploy
      sources: [
        s3deploy.Source.asset(path.join(import.meta.dirname, "../web/dist")),
        s3deploy.Source.jsonData("config.json", { chatUrl: chatUrl.url }),
      ],
    });

    // --- Cost guardrail -------------------------------------------------
    // Everything AWS-side sits in free/near-free tiers, so any nonzero AWS spend
    // is a signal that something is misconfigured. (OpenAI usage is billed
    // separately by OpenAI and is not covered by this AWS budget.) A tiny monthly
    // budget acts as a canary; email alerts are added only if ALERT_EMAIL is set.
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
    // attaches a blanket Deny policy to the chat Lambda's execution role, cutting
    // the app off from Lambda / S3 / DynamoDB until you intervene. The app goes
    // dark, but so does the cost driver (DynamoDB reads/writes).
    //
    // Caveat: this denies what the app's *identity* can do. The Function URL can
    // still invoke the Lambda (invocation isn't gated by the execution role), so
    // trivial compute cost may continue — but every DynamoDB call fails, so the
    // request does nothing. For a hard stop, remove the Function URL or disable
    // the function manually once alerted.
    //
    // A budget action requires at least one subscriber, so the kill switch is
    // only wired up when ALERT_EMAIL is set.
    if (props.alertEmail) {
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

      const budgetActionRole = new iam.Role(this, "BudgetActionRole", {
        roleName: "food-tracker-budget-action",
        assumedBy: new iam.ServicePrincipal("budgets.amazonaws.com"),
        description: "Assumed by AWS Budgets to enforce the over-budget kill switch.",
      });
      budgetActionRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ["iam:AttachRolePolicy", "iam:DetachRolePolicy"],
          resources: [chatFn.role!.roleArn],
          conditions: {
            ArnEquals: { "iam:PolicyARN": overBudgetDeny.managedPolicyArn },
          },
        }),
      );

      const killSwitch = new budgets.CfnBudgetsAction(this, "OverBudgetKillSwitch", {
        budgetName,
        actionType: "APPLY_IAM_POLICY",
        actionThreshold: { value: budgetLimitUsd, type: "ABSOLUTE_VALUE" },
        notificationType: "ACTUAL",
        approvalModel: "AUTOMATIC",
        executionRoleArn: budgetActionRole.roleArn,
        definition: {
          iamActionDefinition: {
            policyArn: overBudgetDeny.managedPolicyArn,
            roles: [chatFn.role!.roleName], // IamActionDefinition wants role NAMES
          },
        },
        subscribers: [{ type: "EMAIL", address: props.alertEmail }],
      });
      killSwitch.addDependency(monthlyBudget);
    }

    // --- Outputs --------------------------------------------------------
    new cdk.CfnOutput(this, "SiteUrl", {
      value: `https://${distribution.distributionDomainName}`,
      description: "Open this in a browser to use the calorie tracker web app.",
    });
    new cdk.CfnOutput(this, "ChatApiUrl", {
      value: chatUrl.url,
      description:
        "Streaming chat backend the web app POSTs to (with an `Authorization: Bearer <key>` header).",
    });
  }
}
