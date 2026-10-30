CREATE TABLE `LmcSharedCommand` (
    `id` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NOT NULL,
    `actorId` VARCHAR(191) NOT NULL,
    `requestId` VARCHAR(191) NOT NULL,
    `policyVersion` INTEGER NOT NULL,
    `state` VARCHAR(191) NOT NULL DEFAULT 'queued',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `claimedAt` DATETIME(3) NULL,
    PRIMARY KEY (`id`),
    UNIQUE INDEX `LmcSharedCommand_sessionId_actorId_requestId_key` (`sessionId`, `actorId`, `requestId`),
    INDEX `LmcSharedCommand_sessionId_state_idx` (`sessionId`, `state`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
