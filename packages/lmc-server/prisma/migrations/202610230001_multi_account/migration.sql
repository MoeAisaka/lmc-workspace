-- AlterTable
ALTER TABLE `Account` ADD COLUMN `accessVersion` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `enabled` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `role` ENUM('admin', 'member') NOT NULL DEFAULT 'member';

-- CreateTable
CREATE TABLE `LmcAccessLock` (
    `id` INTEGER NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

-- CreateTable
CREATE TABLE `LmcInvitation` (
    `id` VARCHAR(191) NOT NULL,
    `tokenHash` CHAR(64) NOT NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `consumedAt` DATETIME(3) NULL,
    `revokedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `LmcInvitation_tokenHash_key`(`tokenHash`),
    INDEX `LmcInvitation_createdById_createdAt_idx`(`createdById`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

-- CreateTable
CREATE TABLE `LmcResourcePolicy` (
    `id` VARCHAR(191) NOT NULL,
    `kind` ENUM('session', 'machine', 'project', 'file', 'provider', 'tool', 'memory') NOT NULL,
    `resourceId` VARCHAR(191) NOT NULL,
    `ownerAccountId` VARCHAR(191) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `adminManaged` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `LmcResourcePolicy_ownerAccountId_kind_idx`(`ownerAccountId`, `kind`),
    UNIQUE INDEX `LmcResourcePolicy_kind_resourceId_key`(`kind`, `resourceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

-- CreateTable
CREATE TABLE `LmcResourceGrant` (
    `policyId` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `actions` JSON NOT NULL,
    `keyEnvelope` BLOB NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `LmcResourceGrant_accountId_policyId_idx`(`accountId`, `policyId`),
    PRIMARY KEY (`policyId`, `accountId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

-- CreateTable
CREATE TABLE `LmcAccessAudit` (
    `id` VARCHAR(191) NOT NULL,
    `actorId` VARCHAR(191) NOT NULL,
    `action` VARCHAR(191) NOT NULL,
    `targetId` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `before` JSON NULL,
    `after` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `LmcAccessAudit_targetId_createdAt_idx`(`targetId`, `createdAt`),
    INDEX `LmcAccessAudit_actorId_createdAt_idx`(`actorId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

-- AddForeignKey
ALTER TABLE `LmcInvitation` ADD CONSTRAINT `LmcInvitation_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LmcResourcePolicy` ADD CONSTRAINT `LmcResourcePolicy_ownerAccountId_fkey` FOREIGN KEY (`ownerAccountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LmcResourceGrant` ADD CONSTRAINT `LmcResourceGrant_policyId_fkey` FOREIGN KEY (`policyId`) REFERENCES `LmcResourcePolicy`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `LmcResourceGrant` ADD CONSTRAINT `LmcResourceGrant_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;


-- Serialize permission mutations, including last-admin protection.
INSERT INTO `LmcAccessLock` (`id`) VALUES (1);
