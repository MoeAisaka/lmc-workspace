import { suppressTouchReleaseClick } from '@/utils/touchMenuRelease';
import React from 'react';
import { Platform, Pressable } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { prepareProjectAvatarImage, revokeAvatarBlobUrl } from '@/utils/projectAvatarImage';
import { ProjectAvatarActions } from './ProjectAvatarActions';
import { readEventPoint, isTouchInteraction } from '@/utils/pointerEvents';
import { ProjectAvatarCropModal } from './ProjectAvatarCropModal';

interface ProjectAvatarButtonProps {
    children: React.ReactNode;
    ordinary?: boolean;
    projectId: string;
    projectName: string;
    hasCustomAvatar: boolean;
}

export const ProjectAvatarButton = React.memo(({
    projectId,
    children,
    ordinary = false,
    projectName,
    hasCustomAvatar,
}: ProjectAvatarButtonProps) => {
    const busyRef = React.useRef(false);
    const [anchor, setAnchor] = React.useState<{ x: number; y: number } | null>(null);
    const point = React.useRef({ x: 0, y: 0 });
    const touch = React.useRef(false);
    const longPressed = React.useRef(false);
    const openTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const releaseCleanup = React.useRef<(() => void) | null>(null);
    React.useEffect(() => () => { if (openTimer.current) clearTimeout(openTimer.current); releaseCleanup.current?.(); }, []);
    const mutationId = ordinary ? "group:" + projectId : projectId;
    const busy = React.useSyncExternalStore(
        sync.subscribeProjectAvatarMutations,
        () => sync.isProjectAvatarMutationInFlight(mutationId),
        () => false,
    );

    const openCropper = React.useCallback((asset: ImagePicker.ImagePickerAsset) => {
        Modal.show({
            component: ProjectAvatarCropModal,
            props: {
                asset: {
                    uri: asset.uri,
                    width: asset.width,
                    height: asset.height,
                },
                onSave: async (crop: Parameters<typeof prepareProjectAvatarImage>[0]['crop']) => {
                    const prepare = () => prepareProjectAvatarImage({
                        uri: asset.uri, imageWidth: asset.width, imageHeight: asset.height, crop,
                    }, ordinary);
                    if (ordinary) await sync.setGroupAvatar(projectId, prepare);
                    else await sync.setProjectAvatar(projectId, prepare);
                },
            },
            dismissible: false,
        });
    }, [projectId, ordinary]);

    const pickImage = React.useCallback(async () => {
        if (busyRef.current || sync.isProjectAvatarMutationInFlight(mutationId)) return;
        busyRef.current = true;

        try {
            // On web the picker must be opened before the click's browser user
            // activation expires. Native platforms need an explicit permission
            // request first; web does not.
            if (Platform.OS !== 'web') {
                const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
                if (permission.status !== 'granted') {
                    Modal.alert(
                        t('projectAvatar.permissionTitle'),
                        t('projectAvatar.permissionMessage'),
                        [{ text: t('common.ok') }],
                    );
                    return;
                }
            }

            const result = await ImagePicker.launchImageLibraryAsync({
                mediaTypes: ['images'],
                allowsMultipleSelection: false,
                selectionLimit: 1,
                quality: 1,
                exif: false,
            });
            if (result.canceled || !result.assets.length) return;

            const asset = result.assets[0];
            if (!(asset.width > 0) || !(asset.height > 0)) {
                if (Platform.OS === 'web') revokeAvatarBlobUrl(asset.uri);
                Modal.alert(
                    t('projectAvatar.invalidImageTitle'),
                    t('projectAvatar.invalidImageMessage'),
                    [{ text: t('common.ok') }],
                );
                return;
            }
            openCropper(asset);
        } catch {
            Modal.alert(
                t('projectAvatar.invalidImageTitle'),
                t('projectAvatar.invalidImageMessage'),
                [{ text: t('common.ok') }],
            );
        } finally {
            busyRef.current = false;
        }
    }, [openCropper, projectId, mutationId]);

    const restoreDefault = React.useCallback(async () => {
        if (busyRef.current || sync.isProjectAvatarMutationInFlight(mutationId)) return;
        busyRef.current = true;

        const confirmed = await Modal.confirm(
            t('projectAvatar.restoreConfirmTitle'),
            t('projectAvatar.restoreConfirmMessage'),
            {
                cancelText: t('common.cancel'),
                confirmText: t('projectAvatar.restore'),
                destructive: true,
            },
        );
        if (!confirmed) {
            busyRef.current = false;
            return;
        }

        try {
            if (ordinary) await sync.setGroupAvatar(projectId, null);
            else await sync.removeProjectAvatar(projectId);
        } catch {
            Modal.alert(
                t('projectAvatar.removeFailedTitle'),
                t('projectAvatar.removeFailedMessage'),
                [{ text: t('common.ok') }],
            );
        } finally {
            busyRef.current = false;
        }
    }, [projectId, ordinary, mutationId]);

    return <>
        <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${t('projectAvatar.actionsTitle')}: ${projectName}`}
            disabled={busy || Platform.OS !== 'web'}
            onPressIn={event => { longPressed.current = false; point.current = readEventPoint(event); touch.current = isTouchInteraction(event); }}
            onLongPress={() => { if (touch.current) longPressed.current = true; }}
            onPressOut={() => {
                if (!longPressed.current) return;
                longPressed.current = false;
                const position = point.current;
                releaseCleanup.current?.();
                releaseCleanup.current = suppressTouchReleaseClick(document);
                // Let the original long-press responder consume the release click
                // before mounting a menu beneath that finger.
                openTimer.current = setTimeout(() => setAnchor(position), 0);
            }}
            delayLongPress={450}
            {...(Platform.OS === 'web' ? {
                onContextMenu: (event: any) => { event.preventDefault(); event.stopPropagation(); setAnchor(readEventPoint(event)); },
                onKeyDown: (event: any) => {
                    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                        event.preventDefault(); const box = event.currentTarget.getBoundingClientRect(); setAnchor({x:box.left,y:box.bottom});
                    }
                },
            } : {})}
            style={{flex:1, minWidth:0, flexDirection:'row', alignItems:'center', gap:8, ...(Platform.OS === 'web' ? {userSelect:'none', WebkitTouchCallout:'none'} as any : {})}}
        >{children}</Pressable>
        <ProjectAvatarActions anchor={anchor} onClose={() => setAnchor(null)} hasCustomAvatar={hasCustomAvatar}
            onPick={() => { setAnchor(null); void pickImage(); }}
            onRestore={() => { setAnchor(null); setTimeout(() => { void restoreDefault(); }, 0); }} />
    </>;
});
