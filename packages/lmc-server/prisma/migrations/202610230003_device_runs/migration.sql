CREATE TABLE `LmcDeviceRun` (
    `sessionId` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `machineId` VARCHAR(191) NOT NULL,
    `hostOwnerId` VARCHAR(191) NOT NULL,
    `engine` VARCHAR(191) NOT NULL,
    `requestId` VARCHAR(191) NOT NULL,
    `launchId` VARCHAR(191) NOT NULL,
    `policyVersion` INTEGER NOT NULL,
    `state` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    PRIMARY KEY (`sessionId`),
    UNIQUE INDEX `LmcDeviceRun_accountId_requestId_key` (`accountId`, `requestId`),
    INDEX `LmcDeviceRun_machineId_state_idx` (`machineId`, `state`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `FileAsset` ADD COLUMN `runtimeSessionId` VARCHAR(191) NULL;
