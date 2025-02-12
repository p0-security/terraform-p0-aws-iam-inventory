# Create local file to track discovered accounts
resource "local_file" "account_tracker" {
  filename = "${path.module}/discovered_accounts.json"
  content  = jsonencode({
    accounts = []
  })
}

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
          "organizations:ListOrganizationalUnitsForParent",
          "organizations:ListRoots",
          "organizations:DescribeOrganization",
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

# Create directory for Lambda layer
resource "local_file" "layer_package_json" {
  filename = "lambda_layer/nodejs/package.json"
  content  = jsonencode({
    name = "aws-sdk-layer"
    version = "1.0.0"
    dependencies = {
      "@aws-sdk/client-organizations" = "^3.485.0"
      "@aws-sdk/client-sts" = "^3.485.0"
      "@aws-sdk/client-resource-explorer-2" = "^3.485.0"
      "@aws-sdk/client-account" = "^3.485.0"
      "@aws-sdk/client-iam" = "^3.485.0"
    }
  })
}

# Install npm dependencies
resource "null_resource" "install_layer_deps" {
  depends_on = [local_file.layer_package_json]

  triggers = {
    package_json = local_file.layer_package_json.content
  }

  provisioner "local-exec" {
    command = "cd lambda_layer/nodejs && npm install --production"
  }
}

# Create Lambda layer zip
data "archive_file" "lambda_layer" {
  depends_on = [null_resource.install_layer_deps]
  
  type        = "zip"
  output_path = "lambda_layer.zip"
  source_dir  = "lambda_layer"
}

# Create Lambda layer
resource "aws_lambda_layer_version" "aws_sdk" {
  filename            = data.archive_file.lambda_layer.output_path
  layer_name          = "aws-sdk-layer"
  compatible_runtimes = ["nodejs18.x"]
  source_code_hash    = data.archive_file.lambda_layer.output_base64sha256

  lifecycle {
    create_before_destroy = true
  }
}

# Create Lambda function with layer
resource "aws_lambda_function" "setup_resource_explorer" {
  filename         = data.archive_file.lambda_zip.output_path
  function_name    = "setup-resource-explorer"
  role            = aws_iam_role.lambda_role.arn
  handler         = "setup_resource_explorer.handler"
  runtime         = "nodejs18.x"
  timeout         = 300
  memory_size     = 256
  layers          = [aws_lambda_layer_version.aws_sdk.arn]
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256

  environment {
    variables = {
      MEMBER_ACCOUNTS    = jsonencode(var.member_accounts)
      GOOGLE_AUDIENCE_ID = var.google_audience_id
      ROOT_ACCOUNT_ID    = var.root_account_id
    }
  }
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
  source_dir  = "${path.module}/lambda"
  
  depends_on = [
    local_file.policy_copy
  ]
}

# Account discovery process
resource "null_resource" "discover_accounts" {
  count = length(var.member_accounts) == 0 ? 1 : 0
  
  depends_on = [
    aws_lambda_function.setup_resource_explorer,
    local_file.account_tracker
  ]

  triggers = {
    always_run = timestamp()
  }

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]
    command = <<-EOF
      # Invoke Lambda and store response
      aws lambda invoke \
        --function-name ${aws_lambda_function.setup_resource_explorer.function_name} \
        --region us-east-1 \
        --payload '{"action": "discover"}' \
        --cli-binary-format raw-in-base64-out \
        response.json || exit 1

      # Initialize accounts file with root account and discovered accounts
      echo '{"accounts":["${var.root_account_id}"]}' > ${local_file.account_tracker.filename}

      # Extract accounts from Lambda response and add them to the file
      accounts_json=$(cat response.json)
      discovered_accounts=$(echo $accounts_json | jq -r '.accounts[]' 2>/dev/null)
      echo "$discovered_accounts" | while read -r account; do
        if [ ! -z "$account" ]; then
          content=$(cat ${local_file.account_tracker.filename})
          echo "$content" | jq --arg acc "$account" '.accounts += [$acc]' > ${local_file.account_tracker.filename}
        fi
      done
    EOF
  }
}

# Read discovered accounts
data "local_file" "discovered_accounts" {
  depends_on = [null_resource.discover_accounts]
  filename   = local_file.account_tracker.filename
}

locals {
  account_data = length(var.member_accounts) > 0 ? {
    accounts = var.member_accounts
  } : jsondecode(data.local_file.discovered_accounts.content)
  
  final_member_accounts = [
    for account in local.account_data.accounts :
    account if account != var.root_account_id
  ]
}

