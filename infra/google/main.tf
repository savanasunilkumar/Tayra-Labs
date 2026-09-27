locals {
  model_revision = "e28fa28597e5ec5e0cca2201dd8ab33d48bc4a1b"
  apis = toset([
    "run.googleapis.com", "cloudtasks.googleapis.com", "firestore.googleapis.com",
    "storage.googleapis.com", "artifactregistry.googleapis.com", "secretmanager.googleapis.com",
    "iamcredentials.googleapis.com", "cloudbuild.googleapis.com", "cloudscheduler.googleapis.com",
    "logging.googleapis.com", "iam.googleapis.com",
  ])
  shared_environment = {
    PRODUCT_NAME         = var.product_name
    GOOGLE_CLOUD_PROJECT = var.project_id
    GOOGLE_CLOUD_REGION  = var.region
    FIRESTORE_DATABASE   = google_firestore_database.main.name
    MEDIA_BUCKET         = google_storage_bucket.media.name
    TASK_QUEUE           = google_cloud_tasks_queue.analysis.name
    TASK_SERVICE_ACCOUNT = google_service_account.identity["tasks"].email
    ALLOWED_ORIGIN       = var.allowed_origin
  }
}

resource "google_project_service" "enabled" {
  for_each           = local.apis
  service            = each.value
  disable_on_destroy = false
}

resource "google_service_account" "identity" {
  for_each     = toset(["api", "gpu", "tasks", "scheduler", "build", "stage"])
  account_id   = "${var.resource_prefix}-${each.key}"
  display_name = "${var.product_name} ${each.key}"
  depends_on   = [google_project_service.enabled]
}

resource "google_firestore_database" "main" {
  name                    = var.resource_prefix
  location_id             = var.region
  type                    = "FIRESTORE_NATIVE"
  delete_protection_state = "DELETE_PROTECTION_ENABLED"
  deletion_policy         = "ABANDON"
  depends_on              = [google_project_service.enabled]
}

resource "google_project_iam_member" "database" {
  for_each = toset(["api", "gpu"])
  project  = var.project_id
  role     = "roles/datastore.user"
  member   = "serviceAccount:${google_service_account.identity[each.key].email}"
}

resource "google_storage_bucket" "media" {
  name                        = "${var.project_id}-${var.resource_prefix}-media"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  soft_delete_policy { retention_duration_seconds = 0 }
  cors {
    origin          = [var.allowed_origin]
    method          = ["PUT", "GET", "HEAD"]
    response_header = ["Content-Type", "x-goog-if-generation-match"]
    max_age_seconds = 3600
  }
  lifecycle_rule {
    action { type = "Delete" }
    condition {
      age            = 2
      matches_prefix = ["source/"]
    }
  }
  lifecycle_rule {
    action { type = "Delete" }
    condition {
      age            = 31
      matches_prefix = ["result/"]
    }
  }
  depends_on = [google_project_service.enabled]
}

resource "google_storage_bucket" "models" {
  name                        = "${var.project_id}-${var.resource_prefix}-models"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  depends_on                  = [google_project_service.enabled]
}

resource "google_storage_bucket" "builds" {
  name                        = "${var.project_id}-${var.resource_prefix}-builds"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  lifecycle_rule {
    action { type = "Delete" }
    condition { age = 7 }
  }
  depends_on = [google_project_service.enabled]
}

resource "google_storage_bucket_iam_member" "media" {
  for_each = toset(["api", "gpu"])
  bucket   = google_storage_bucket.media.name
  role     = "roles/storage.objectUser"
  member   = "serviceAccount:${google_service_account.identity[each.key].email}"
}

resource "google_storage_bucket_iam_member" "model_read" {
  bucket = google_storage_bucket.models.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.identity["gpu"].email}"
}

resource "google_storage_bucket_iam_member" "model_stage" {
  bucket = google_storage_bucket.models.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.identity["stage"].email}"
}

resource "google_storage_bucket_iam_member" "build_source" {
  bucket = google_storage_bucket.builds.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.identity["build"].email}"
}

resource "google_service_account_iam_member" "sign_uploads" {
  service_account_id = google_service_account.identity["api"].name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.identity["api"].email}"
}

resource "google_secret_manager_secret" "api_key" {
  secret_id = "${var.resource_prefix}-api-key"
  replication {
    auto {}
  }
  depends_on = [google_project_service.enabled]
}

