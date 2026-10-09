# Demo infrastructure using only Terraform's built-in provider (no downloads, no cloud account).
variable "release" {
  type    = string
  default = "v1"
}

resource "terraform_data" "app" {
  input = "app-${var.release}"
}

resource "terraform_data" "worker" {
  input            = "worker"
  triggers_replace = [var.release]
}
