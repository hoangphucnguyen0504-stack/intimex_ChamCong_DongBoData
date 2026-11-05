# Multiple Google destinations

Approved scope: ordered Google Sheets rollover (partition data, not mirror it), and encrypted Drive OAuth credential management for ChamCong and HDoi. The user explicitly authorized implementation after the design conversation.

The original spreadsheetId remains the stable integration source ID. New physical destinations are ordered fallbacks. Persist physical file/tab/row separately from the existing logical row order. A confirmed file capacity error may reroute never-written rows; successful rows and ambiguous deliveries retain their identity. One sync job visits dirty groups in all physical files and reports failures individually. Network, project quota and authorization failures never trigger rollover.

Drive administration manages ordered credentials with a label, client ID/secret, refresh token and folder. Secrets are encrypted in MySQL; admin reads are masked. POST /v1/drive-credentials/acquire issues one configuration to chamcong or hdoi and records issuance. Consumers keep encrypted durable state, coalesce concurrent acquisitions, and request another configuration only after a confirmed user quota failure with backoff. Project quota, generic429, network and permissions do not cause rotation. Persist credential ownership with created files and preserve credentials needed for old-file reads. Dashboard displays the last issued configuration, not a fabricated continuous health check. No polling for secret configurations.

Existing credentials remain valid starting configuration; no production secrets are read or rewritten. Registry entries may belong to different accounts and OAuth clients. Files must be accessible to the credential used for them. Normal OAuth access-token refresh is independent of registry acquisition.

Alternatives: mirroring complete datasets was rejected by the user in favor of partition/rollover. Fetching secrets on each operation was rejected in favor of durable acquisition. No deployments or production database migrations are performed in this task.