resource "google_secret_manager_secret_iam_member" "api_key" {
  secret_id = google_secret_manager_secret.api_key.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.identity["api"].email}"
}

resource "google_secret_manager_secret" "hf_token" {
  secret_id = "${var.resource_prefix}-hf-token"
  replication {
    auto {}
  }
  depends_on = [google_project_service.enabled]
}

resource "google_secret_manager_secret_iam_member" "hf_token" {
  secret_id = google_secret_manager_secret.hf_token.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.identity["stage"].email}"
}

resource "google_artifact_registry_repository" "containers" {
  location      = var.region
  repository_id = var.resource_prefix
  format        = "DOCKER"
  depends_on    = [google_project_service.enabled]
}

resource "google_artifact_registry_repository_iam_member" "builder" {
  location   = var.region
  repository = google_artifact_registry_repository.containers.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.identity["build"].email}"
}

resource "google_project_iam_member" "build_logs" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.identity["build"].email}"
}

resource "google_cloud_tasks_queue" "analysis" {
  name     = "${var.resource_prefix}-analysis"
  location = var.region
  rate_limits {
    max_concurrent_dispatches = 1
    max_dispatches_per_second = 1
  }
  retry_config {
    max_attempts       = 20
    max_retry_duration = "7200s"
    min_backoff        = "30s"
    max_backoff        = "300s"
    max_doublings      = 4
  }
  depends_on = [google_project_service.enabled]
}

resource "google_cloud_tasks_queue_iam_member" "api" {
  for_each = toset(["roles/cloudtasks.enqueuer", "roles/cloudtasks.taskDeleter"])
  name     = google_cloud_tasks_queue.analysis.name
  location = var.region
  role     = each.value
  member   = "serviceAccount:${google_service_account.identity["api"].email}"
}

resource "google_service_account_iam_member" "enqueue_identity" {
  service_account_id = google_service_account.identity["tasks"].name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.identity["api"].email}"
}

resource "google_cloud_run_v2_service" "gpu" {
  count               = var.deploy_services ? 1 : 0
  name                = "${var.resource_prefix}-gpu"
  location            = var.region
  deletion_protection = true
  ingress             = "INGRESS_TRAFFIC_ALL"
  scaling {
    scaling_mode          = var.gpu_paused ? "MANUAL" : "AUTOMATIC"
    manual_instance_count = var.gpu_paused ? 0 : null
    max_instance_count    = var.gpu_paused ? null : 1
  }
  template {
    service_account                  = google_service_account.identity["gpu"].email
    timeout                          = "1800s"
    max_instance_request_concurrency = 1
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    gpu_zonal_redundancy_disabled    = true
    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }
    node_selector { accelerator = "nvidia-rtx-pro-6000" }
    containers {
      image = var.worker_image
      resources {
        limits   = { cpu = "20", memory = "80Gi", "nvidia.com/gpu" = "1" }
        cpu_idle = false
      }
      startup_probe {
        failure_threshold = 1800
        period_seconds    = 1
        timeout_seconds   = 1
        tcp_socket { port = 8080 }
      }
      dynamic "env" {
        for_each = merge(local.shared_environment, {
          MODEL_PATH = "/models/molmo2-8b/${local.model_revision}"
        })
        content {
          name  = env.key
          value = env.value
        }
      }
      volume_mounts {
        name       = "models"
        mount_path = "/models"
      }
    }
    volumes {
      name = "models"
      gcs {
        bucket    = google_storage_bucket.models.name
        read_only = true
      }
    }
  }
  lifecycle {
    precondition {
      condition     = can(regex("@sha256:[a-f0-9]{64}$", var.worker_image))
      error_message = "worker_image must reference an immutable digest."
    }
  }
  depends_on = [google_project_iam_member.database, google_storage_bucket_iam_member.media, google_storage_bucket_iam_member.model_read]
}

resource "google_cloud_run_v2_service_iam_member" "task_invoker" {
  count    = var.deploy_services ? 1 : 0
  name     = google_cloud_run_v2_service.gpu[0].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.identity["tasks"].email}"
}

