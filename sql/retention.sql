-- Stores the auto-cleanup policy (one row per entity or null for all)
CREATE TABLE IF NOT EXISTS retention_policies (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  entity VARCHAR(64) COLLATE utf8mb4_bin NULL COMMENT 'NULL = all eligible entities',
  retention_days INT UNSIGNED NOT NULL,
  schedule_hhmm CHAR(5) NOT NULL COMMENT 'HH:MM Vietnam time',
  enabled TINYINT NOT NULL DEFAULT 0,
  last_run_at DATETIME(3) NULL,
  next_run_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY one_per_entity (entity)
) ENGINE=InnoDB;

-- Preview snapshots for manual deletion (expire after 10 min)
CREATE TABLE IF NOT EXISTS retention_previews (
  id CHAR(36) PRIMARY KEY,
  entity VARCHAR(64) COLLATE utf8mb4_bin NULL,
  entities JSON NULL,
  date_from DATE NULL,
  date_to DATE NULL,
  eligible_count INT UNSIGNED NOT NULL DEFAULT 0,
  skipped_count INT UNSIGNED NOT NULL DEFAULT 0,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

-- Durable cleanup jobs (manual bulk deletion)
CREATE TABLE IF NOT EXISTS retention_jobs (
  id CHAR(36) PRIMARY KEY,
  preview_id CHAR(36) NOT NULL,
  entity VARCHAR(64) COLLATE utf8mb4_bin NULL,
  entities JSON NULL,
  date_from DATE NULL,
  date_to DATE NULL,
  state VARCHAR(20) NOT NULL DEFAULT 'pending',
  deleted_count INT UNSIGNED NOT NULL DEFAULT 0,
  skipped_count INT UNSIGNED NOT NULL DEFAULT 0,
  total_count INT UNSIGNED NOT NULL DEFAULT 0,
  batch_cursor VARCHAR(191) COLLATE utf8mb4_bin NULL COMMENT 'Last processed record ID for resume',
  error_code VARCHAR(100) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at DATETIME(3) NULL,
  INDEX by_state (state, created_at)
) ENGINE=InnoDB;

-- Audit log for all retention actions
CREATE TABLE IF NOT EXISTS retention_audit (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  job_id CHAR(36) NULL COMMENT 'NULL for auto policy runs',
  policy_id INT UNSIGNED NULL,
  entity VARCHAR(255) COLLATE utf8mb4_bin NOT NULL,
  record_count INT UNSIGNED NOT NULL DEFAULT 0,
  action VARCHAR(20) NOT NULL COMMENT 'auto_cleanup | manual_cleanup | policy_save',
  triggered_by VARCHAR(50) NOT NULL DEFAULT 'admin',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX by_entity_time (entity, created_at)
) ENGINE=InnoDB;
