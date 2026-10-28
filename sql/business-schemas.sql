CREATE TABLE IF NOT EXISTS business_schemas (
 entity VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
 version BIGINT UNSIGNED NOT NULL,
 schema_hash CHAR(64) NOT NULL,
 descriptor JSON NOT NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 PRIMARY KEY(entity,version), UNIQUE KEY schema_identity(entity,schema_hash)
) ENGINE=InnoDB;