resource "google_cloud_run_v2_service" "api" {
  count               = var.deploy_services || var.deploy_api_only ? 1 : 0
  name                = "${var.resource_prefix}-api"
  location            = var.region
  deletion_protection = true
  ingress             = "INGRESS_TRAFFIC_ALL"
  custom_audiences    = ["https://${var.resource_prefix}.internal/maintenance"]
  template {
    service_account                  = google_service_account.identity["api"].email
    timeout                          = "300s"
    max_instance_request_concurrency = 20
    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }
    containers {
      image = var.api_image
      resources {
        limits   = { cpu = "1", memory = "512Mi" }
        cpu_idle = true
      }
      dynamic "env" {
        for_each = merge(local.shared_environment, {
          WORKER_URL                  = var.deploy_services ? google_cloud_run_v2_service.gpu[0].uri : ""
          ANALYSIS_ENABLED            = tostring(var.deploy_services && !var.gpu_paused)
          SIGNER_SERVICE_ACCOUNT      = google_service_account.identity["api"].email
          MAINTENANCE_SERVICE_ACCOUNT = google_service_account.identity["scheduler"].email
          MAINTENANCE_AUDIENCE        = "https://${var.resource_prefix}.internal/maintenance"
        })
        content {
          name  = env.key
          value = env.value
        }
      }
      env {
        name = "API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.api_key.secret_id
            version = "latest"
          }
        }
      }
    }
  }
  lifecycle {
    precondition {
      condition     = can(regex("@sha256:[a-f0-9]{64}$", var.api_image))
      error_message = "api_image must reference an immutable digest."
    }
  }
  depends_on = [google_secret_manager_secret_iam_member.api_key, google_service_account_iam_member.sign_uploads,
    google_project_iam_member.database, google_storage_bucket_iam_member.media,
  google_cloud_tasks_queue_iam_member.api, google_service_account_iam_member.enqueue_identity]
}

resource "google_cloud_run_v2_service_iam_member" "public_api" {
  count    = (var.deploy_services || var.deploy_api_only) && var.public_api_enabled ? 1 : 0
  name     = google_cloud_run_v2_service.api[0].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers" # Application bearer-key authentication protects every customer endpoint.
}

resource "google_cloud_run_v2_service_iam_member" "scheduler_invoker" {
  count    = var.deploy_services || var.deploy_api_only ? 1 : 0
  name     = google_cloud_run_v2_service.api[0].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.identity["scheduler"].email}"
}

resource "google_cloud_scheduler_job" "maintenance" {
  count            = var.deploy_services || var.deploy_api_only ? 1 : 0
  name             = "${var.resource_prefix}-maintenance"
  region           = var.region
  schedule         = "*/5 * * * *"
  attempt_deadline = "300s"
  http_target {
    uri         = "${google_cloud_run_v2_service.api[0].uri}/internal/maintenance"
    http_method = "POST"
    oidc_token {
      service_account_email = google_service_account.identity["scheduler"].email
      audience              = "https://${var.resource_prefix}.internal/maintenance"
    }
  }
  depends_on = [google_project_service.enabled, google_cloud_run_v2_service_iam_member.scheduler_invoker]
}

resource "google_cloud_run_v2_job" "stage_model" {
  count               = var.create_staging_job ? 1 : 0
  name                = "${var.resource_prefix}-stage-model"
  location            = var.region
  deletion_protection = false
  template {
    template {
      service_account = google_service_account.identity["stage"].email
      timeout         = "7200s"
      max_retries     = 0
      containers {
        image   = var.api_image
        command = ["python", "-m", "services.cloud.stage_model"]
        args    = ["--project", var.project_id, "--bucket", google_storage_bucket.models.name]
        resources { limits = { cpu = "4", memory = "2Gi" } }
        dynamic "env" {
          for_each = var.enable_hf_auth ? [true] : []
          content {
            name = "HF_TOKEN"
            value_source {
              secret_key_ref {
                secret  = google_secret_manager_secret.hf_token.secret_id
                version = "latest"
              }
            }
          }
        }
      }
    }
  }
  lifecycle {
    precondition {
      condition     = can(regex("@sha256:[a-f0-9]{64}$", var.api_image))
      error_message = "api_image must reference an immutable digest before enabling model staging."
    }
  }
  depends_on = [google_storage_bucket_iam_member.model_stage, google_secret_manager_secret_iam_member.hf_token]
}
