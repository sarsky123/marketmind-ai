variable "aws_region" {
  description = "AWS region where resources are provisioned."
  type        = string
  default     = "ap-northeast-1"
}

variable "instance_type" {
  description = "EC2 instance type for the application server."
  type        = string
  default     = "t3.micro"
}

variable "public_key_content" {
  description = "SSH public key content used for the EC2 key pair."
  type        = string
}

variable "ssh_allowed_cidrs" {
  description = "CIDR blocks allowed to SSH into the EC2 instance."
  type        = list(string)
}

variable "domain_name" {
  description = "Route 53 hosted zone apex domain."
  type        = string
  default     = "chungyulo.xyz"
}

variable "subdomain" {
  description = "Subdomain to point to the EC2 instance."
  type        = string
  default     = "marketmind-ai"
}
