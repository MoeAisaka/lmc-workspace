import React from 'react';
import { Modal } from '@/modal';
import { useSession } from '@/sync/storage';
import { SessionInfoContent } from '@/app/(app)/session/[id]/info';
import { Text } from '@/components/StyledText';
import { UtilityDialog } from './UtilityDialog';
export function SessionInfoDialog({ sessionId, onClose }: { sessionId: string; onClose?: () => void }) {
    const session = useSession(sessionId);
    return <UtilityDialog title="会话详情" onClose={onClose} testID="session-info-dialog">
        {session ? <SessionInfoContent session={session} onClose={onClose} /> : <Text>会话暂不可用</Text>}
    </UtilityDialog>;
}
export function openSessionInfo(sessionId: string) { Modal.show({ component: SessionInfoDialog, props: { sessionId }, blurBackdrop: true }); }
