CREATE TABLE `FileShare` (
  `id` VARCHAR(191) NOT NULL, `accountId` VARCHAR(191) NOT NULL, `assetId` VARCHAR(191) NOT NULL,
  `tokenHash` CHAR(64) NOT NULL, `keyEnvelope` BLOB NOT NULL, `ttlHours` INTEGER NOT NULL,
  `expiresAt` DATETIME(3) NOT NULL, `revokedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `FileShare_accountId_assetId_createdAt_idx` (`accountId`, `assetId`, `createdAt`),
  INDEX `FileShare_accountId_expiresAt_idx` (`accountId`, `expiresAt`),
  CONSTRAINT `FileShare_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `FileShare_assetId_fkey` FOREIGN KEY (`assetId`) REFERENCES `FileAsset` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
