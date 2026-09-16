import * as React from 'react';
import { Image, Platform, Pressable, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { Modal } from '@/modal';
import { useAuth } from '@/auth/AuthContext';
import { useProfile } from '@/sync/storage';
import { getAvatarUrl, getDisplayName } from '@/sync/profile';
import { sync } from '@/sync/sync';
import { updateAccountProfile } from '@/sync/apiProfile';
import { prepareProjectAvatarImage, revokeAvatarBlobUrl } from '@/utils/projectAvatarImage';
import { ProjectAvatarCropModal } from '@/components/ProjectAvatarCropModal';
import { encodeBase64 } from '@/encryption/base64';
import { lmcColors } from '../lmcColors';
import { t } from '@/text';

/**
 * Name and avatar of the signed-in account. The avatar reuses the project
 * cropper, so a portrait is framed the same way everywhere in the app, and is
 * sent as one already-resized data URI rather than a multi-step upload.
 */
export function ProfileSection() {
    const { theme } = useUnistyles();
    const colors = lmcColors(theme);
    const auth = useAuth();
    const profile = useProfile();
    const [busy, setBusy] = React.useState(false);
    const displayName = getDisplayName(profile) || '';
    const avatarUrl = getAvatarUrl(profile);

    const save = React.useCallback(async (update: Parameters<typeof updateAccountProfile>[1]) => {
        if (!auth.credentials) return;
        setBusy(true);
        try {
            await updateAccountProfile(auth.credentials, update);
            await sync.refreshProfile();
        } catch (error) {
            Modal.alert(t('lmc.profile.saveFailed'), error instanceof Error ? error.message : t('lmc.profile.retryLater'));
        } finally {
            setBusy(false);
        }
    }, [auth.credentials]);

    const rename = React.useCallback(async () => {
        const next = await Modal.prompt(t('lmc.profile.name'), t('lmc.profile.nameHint'), {
            defaultValue: displayName,
            placeholder: t('lmc.profile.namePlaceholder'),
            cancelText: t('common.cancel'),
            confirmText: t('lmc.profile.save'),
        });
        if (next === null) return;
        const trimmed = next.trim();
        const [first, ...rest] = trimmed.split(/\s+/);
        await save({ firstName: first || null, lastName: rest.join(' ') || null });
    }, [displayName, save]);

    const pickAvatar = React.useCallback(async () => {
        if (Platform.OS !== 'web') {
            const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
            if (permission.status !== 'granted') return;
        }
        const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: false, quality: 1, exif: false });
        if (result.canceled || !result.assets.length) return;
        const asset = result.assets[0];
        if (!(asset.width > 0) || !(asset.height > 0)) {
            Modal.alert(t('lmc.profile.imageFailed'), t('lmc.profile.imageFailedHint'));
            return;
        }
        Modal.show({
            component: ProjectAvatarCropModal,
            props: {
                asset: { uri: asset.uri, width: asset.width, height: asset.height },
                onSave: async (crop: Parameters<typeof prepareProjectAvatarImage>[0]['crop']) => {
                    const image = await prepareProjectAvatarImage({ uri: asset.uri, imageWidth: asset.width, imageHeight: asset.height, crop });
                    if (Platform.OS === 'web') revokeAvatarBlobUrl(asset.uri);
                    await save({
                        avatar: {
                            dataUri: `data:${image.mimeType};base64,${encodeBase64(image.bytes)}`,
                            width: 256,
                            height: 256,
                            thumbhash: image.thumbhash,
                        },
                    });
                },
            },
            dismissible: false,
        });
    }, [save]);

    const removeAvatar = React.useCallback(async () => {
        if (!await Modal.confirm(t('lmc.profile.removeAvatar'), t('lmc.profile.removeAvatarHint'), { cancelText: t('common.cancel'), confirmText: t('lmc.profile.remove'), destructive: true })) return;
        await save({ avatar: null });
    }, [save]);

    return (
        <ItemGroup title={t('lmc.profile.section')} footer={t('lmc.profile.footer')}>
            <Item
                title={displayName || t('lmc.profile.noName')}
                subtitle={t('lmc.profile.editNameHint')}
                loading={busy}
                leftElement={
                    <Pressable accessibilityRole="button" accessibilityLabel={t('lmc.profile.changeAvatar')} onPress={pickAvatar} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
                        <View style={{ width: 40, height: 40, borderRadius: 20, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.brand }}>
                            {avatarUrl
                                ? <Image source={{ uri: avatarUrl }} style={{ width: 40, height: 40 }} />
                                : <Text style={{ fontSize: 17, color: '#fff', ...Typography.default('semiBold') }}>{(displayName || 'L').trim().charAt(0).toUpperCase()}</Text>}
                            <View style={{ position: 'absolute', right: 0, bottom: 0, width: 16, height: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surface }}>
                                <Ionicons name="camera-outline" size={10} color={theme.colors.textSecondary} />
                            </View>
                        </View>
                    </Pressable>
                }
                onPress={rename}
            />
            <Item title={t('lmc.profile.changeAvatar')} subtitle={t('lmc.profile.avatarHint')} onPress={pickAvatar} disabled={busy} />
            {!!avatarUrl && <Item title={t('lmc.profile.removeAvatar')} destructive showChevron={false} onPress={removeAvatar} disabled={busy} />}
        </ItemGroup>
    );
}
