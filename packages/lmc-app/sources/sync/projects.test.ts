import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import sodium from 'libsodium-wrappers';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import type { AuthCredentials } from '@/auth/tokenStorage';
import type { ApiProjectRecord } from './projectTypes';

const mocks = vi.hoisted(() => ({
    downloadProjectAvatarMock: vi.fn(),
    requestProjectAvatarUploadMock: vi.fn(),
    activateProjectAvatarMock: vi.fn(),
    uploadEncryptedBlobMock: vi.fn(),
}));

vi.mock('expo-crypto', () => ({
    getRandomBytes: (size: number) => {
        const { randomBytes } = require('node:crypto');
        return new Uint8Array(randomBytes(size));
    },
}));
vi.mock('@/encryption/libsodium.lib', () => ({
    default: require('libsodium-wrappers'),
}));
vi.mock('./apiProjects', () => ({
    downloadProjectAvatar: mocks.downloadProjectAvatarMock,
    requestProjectAvatarUpload: mocks.requestProjectAvatarUploadMock,
    activateProjectAvatar: mocks.activateProjectAvatarMock,
}));
vi.mock('./apiAttachments', () => ({
    uploadEncryptedBlob: mocks.uploadEncryptedBlobMock,
}));

import { decryptBlob, encryptBlob } from '@/encryption/blob';
import { decryptProjectRecord, loadProjectAvatar, uploadProjectAvatar } from './projects';

beforeAll(async () => {
    await sodium.ready;
});

beforeEach(() => {
    vi.clearAllMocks();
});

function encryptedJson(value: unknown): string {
    return encodeBase64(new TextEncoder().encode(JSON.stringify(value)));
}

function record(overrides: Partial<ApiProjectRecord> = {}): ApiProjectRecord {
    return {
        id: 'project-1',
        externalId: 'external-1',
        metadata: encryptedJson({ name: 'Happy', kind: 'repository' }),
        metadataVersion: 2,
        dataEncryptionKey: 'wrapped-key',
        avatar: {
            ref: 'projects/project-1/avatar/a.enc',
            preview: encryptedJson({ thumbhash: 'thumbhash-1', mimeType: 'image/jpeg' }),
            version: 5,
        },
        createdAt: 10,
        updatedAt: 20,
        ...overrides,
    };
}

function encryptionStub(options: { key?: Uint8Array | null } = {}) {
    const key = options.key === undefined ? new Uint8Array([1, 2, 3]) : options.key;
    return {
        decryptEncryptionKey: vi.fn(async () => key),
        openEncryption: vi.fn(async () => ({
            encrypt: vi.fn(async (values: unknown[]) => values.map((value) => (
                new TextEncoder().encode(JSON.stringify(value))
            ))),
            decrypt: vi.fn(async (values: Uint8Array[]) => {
                const bytes = values[0];
                return [JSON.parse(new TextDecoder().decode(bytes))];
            }),
        })),
    };
}

describe('project decryption', () => {
    it('decrypts metadata and encrypted preview with the project data key', async () => {
        const encryption = encryptionStub();
        const result = await decryptProjectRecord(record(), encryption);

        expect(result?.project).toMatchObject({
            id: 'project-1',
            externalId: 'external-1',
            name: 'Happy',
            kind: 'repository',
            metadataVersion: 2,
            hasAvatar: true,
            avatar: null,
        });
        expect(result?.avatar).toEqual({
            ref: 'projects/project-1/avatar/a.enc',
            version: 5,
            preview: { thumbhash: 'thumbhash-1', mimeType: 'image/jpeg' },
        });
        expect(encryption.decryptEncryptionKey).toHaveBeenCalledWith('wrapped-key');
        expect(encryption.openEncryption).toHaveBeenCalledTimes(2);
        expect(encryption.openEncryption).toHaveBeenNthCalledWith(1, result?.dataKey);
        expect(encryption.openEncryption).toHaveBeenNthCalledWith(2, result?.dataKey);
    });

    it('uses the legacy account encryption path when the project key is null', async () => {
        const encryption = encryptionStub({ key: null });
        const result = await decryptProjectRecord(record({ dataEncryptionKey: null }), encryption);

        expect(result?.project.name).toBe('Happy');
        expect(encryption.decryptEncryptionKey).not.toHaveBeenCalled();
        expect(encryption.openEncryption).toHaveBeenCalledWith(null);
    });

    it('retains active-avatar presence when its encrypted preview cannot be used', async () => {
        const encryption = encryptionStub();
        const result = await decryptProjectRecord(record({
            avatar: {
                ref: 'projects/project-1/avatar/a.enc',
                preview: encryptedJson({ thumbhash: '', mimeType: 'image/png' }),
                version: 5,
            },
        }), encryption);

        expect(result?.project.hasAvatar).toBe(true);
        expect(result?.project.avatar).toBeNull();
        expect(result?.avatar).toBeNull();
    });

    it('marks a project without an active descriptor as avatar-free', async () => {
        const result = await decryptProjectRecord(record({ avatar: null }), encryptionStub());

        expect(result?.project.hasAvatar).toBe(false);
        expect(result?.avatar).toBeNull();
    });
});

