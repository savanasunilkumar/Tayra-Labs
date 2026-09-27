output "api_url" {
  value = try(google_cloud_run_v2_service.api[0].uri, null)
}
output "worker_url" {
  value = try(google_cloud_run_v2_service.gpu[0].uri, null)
}
output "media_bucket" {
  value = google_storage_bucket.media.name
}
output "model_bucket" {
  value = google_storage_bucket.models.name
}
output "registry" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${var.resource_prefix}"
}
