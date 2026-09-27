variable "project_id" {
  type        = string
  description = "Dedicated Google project attached to the startup-credit billing account. No default on purpose."
}

variable "product_name" {
  type    = string
  default = "Video API"
}

variable "resource_prefix" {
  type    = string
  default = "video-api"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,18}[a-z0-9]$", var.resource_prefix))
    error_message = "Use 4–20 lowercase letters, numbers, and hyphens; start with a letter and end with a letter or number."
  }
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "allowed_origin" {
  type    = string
  default = "http://localhost:3000"
}

variable "api_image" {
  type        = string
  default     = ""
  description = "Immutable Artifact Registry CPU image reference, including @sha256 digest."
}

variable "worker_image" {
  type        = string
  default     = ""
  description = "Immutable Artifact Registry GPU image reference, including @sha256 digest."
}

variable "create_staging_job" {
  type        = bool
  default     = false
  description = "Enable after the CPU image is built; the job is executed manually once to stage model files."
}

variable "deploy_services" {
  type        = bool
  default     = false
  description = "Enable only after images, API_KEY secret version, and model snapshot exist."
}

variable "gpu_paused" {
  type        = bool
  default     = false
  description = "Disable new GPU requests with manual zero scaling after a budgeted test; preserves the service and model cache."
}

variable "deploy_api_only" {
  type        = bool
  default     = false
  description = "Deploy the CPU API with analysis disabled while model staging/GPU deployment is pending."
}

variable "enable_hf_auth" {
  type        = bool
  default     = false
  description = "Enable after a read-only Hugging Face token version is stored in the staging secret."
}

variable "public_api_enabled" {
  type        = bool
  default     = false
  description = "Allow public Cloud Run invocation only after organization-policy approval; application API-key checks remain required."
}
