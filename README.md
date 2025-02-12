# AWS Resource Explorer Setup

This Terraform project sets up AWS Resource Explorer with indexes across enabled regions in both root and member accounts of an AWS Organization. It also creates necessary IAM roles for managing resources and configures P0 Security integration.

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

4. P0 Security:
   - Valid P0 Security API token
   - Tenant/organization name in P0 Security

5. Required Permissions:
   - Ability to assume TerraformExecutionRole in root account
   - Ability to assume OrganizationAccountAccessRole in member accounts
   - Resource Explorer administrative permissions

## Environment Variables

The following environment variables must be set:

```bash
export P0_API_TOKEN="your-p0-security-api-token"
```

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
    ```hcl
    root_account_id     = "your-root-account-id"
    member_accounts     = ["member-account-1", "member-account-2"]  # Optional
    google_audience_id  = "your-google-audience-id"
    tenant             = "your-p0-tenant-name"  # e.g., "SE-test-org"
    ```

2. Set the required environment variable:
    ```bash
    export P0_API_TOKEN="your-p0-security-api-token"
    ```

3. In the root folder, run the following commands:
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
     - Aggregator index in us-west-2 (if no aggregator exists)
     - Default view configuration
     - Lambda function and its roles

2. In Each Child Account:
   - Created by Lambda (which assumes OrganizationAccountAccessRole):
     - P0RoleIamResourceLister role with same Google federation
     - Resource Explorer indexes in enabled regions
     - Aggregator index in us-west-2 (if no aggregator exists)
     - Default view configuration

3. P0 Security Integration:
   - Configures inventory setup for each account
   - Verifies and configures P0 Security integration
   - Sets up appropriate labels and states

## Workflow

1. Initial Setup:
   ```
   Your AWS Identity → TerraformExecutionRole
   ```
   - Terraform uses your provided TerraformExecutionRole to create resources in root account

2. Lambda Creation and Account Discovery:
   - Creates Lambda with required dependencies using Lambda layers
   - Discovers member accounts if not explicitly provided
   - Creates required roles and indexes in discovered accounts

3. Member Account Setup:
   ```
   Lambda → OrganizationAccountAccessRole → Create Resources
   ```
   - Lambda function iterates through member accounts
   - For each account:
     - Assumes the OrganizationAccountAccessRole
     - Creates P0RoleIamResourceLister with Google federation
     - Sets up Resource Explorer indexes and aggregator if needed
     - Configures default view

4. P0 Security Setup:
   ```
   Terraform → P0 API → Configure Integration
   ```
   - Configures P0 Security integration for each account
   - Sets up inventory
   - Verifies and configures integration

5. Final Trust Chain:
   ```
   Google Federation → P0RoleIamResourceLister (in any account)
   ```
   - End users can assume P0RoleIamResourceLister in any account through Google federation

## Monitoring and Troubleshooting

Monitor Lambda execution:
```bash
aws logs tail /aws/lambda/setup-resource-explorer --follow
```

The Lambda provides detailed logging of:
- Active regions discovered
- Indexes deployed
- Aggregator status and location
- Default view configuration
- Any errors encountered

## Important Notes

- The Lambda function can be rerun safely as it checks for existing resources
- Resource Explorer aggregator setup has a 24-hour cooldown period
- Member accounts can be explicitly provided or auto-discovered
- Each account's setup includes comprehensive logging of enabled regions and deployed resources
- The P0_API_TOKEN environment variable must be set before running Terraform
- The Lambda can be run with `skipAggregator: true` to test region setup without modifying aggregator settings