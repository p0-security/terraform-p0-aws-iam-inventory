# Create the P0RoleIamResourceLister role in the root account
resource "aws_iam_role" "root_resource_lister" {
  name = "P0RoleIamResourceLister"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Federated = "accounts.google.com"
        }
        Action = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "accounts.google.com:aud" = var.google_audience_id
          }
        }
      }
    ]
  })
}

# Create the inline policy for the root account role
resource "aws_iam_role_policy" "root_resource_lister_policy" {
  name = "P0RoleIamResourceListerPolicy"
  role = aws_iam_role.root_resource_lister.id

  policy = templatefile("${path.module}/policies/resource_lister_policy.json", {
    account_id = var.root_account_id
  })
}

# Create Resource Explorer index in us-west-2 (will be aggregator)
resource "aws_resourceexplorer2_index" "aggregator" {
  provider = aws.usw2
  type     = "LOCAL"  # Start as LOCAL, will be promoted to AGGREGATOR

  lifecycle {
    ignore_changes = [type]  # Ignore changes to type since we'll promote it
  }
}

# Create view in us-west-2
resource "aws_resourceexplorer2_view" "default" {
  provider = aws.usw2
  name     = "all-resources-p0"
  
  filters {
    filter_string = ""
  }

  depends_on = [aws_resourceexplorer2_index.aggregator]
}

# Set default view using AWS CLI
resource "null_resource" "set_default_view" {
  depends_on = [aws_resourceexplorer2_view.default]

  provisioner "local-exec" {
    command = "aws resource-explorer-2 associate-default-view --view-arn ${aws_resourceexplorer2_view.default.arn} --region us-west-2"
  }
}

# IAM role for Lambda
resource "aws_iam_role" "lambda_role" {
  name = "resource-explorer-lambda-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })
}

# Lambda role policy
resource "aws_iam_role_policy" "lambda_role_policy" {
  role = aws_iam_role.lambda_role.id
  name = "resource-explorer-policy"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "sts:AssumeRole",
          "organizations:ListAccounts",
          "account:ListRegions",
          "resource-explorer-2:*",
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "iam:CreateRole",
          "iam:PutRolePolicy",
          "iam:GetRole"
        ]
        Resource = "*"
      }
    ]
  })
}

# Create Lambda function
resource "aws_lambda_function" "setup_resource_explorer" {
  filename      = data.archive_file.lambda_zip.output_path
  function_name = "setup-resource-explorer"
  role         = aws_iam_role.lambda_role.arn
  handler      = "setup_resource_explorer.handler"
  runtime      = "nodejs18.x"
  timeout      = 300
  memory_size  = 256

  environment {
    variables = {
      MEMBER_ACCOUNTS    = jsonencode(var.member_accounts)
      GOOGLE_AUDIENCE_ID = var.google_audience_id
    }
  }
}

# Create a directory for the Lambda package
resource "local_file" "lambda_source" {
  filename = "lambda/setup_resource_explorer.js"
  content  = file("${path.module}/lambda/setup_resource_explorer.js")
}

# Copy the policy file to the Lambda package directory
resource "local_file" "policy_copy" {
  filename = "lambda/policies/resource_lister_policy.json"
  source   = "${path.module}/policies/resource_lister_policy.json"
}

# Create the Lambda package
data "archive_file" "lambda_zip" {
  type        = "zip"
  output_path = "setup_resource_explorer.zip"
  source_dir  = "lambda"
  
  depends_on = [
    local_file.lambda_source,
    local_file.policy_copy
  ]
}

# Trigger Lambda function
resource "null_resource" "trigger_lambda" {
  depends_on = [
    aws_lambda_function.setup_resource_explorer,
    null_resource.set_default_view
  ]

  provisioner "local-exec" {
    command = <<EOF
aws lambda invoke \
  --function-name ${aws_lambda_function.setup_resource_explorer.function_name} \
  --region us-east-1 \
  --payload '{"skipAggregator": false}' \
  --log-type Tail \
  --query 'LogResult' \
  --output text response.json | base64 -d
EOF
  }
}