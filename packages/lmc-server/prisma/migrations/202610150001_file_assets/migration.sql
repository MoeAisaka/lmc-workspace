CREATE TABLE `FileAsset` (
  `id` VARCHAR(191) NOT NULL, `accountId` VARCHAR(191) NOT NULL,
  `size` BIGINT NOT NULL, `partCount` INTEGER NOT NULL,
  `keyMode` VARCHAR(191) NOT NULL, `ownerKey` BLOB NOT NULL,
  `manifest` MEDIUMBLOB NULL, `state` VARCHAR(191) NOT NULL DEFAULT 'uploading',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`), INDEX `FileAsset_accountId_state_createdAt_idx` (`accountId`, `state`, `createdAt`),
  CONSTRAINT `FileAsset_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE TABLE `FileAssetPart` (
  `assetId` VARCHAR(191) NOT NULL, `index` INTEGER NOT NULL, `size` INTEGER NOT NULL, `sha256` CHAR(64) NOT NULL,
  PRIMARY KEY (`assetId`, `index`),
  CONSTRAINT `FileAssetPart_assetId_fkey` FOREIGN KEY (`assetId`) REFERENCES `FileAsset` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE TABLE `FileDelivery` (
  `id` VARCHAR(191) NOT NULL, `accountId` VARCHAR(191) NOT NULL, `assetId` VARCHAR(191) NOT NULL, `sessionId` VARCHAR(191) NOT NULL,
  `ciphertext` BLOB NOT NULL, `state` VARCHAR(191) NOT NULL DEFAULT 'pending', `receipt` BLOB NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `FileDelivery_accountId_sessionId_state_createdAt_idx` (`accountId`, `sessionId`, `state`, `createdAt`),
  INDEX `FileDelivery_accountId_assetId_createdAt_idx` (`accountId`, `assetId`, `createdAt`),
  CONSTRAINT `FileDelivery_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `FileDelivery_assetId_fkey` FOREIGN KEY (`assetId`) REFERENCES `FileAsset` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