describe('project avatar loading', () => {
    it('downloads by project id and decrypts the blob with the derived blob key', async () => {
        const credentials: AuthCredentials = { token: 'token', secret: 'secret' };
        const blobKey = Uint8Array.from({ length: 32 }, (_, index) => index);
        mocks.downloadProjectAvatarMock.mockResolvedValueOnce(
            encryptBlob(new Uint8Array([255, 0]), blobKey),
        );

        const result = await loadProjectAvatar(
            credentials,
            'project-1',
            {
                ref: 'projects/project-1/avatar/a.enc',
                version: 5,
                preview: { thumbhash: 'thumbhash-1', mimeType: 'image/jpeg' },
            },
            blobKey,
        );

        expect(mocks.downloadProjectAvatarMock).toHaveBeenCalledWith(credentials, 'project-1');
        expect(result).toMatchObject({
            ref: 'projects/project-1/avatar/a.enc',
            version: 5,
            mimeType: 'image/jpeg',
            thumbhash: 'thumbhash-1',
            uri: `data:image/jpeg;base64,${encodeBase64(new Uint8Array([255, 0]))}`,
        });
    });
});

describe('project avatar upload', () => {
    const credentials: AuthCredentials = { token: 'token', secret: 'secret' };
    const blobKey = Uint8Array.from({ length: 32 }, (_, index) => 31 - index);
    const dataKey = new Uint8Array([4, 5, 6]);
    const upload = {
        ref: 'projects/project-1/avatar/new.enc',
        uploadUrl: 'https://files.example.test/new.enc',
        method: 'PUT' as const,
    };

    it('uploads encrypted bytes before activating an encrypted preview', async () => {
        const order: string[] = [];
        const encryption = encryptionStub({ key: dataKey });
        mocks.requestProjectAvatarUploadMock.mockResolvedValueOnce(upload);
        mocks.uploadEncryptedBlobMock.mockImplementationOnce(async () => {
            order.push('upload');
        });
        mocks.activateProjectAvatarMock.mockImplementationOnce(async () => {
            order.push('activate');
        });

        await uploadProjectAvatar(
            credentials,
            'project-1',
            {
                bytes: new Uint8Array([9, 8, 7]),
                mimeType: 'image/png',
                thumbhash: 'thumbhash-new',
            },
            dataKey,
            blobKey,
            encryption,
        );

        expect(order).toEqual(['upload', 'activate']);
        expect(mocks.requestProjectAvatarUploadMock).toHaveBeenCalledWith(
            credentials,
            'project-1',
            43,
        );
        const encryptedBytes = mocks.uploadEncryptedBlobMock.mock.calls[0][1] as Uint8Array;
        expect(decryptBlob(encryptedBytes, blobKey)).toEqual(new Uint8Array([9, 8, 7]));
        expect(mocks.uploadEncryptedBlobMock).toHaveBeenCalledWith(upload, encryptedBytes, credentials);

        const previewBase64 = mocks.activateProjectAvatarMock.mock.calls[0][3] as string;
        expect(JSON.parse(new TextDecoder().decode(decodeBase64(previewBase64, 'base64')))).toEqual({
            thumbhash: 'thumbhash-new',
            mimeType: 'image/png',
        });
        expect(mocks.activateProjectAvatarMock).toHaveBeenCalledWith(
            credentials,
            'project-1',
            upload.ref,
            previewBase64,
        );
        expect(encryption.openEncryption).toHaveBeenCalledWith(dataKey);
    });

    it('does not activate a ref when the encrypted blob upload fails', async () => {
        const encryption = encryptionStub({ key: dataKey });
        mocks.requestProjectAvatarUploadMock.mockResolvedValueOnce(upload);
        mocks.uploadEncryptedBlobMock.mockRejectedValueOnce(new Error('upload failed'));

        await expect(uploadProjectAvatar(
            credentials,
            'project-1',
            {
                bytes: new Uint8Array([1]),
                mimeType: 'image/png',
                thumbhash: 'thumbhash-new',
            },
            dataKey,
            blobKey,
            encryption,
        )).rejects.toThrow('upload failed');

        expect(mocks.activateProjectAvatarMock).not.toHaveBeenCalled();
        expect(encryption.openEncryption).not.toHaveBeenCalled();
    });
});
