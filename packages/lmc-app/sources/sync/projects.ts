import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { decryptBlob, encryptBlob } from '@/encryption/blob';
import type { AuthCredentials } from '@/auth/tokenStorage';
import { activateProjectAvatar, downloadProjectAvatar, requestProjectAvatarUpload } from './apiProjects';
import { uploadEncryptedBlob } from './apiAttachments';
import type { Encryption } from './encryption/encryption';
import type {
    ApiProjectRecord,
    Project,
    ProjectAvatar,
    ProjectAvatarPreview,
    ProjectMetadata,
} from './projectTypes';

export interface DecryptedProjectRecord {
    project: Project;
    /** Transient key: callers must not put this into Zustand or display data. */
    dataKey: Uint8Array | null;
    avatar: {
        ref: string;
        preview: ProjectAvatarPreview;
        version: number;
    } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function parseProjectMetadata(value: unknown): ProjectMetadata | null {
    if (!isRecord(value)) return null;
    const name = nonEmptyString(value.name);
    if (!name) return null;
    return {
        name,
        kind: value.kind === undefined || value.kind === null ? null : nonEmptyString(value.kind),
    };
}

function parseProjectPreview(value: unknown): ProjectAvatarPreview | null {
    if (!isRecord(value)) return null;
    const thumbhash = nonEmptyString(value.thumbhash);
    const mimeType = nonEmptyString(value.mimeType);
    if (!thumbhash || !mimeType || !/^image\/[A-Za-z0-9.+-]+$/.test(mimeType)) return null;
    return { thumbhash, mimeType };
}

async function decryptJson(
    ciphertext: string,
    dataKey: Uint8Array | null,
    encryption: Pick<Encryption, 'openEncryption'>,
): Promise<unknown | null> {
    try {
        const encryptor = await encryption.openEncryption(dataKey);
        const encrypted = decodeBase64(ciphertext, 'base64');
        const decrypted = await encryptor.decrypt([encrypted]);
        return decrypted[0] ?? null;
    } catch {
        return null;
    }
}

/** Decrypt project metadata and its encrypted preview using the project key. */
export async function decryptProjectRecord(
    record: ApiProjectRecord,
    encryption: Pick<Encryption, 'decryptEncryptionKey' | 'openEncryption'>,
): Promise<DecryptedProjectRecord | null> {
    // Null is the legacy project form: openEncryption(null) uses the account
    // secretbox, and its avatar uses the master Happy Blobs key.
    let dataKey: Uint8Array | null = null;
    if (record.dataEncryptionKey !== null) {
        dataKey = await encryption.decryptEncryptionKey(record.dataEncryptionKey);
        if (!dataKey) return null;
    }

    const metadata = parseProjectMetadata(await decryptJson(record.metadata, dataKey, encryption));
    if (!metadata) return null;

    let avatar: DecryptedProjectRecord['avatar'] = null;
    if (record.avatar) {
        // Preview is private JSON under the same project key. Never treat the
        // ciphertext as a thumbhash or image placeholder.
        const preview = parseProjectPreview(await decryptJson(record.avatar.preview, dataKey, encryption));
        if (preview) {
            avatar = {
                ref: record.avatar.ref,
                preview,
                version: record.avatar.version,
            };
        }
    }

    return {
        project: {
            id: record.id,
            externalId: record.externalId,
            name: metadata.name,
            kind: metadata.kind ?? null,
            metadataVersion: record.metadataVersion,
            hasAvatar: record.avatar !== null,
            avatar: null,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
        },
        dataKey,
        avatar,
    };
}

/** Download and decrypt one full project avatar into a local data URI. */
export async function loadProjectAvatar(
    credentials: AuthCredentials,
    projectId: string,
    descriptor: NonNullable<DecryptedProjectRecord['avatar']>,
    blobKey: Uint8Array,
): Promise<ProjectAvatar | null> {
    try {
        const encryptedBytes = await downloadProjectAvatar(credentials, projectId);
        const bytes = decryptBlob(encryptedBytes, blobKey);
        if (!bytes) return null;

        return {
            ref: descriptor.ref,
            version: descriptor.version,
            mimeType: descriptor.preview.mimeType,
            thumbhash: descriptor.preview.thumbhash,
            uri: `data:${descriptor.preview.mimeType};base64,${encodeBase64(bytes)}`,
        };
    } catch {
        return null;
    }
}

/** A cropped, already-encoded image ready to become a project avatar. */
export interface ProjectAvatarUploadInput {
    bytes: Uint8Array;
    mimeType: string;
    thumbhash: string;
}

/**
 * Encrypt and publish a new project avatar, mirroring loadProjectAvatar.
 *
 * The image bytes travel under the project blob key and the {thumbhash,
 * mimeType} preview under the project data key, so the server stores two
 * opaque values and never sees the picture. Activation is last on purpose: a
 * failed upload leaves the previous avatar in place rather than pointing the
 * project at a ref that was never written.
 */
export async function uploadProjectAvatar(
    credentials: AuthCredentials,
    projectId: string,
    image: ProjectAvatarUploadInput,
    dataKey: Uint8Array | null,
    blobKey: Uint8Array,
    encryption: Pick<Encryption, 'openEncryption'>,
): Promise<void> {
    const encrypted = encryptBlob(image.bytes, blobKey);
    const upload = await requestProjectAvatarUpload(credentials, projectId, encrypted.length);
    await uploadEncryptedBlob(upload, encrypted, credentials);

    const encryptor = await encryption.openEncryption(dataKey);
    const previewCiphertext = await encryptor.encrypt([
        { thumbhash: image.thumbhash, mimeType: image.mimeType },
    ]);
    const preview = encodeBase64(previewCiphertext[0], 'base64');

    await activateProjectAvatar(credentials, projectId, upload.ref, preview);
}
