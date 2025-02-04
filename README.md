# AWS Resource Explorer Setup

This Terraform project sets up AWS Resource Explorer with indexes across enabled regions in both root and member accounts of an AWS Organization. It also creates necessary IAM roles for managing resources.

## Prerequisites

1. **TerraformExecutionRole**
    If you need to create this role:
    1. Modify the file iam/terraform-execution-role.json and add your AWS Principal (Role) that will be used to assume the terraform role.
    2. Execute the following steps in the root folder:

        ```bash
        aws iam create-role \
            --role-name TerraformExecutionRole \
            --assume-role-policy-document file://iam/terraform-execution-role.json

        aws iam put-role-policy \
            --role-name TerraformExecutionRole \
            --policy-name TerraformExecutionPolicy \
            --policy-document file://iam/terraform-execution-role-policy.json
        ```

2. AWS Organization with:
   - Root (management) account
   - One or more member accounts
   - OrganizationAccountAccessRole available in member accounts

3. AWS Identity Center (formerly SSO) configured

4. Required Permissions:
   - Ability to assume TerraformExecutionRole in root account
   - Ability to assume OrganizationAccountAccessRole in member accounts
   - Resource Explorer administrative permissions

## IAM Roles Overview

### Prerequisites Roles
1. **TerraformExecutionRole** (in root account)
   - Used by: Terraform
   - Purpose: Creates initial resources and Lambda function
   - Key Permissions:
     - IAM role and policy management
     - Lambda function management
     - Resource Explorer management
     - Organizations API access

2. **OrganizationAccountAccessRole** (in member accounts)
   - Used by: Lambda function
   - Purpose: Allows cross-account access from management account
   - Must exist before running this project

### Created Roles

1. **P0RoleIamResourceLister** (created in all accounts)
   - Created in: Root and all member accounts
   - Purpose: Allows listing and viewing resources via Resource Explorer
   - Trust Relationship: Google Workspace federation
   - Inline Policy: P0RoleIamResourceListerPolicy

2. **resource-explorer-lambda-role** (in root account only)
   - Created in: Root account
   - Purpose: Execution role for Lambda function
   - Used by: setup-resource-explorer Lambda function
   - Key Permissions:
     - AssumeRole for cross-account access
     - Resource Explorer management
     - CloudWatch Logs
     - IAM role management

## Steps

1. Edit the file terraform.tfvars in the root folder as follows:
    1. Add your root account as a string value
    2. Add your children/member accounts in an array of comma separated strings
    3. Add the P0 Security Google Audience ID

2. In the root folder, run the following commands:
    ```bash
    terraform init
    terraform plan
    terraform apply
    ```

## Project Structure

```
project_root/
├── main.tf                           # Main Terraform config
├── variables.tf                      # Variable definitions
├── provider.tf                       # AWS provider configuration
├── terraform.tfvars                  # Your variable values
├── iam/
│   ├── terraform-execution-role.json       # Trust policy for TerraformExecutionRole
│   └── terraform-execution-role-policy.json # Permission policy for TerraformExecutionRole
├── policies/
│   └── resource_lister_policy.json   # Policy template
└── lambda/
    └── setup_resource_explorer.js    # Lambda function code
```

## Tasks Performed

1. In the Root/Management Account:
   - Created by TerraformExecutionRole:
     - P0RoleIamResourceLister role with Google federation
     - Resource Explorer indexes in enabled regions
     - Aggregator index in us-west-2
     - Default view configuration
     - Lambda function and its roles

2. In Each Child Account:
   - Created by Lambda (which assumes OrganizationAccountAccessRole):
     - P0RoleIamResourceLister role with same Google federation
     - Resource Explorer indexes in enabled regions
     - Aggregator index in us-west-2
     - Default view configuration

## Workflow

1. Initial Setup:
   ```
   Your AWS Identity → TerraformExecutionRole
   ```
   - Terraform uses your provided TerraformExecutionRole to create resources in root account

2. Lambda Creation:
   - Terraform creates a zip package containing:
     - Lambda function code (setup_resource_explorer.js)
     - Policy template (resource_lister_policy.json)
   - Package is uploaded to AWS Lambda

3. Member Account Setup:
   ```
   Lambda → OrganizationAccountAccessRole → Create Resources
   ```
   - Lambda function iterates through member accounts
   - For each account:
     - Assumes the OrganizationAccountAccessRole
     - Creates P0RoleIamResourceLister with Google federation
     - Sets up Resource Explorer indexes and aggregator
     - Configures default view

4. Final Trust Chain:
   ```
   Google Federation → P0RoleIamResourceLister (in any account)
   ```
   - End users can assume P0RoleIamResourceLister in any account through Google federation

## Monitoring and Troubleshooting

Monitor Lambda execution:
```bash
aws logs tail /aws/lambda/setup-resource-explorer --follow
```

## Important Notes

- The Lambda function can be rerun safely as it checks for existing resources
- Resource Explorer aggregator setup has a 24-hour cooldown period
- The Lambda can be run with `skipAggregator: true` to test region setup without modifying aggregator settings