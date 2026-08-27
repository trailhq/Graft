#!/usr/bin/env bash
#
# Build the App, push it to ECR, and create or update its App Runner service.
#
# Idempotent: run it again to deploy a new build. Nothing here is graft-specific
# beyond the names at the top — it is the whole deploy.
#
# Prerequisites: awscli v2, docker, and credentials for the account that owns the
# Route 53 zone. The secrets must exist first (see `secrets` below).
set -euo pipefail

SERVICE="${SERVICE:-graft-app}"
REGION="${AWS_REGION:-us-east-1}"
REPO="${REPO:-$SERVICE}"
PUBLIC_URL="${GRAFT_PUBLIC_URL:?set GRAFT_PUBLIC_URL, e.g. https://graft.nanonets.ai}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
ECR="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
IMAGE="${ECR}/${REPO}:$(git rev-parse --short HEAD)"

# Names of the secrets this expects in Secrets Manager. Create them once:
#
#   aws secretsmanager create-secret --name graft/app-id            --secret-string 123456
#   aws secretsmanager create-secret --name graft/webhook-secret    --secret-string "$(openssl rand -hex 32)"
#   aws secretsmanager create-secret --name graft/private-key --secret-string file://graft.private-key.pem
#
# The private key is multi-line PEM; Secrets Manager keeps it verbatim and the
# app also accepts the `\n`-escaped form, so either survives a round trip.
SEC_APP_ID="arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:graft/app-id"
SEC_WEBHOOK="arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:graft/webhook-secret"
SEC_KEY="arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:graft/private-key"

echo "→ ECR repository"
aws ecr describe-repositories --repository-names "$REPO" --region "$REGION" >/dev/null 2>&1 \
  || aws ecr create-repository --repository-name "$REPO" --region "$REGION" >/dev/null

aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$ECR" >/dev/null

echo "→ build $IMAGE"
# --platform is not optional from a Mac: App Runner is x86_64 only, and an arm64
# image fails at runtime with an exec-format error rather than at push time.
docker build --platform linux/amd64 -t "$IMAGE" .
docker push "$IMAGE"

ARN="$(aws apprunner list-services --region "$REGION" \
  --query "ServiceSummaryList[?ServiceName=='${SERVICE}'].ServiceArn | [0]" --output text)"

CONFIG=$(cat <<JSON
{
  "ImageRepository": {
    "ImageIdentifier": "${IMAGE}",
    "ImageRepositoryType": "ECR",
    "ImageConfiguration": {
      "Port": "3000",
      "RuntimeEnvironmentVariables": { "GRAFT_PUBLIC_URL": "${PUBLIC_URL}" },
      "RuntimeEnvironmentSecrets": {
        "GRAFT_APP_ID": "${SEC_APP_ID}",
        "GRAFT_WEBHOOK_SECRET": "${SEC_WEBHOOK}",
        "GRAFT_APP_PRIVATE_KEY": "${SEC_KEY}"
      }
    }
  },
  "AutoDeploymentsEnabled": false,
  "AuthenticationConfiguration": {
    "AccessRoleArn": "arn:aws:iam::${ACCOUNT}:role/service-role/AppRunnerECRAccessRole"
  }
}
JSON
)

if [ "$ARN" = "None" ] || [ -z "$ARN" ]; then
  echo "→ create service"
  # MaxSize 1 is load-bearing, not thrift: viewer pages are held in the process,
  # so a second instance would 404 links minted by the first. Removing this cap
  # means moving PageStore to S3 or a database first.
  aws apprunner create-service --region "$REGION" \
    --service-name "$SERVICE" \
    --source-configuration "$CONFIG" \
    --instance-configuration "Cpu=1 vCPU,Memory=2 GB,InstanceRoleArn=arn:aws:iam::${ACCOUNT}:role/${SERVICE}-instance" \
    --health-check-configuration "Protocol=HTTP,Path=/healthz,Interval=10,Timeout=5,HealthyThreshold=1,UnhealthyThreshold=5" \
    --auto-scaling-configuration-arn "$(aws apprunner create-auto-scaling-configuration \
        --region "$REGION" --auto-scaling-configuration-name "${SERVICE}-single" \
        --max-size 1 --min-size 1 --max-concurrency 20 \
        --query AutoScalingConfiguration.AutoScalingConfigurationArn --output text)" \
    --query "Service.ServiceUrl" --output text
else
  echo "→ update service"
  aws apprunner update-service --region "$REGION" --service-arn "$ARN" \
    --source-configuration "$CONFIG" --query "Service.ServiceUrl" --output text
  aws apprunner start-deployment --region "$REGION" --service-arn "$ARN" >/dev/null
fi

echo
echo "Service URL above. Next:"
echo "  1. aws apprunner associate-custom-domain --region $REGION --service-arn <arn> --domain-name ${PUBLIC_URL#https://}"
echo "  2. add the CNAME records it returns to Route 53 (validation + the domain itself)"
echo "  3. set the App's webhook URL to ${PUBLIC_URL}/webhook and tick Active"
