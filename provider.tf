terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "us-east-1"  # Default region
  
  assume_role {
    role_arn = "arn:aws:iam::${var.root_account_id}:role/TerraformExecutionRole"
  }
}

# provider for us-west-2 (needed for aggregator)
provider "aws" {
  alias  = "usw2"
  region = "us-west-2"
  
  assume_role {
    role_arn = "arn:aws:iam::${var.root_account_id}:role/TerraformExecutionRole"
  }
}