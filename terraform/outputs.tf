output "instance_public_ip" {
  description = "Public IP address of the EC2 instance."
  value       = aws_instance.app_server.public_ip
}

output "app_url" {
  description = "Application URL served through Route 53."
  value       = "https://${var.subdomain}.${var.domain_name}"
}