# Process accounts with Resource Explorer
resource "null_resource" "trigger_lambda" {
  depends_on = [
    aws_lambda_function.setup_resource_explorer,
    null_resource.discover_accounts,
    null_resource.set_default_view
  ]

  triggers = {
    always_run = timestamp()
  }

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]
    command = <<EOF
      # Get the discovered accounts from file
      ACCOUNTS=$(cat ${local_file.account_tracker.filename} | jq -r '.accounts[]' | grep -v "${var.root_account_id}" | jq -R -s -c 'split("\n")[:-1]')
      
      # Setup for root account
      aws lambda invoke \
        --function-name ${aws_lambda_function.setup_resource_explorer.function_name} \
        --region us-east-1 \
        --payload "{\"accounts\": [\"${var.root_account_id}\"], \"skipAggregator\": false, \"skipDefaultView\": false}" \
        --cli-binary-format raw-in-base64-out \
        --log-type Tail \
        root_setup.json | jq -r '.LogResult' | base64 -d 

      # Then setup for member accounts
      aws lambda invoke \
        --function-name ${aws_lambda_function.setup_resource_explorer.function_name} \
        --region us-east-1 \
        --payload "{\"accounts\": $ACCOUNTS, \"skipAggregator\": false, \"skipDefaultView\": false}" \
        --cli-binary-format raw-in-base64-out \
        --log-type Tail \
        member_setup.json | jq -r '.LogResult' | base64 -d

      # Check for any errors in the responses
      if [ -f root_setup.json ]; then
        if jq -e '.FunctionError' root_setup.json > /dev/null; then
          echo "Error in root account setup"
          cat root_setup.json
          exit 1
        fi
      fi

      if [ -f member_setup.json ]; then
        if jq -e '.FunctionError' member_setup.json > /dev/null; then
          echo "Error in member accounts setup"
          cat member_setup.json
          exit 1
        fi
      fi
EOF
  }
}

# Check for required environment variables
data "external" "env_check" {
  program = ["bash", "-c", <<-EOF
    if [ -z "$P0_API_TOKEN" ]; then
      echo '{"error": "P0_API_TOKEN environment variable is not set"}'
      exit 1
    else
      echo '{"token_exists": "true"}'
    fi
  EOF
  ]
}

# Make API calls for each account
resource "null_resource" "api_calls" {
  depends_on = [null_resource.trigger_lambda, data.external.env_check]

  triggers = {
    always_run = timestamp()
  }

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-c"]
    command = <<EOF
      # Read and process each account
      cat ${local_file.account_tracker.filename} | jq -r '.accounts[]' | while read -r account; do
        echo "Processing API calls for account $account"
        
        # First PUT call for inventory setup
        echo "Making PUT call for account $account"
        PUT_RESPONSE=$(curl -s -w "\\n%%{http_code}" -X PUT \
          -H "Authorization: Bearer $P0_API_TOKEN" \
          -H "Content-Type: application/json" \
          https://api.p0.app/o/${var.tenant}/integrations/aws/config/inventory/$account)
        PUT_STATUS=$(echo "$PUT_RESPONSE" | tail -n 1)
        PUT_BODY=$(echo "$PUT_RESPONSE" | sed '$d')
        
        if [ "$PUT_STATUS" -ne 200 ]; then
          echo "PUT call failed with status $PUT_STATUS: $PUT_BODY"
          exit 1
        fi

        # First POST call for verify
        echo "Making verify POST call for account $account"
        POST1_RESPONSE=$(curl -s -w "\\n%%{http_code}" -X POST \
          -H "Authorization: Bearer $P0_API_TOKEN" \
          -H "Content-Type: application/json" \
          -d '{"state": "stage"}' \
          https://api.p0.app/o/${var.tenant}/integrations/aws/config/inventory/$account/verify)
        POST1_STATUS=$(echo "$POST1_RESPONSE" | tail -n 1)
        POST1_BODY=$(echo "$POST1_RESPONSE" | sed '$d')
        
        if [ "$POST1_STATUS" -ne 200 ]; then
          echo "Verify POST call failed with status $POST1_STATUS: $POST1_BODY"
          exit 1
        fi

        # Sleep for a moment to ensure verify is processed
        sleep 2

        # Second POST call for configure
        echo "Making configure POST call for account $account"
        POST2_RESPONSE=$(curl -s -w "\\n%%{http_code}" -X POST \
          -H "Authorization: Bearer $P0_API_TOKEN" \
          -H "Content-Type: application/json" \
          -d "{\"label\":\"$account\", \"state\":\"configure\"}" \
          https://api.p0.app/o/${var.tenant}/integrations/aws/config/inventory/$account/configure)
        POST2_STATUS=$(echo "$POST2_RESPONSE" | tail -n 1)
        POST2_BODY=$(echo "$POST2_RESPONSE" | sed '$d')
        
        if [ "$POST2_STATUS" -ne 200 ]; then
          echo "Configure POST call failed with status $POST2_STATUS: $POST2_BODY"
          exit 1
        fi

        echo "Successfully completed all API calls for account $account"
      done
EOF
  }
}
