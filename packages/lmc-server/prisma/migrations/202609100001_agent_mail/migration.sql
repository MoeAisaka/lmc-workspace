-- Agent-to-agent mail and the directory that lets one session name another.
-- Both bodies are ciphertext under a key derived from the account secret and
-- held only by paired agents, so these tables carry no readable content.

CREATE TABLE `AgentMail` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `toSessionId` VARCHAR(191) NOT NULL,
    `fromSessionId` VARCHAR(191) NOT NULL,
    `body` LONGTEXT NOT NULL,
    `hop` INTEGER NOT NULL DEFAULT 1,
    `deliveredAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AgentMail_accountId_toSessionId_deliveredAt_idx`(`accountId`, `toSessionId`, `deliveredAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE `AgentDirectoryEntry` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NOT NULL,
    `body` LONGTEXT NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `AgentDirectoryEntry_sessionId_key`(`sessionId`),
    INDEX `AgentDirectoryEntry_accountId_updatedAt_idx`(`accountId`, `updatedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

ALTER TABLE `AgentMail` ADD CONSTRAINT `AgentMail_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `AgentDirectoryEntry` ADD CONSTRAINT `AgentDirectoryEntry_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
