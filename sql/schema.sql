CREATE TABLE IF NOT EXISTS settings (
 id TINYINT PRIMARY KEY, encrypted MEDIUMTEXT NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS entities (
 name VARCHAR(64) COLLATE utf8mb4_bin PRIMARY KEY,
 tab_name VARCHAR(100) NOT NULL UNIQUE,
 headers JSON NOT NULL,
 retention_days INT NOT NULL DEFAULT 0,
 bootstrap_state VARCHAR(20) NOT NULL DEFAULT 'new',
 next_row INT NOT NULL DEFAULT 2,
 import_row INT NOT NULL DEFAULT 2,
 last_sync_at DATETIME(3) NULL,
 last_error VARCHAR(100) NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS records (
 entity VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
 id VARCHAR(191) COLLATE utf8mb4_bin NOT NULL,
 data JSON NOT NULL,
 version BIGINT UNSIGNED NOT NULL,
 synced_version BIGINT UNSIGNED NOT NULL DEFAULT 0,
 dirty TINYINT NOT NULL DEFAULT 1,
 business_at DATETIME(3) NOT NULL,
 finalized_at DATETIME(3) NULL,
 updated_at DATETIME(3) NOT NULL,
 deleted_at DATETIME(3) NULL,
 PRIMARY KEY(entity,id),
 INDEX sync_pending(entity,dirty,updated_at),
 INDEX retention(entity,finalized_at),
 INDEX recent(entity,business_at,id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS row_map (
 entity VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
 id VARCHAR(191) COLLATE utf8mb4_bin NOT NULL,
 sheet_row INT NOT NULL,
 archived_at DATETIME(3) NULL,
 business_at DATETIME(3) NULL,
 deleted_at DATETIME(3) NULL,
 PRIMARY KEY(entity,id), UNIQUE KEY sheet_position(entity,sheet_row)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS requests (
 id VARCHAR(128) COLLATE utf8mb4_bin PRIMARY KEY,
 fingerprint CHAR(64) NOT NULL,
 response JSON NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS record_guards (
 name CHAR(64) PRIMARY KEY,
 request_id VARCHAR(128) NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS jobs (
 id CHAR(36) PRIMARY KEY,
 kind VARCHAR(20) NOT NULL,
 entity VARCHAR(64) NULL,
 state VARCHAR(20) NOT NULL DEFAULT 'pending',
 attempts INT NOT NULL DEFAULT 0,
 available_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 finished_at DATETIME(3) NULL,
 error_code VARCHAR(100) NULL,
 INDEX due(state,available_at)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS sync_runs (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 entity VARCHAR(64) NOT NULL,
 kind VARCHAR(20) NOT NULL,
 state VARCHAR(20) NOT NULL DEFAULT 'running',
 rows_count INT NOT NULL DEFAULT 0,
 started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 finished_at DATETIME(3) NULL,
 error_code VARCHAR(100) NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS runtime_state (
 id TINYINT PRIMARY KEY,
 heartbeat_at DATETIME(3) NULL,
 next_sync_at DATETIME(3) NULL,
 next_google_at DATETIME(3) NULL,
 failures INT NOT NULL DEFAULT 0,
 worker_error VARCHAR(100) NULL
) ENGINE=InnoDB;
INSERT IGNORE INTO runtime_state(id) VALUES(1);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash CHAR(64) PRIMARY KEY, expires_at DATETIME(3) NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS login_limits (
 ip_hash CHAR(64) PRIMARY KEY, hits INT NOT NULL, expires_at DATETIME(3) NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS image_metadata (
 namespace VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
 image_id VARCHAR(128) COLLATE utf8mb4_bin NOT NULL,
 version BIGINT UNSIGNED NOT NULL DEFAULT 0,
 fingerprint CHAR(64) NOT NULL DEFAULT '',
 state VARCHAR(16) NULL,
 drive_file_id VARCHAR(200) NULL,
 mime VARCHAR(40) NULL,
 size_bytes BIGINT UNSIGNED NULL,
 checksum CHAR(64) NULL,
 verified_at DATETIME(3) NULL,
 updated_at DATETIME(3) NULL,
 PRIMARY KEY(namespace,image_id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS image_links (
 namespace VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
 entity VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
 record_id VARCHAR(191) COLLATE utf8mb4_bin NOT NULL,
 field_name VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
 slot SMALLINT UNSIGNED NOT NULL,
 version BIGINT UNSIGNED NOT NULL DEFAULT 0,
 fingerprint CHAR(64) NOT NULL DEFAULT '',
 image_id VARCHAR(128) COLLATE utf8mb4_bin NULL,
 updated_at DATETIME(3) NULL,
 PRIMARY KEY(namespace,entity,record_id,field_name,slot),
 INDEX by_image(namespace,image_id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS client_request_logs (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 client VARCHAR(64) NOT NULL,
 fingerprint CHAR(16) NOT NULL,
 method VARCHAR(10) NOT NULL,
 path VARCHAR(200) NOT NULL,
 status INT NOT NULL,
 duration_ms INT NOT NULL,
 records_count INT NOT NULL DEFAULT 0,
 error_code VARCHAR(64) NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 INDEX idx_client_time (client, created_at),
 INDEX idx_status_time (status, created_at)
) ENGINE=InnoDB;


CREATE TABLE IF NOT EXISTS business_schemas (
 entity VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
 version BIGINT UNSIGNED NOT NULL,
 schema_hash CHAR(64) NOT NULL,
 descriptor JSON NOT NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 PRIMARY KEY(entity,version), UNIQUE KEY schema_identity(entity,schema_hash)
) ENGINE=InnoDB;
