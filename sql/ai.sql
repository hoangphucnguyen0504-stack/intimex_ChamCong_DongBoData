CREATE TABLE IF NOT EXISTS ai_drive_cleanup (
 id CHAR(64) PRIMARY KEY,
 encrypted_details MEDIUMTEXT NOT NULL,
 attempts INT NOT NULL DEFAULT 0,
 blocked BOOLEAN NOT NULL DEFAULT FALSE,
 available_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 INDEX ai_drive_cleanup_due(blocked,available_at)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS ai_documents (
 id CHAR(64) PRIMARY KEY,
 scope VARCHAR(200) NOT NULL,
 file_hash CHAR(64) NOT NULL,
 format VARCHAR(8) NOT NULL,
 encrypted_original LONGTEXT NOT NULL,
 encrypted_pdf LONGTEXT NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 INDEX ai_document_date(created_at)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS ai_configuration (
 id TINYINT PRIMARY KEY,
 revision BIGINT NOT NULL DEFAULT 0,
 encrypted MEDIUMTEXT NOT NULL,
 updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS ai_jobs (
 id CHAR(64) PRIMARY KEY,
 scope VARCHAR(200) NOT NULL,
 fingerprint CHAR(64) NOT NULL,
 payload_hash CHAR(64) NOT NULL,
 encrypted_payload MEDIUMTEXT NULL,
 encrypted_result MEDIUMTEXT NULL,
 state VARCHAR(24) NOT NULL DEFAULT 'queued',
 error_code VARCHAR(80) NULL,
 provider_id VARCHAR(100) NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 started_at DATETIME(3) NULL,
 finished_at DATETIME(3) NULL,
 INDEX ai_job_queue(state,created_at),
 INDEX ai_job_scope(scope,created_at)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS ai_calls (
 id CHAR(36) PRIMARY KEY,
 job_id CHAR(64) NOT NULL,
 provider_id VARCHAR(100) NOT NULL,
 state VARCHAR(24) NOT NULL,
 input_tokens INT NOT NULL DEFAULT 0,
 output_tokens INT NOT NULL DEFAULT 0,
 estimated_usd DECIMAL(16,8) NOT NULL DEFAULT 0,
 pricing_known BOOLEAN NOT NULL DEFAULT FALSE,
 error_code VARCHAR(80) NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 INDEX ai_call_day(created_at,provider_id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS ai_config_audit (
 id BIGINT AUTO_INCREMENT PRIMARY KEY,
 revision BIGINT NOT NULL,
 actor VARCHAR(100) NOT NULL,
 summary JSON NOT NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS ai_provider_health (
 provider_id VARCHAR(100) PRIMARY KEY,
 cooldown_until DATETIME(3) NOT NULL,
 error_code VARCHAR(80) NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS ai_diagnostics (
 id CHAR(36) PRIMARY KEY,
 scope VARCHAR(200) NOT NULL,
 stage VARCHAR(24) NOT NULL,
 error_code VARCHAR(80) NOT NULL,
 encrypted_details MEDIUMTEXT NOT NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 INDEX ai_diagnostic_date(created_at)
) ENGINE=InnoDB;
