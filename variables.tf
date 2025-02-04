variable "root_account_id" {
  description = "AWS Organizations root account ID"
  type        = string
}

variable "member_accounts" {
  description = "List of member account IDs where the role should be created"
  type        = list(string)
}

variable "google_audience_id" {
  description = "Google Workspace audience ID for federation"
  type        = string
}