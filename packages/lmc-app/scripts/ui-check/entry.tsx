import React from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Pressable, View, Text } from 'react-native';
import { ModalProvider } from '@/modal/ModalProvider';
import { openCollaborationSheet } from '@/components/lmc/CollaborationSheet';
import { SortableHubGroups } from '@/components/lmc/SortableHubGroups.web';
import { splitHubGroups } from '@/utils/lmc/hubGroups';
import { useSessionRowMenu, SESSION_ROW_MENU_STYLE } from '@/hooks/useSessionRowMenu';
import { useAllSessions, useSetting } from '@/sync/storage';

declare global {
    interface Window {
        navigations?: number;
        saves?: number;
    }
}

// Menu visibility is driven by the production hook's anchor state, not a fake handler.
function MenuMarker({ sessionId, close }: { sessionId: string; close: () => void }) {
    return createPortal(<div role="menu" data-menu-session={sessionId} style={{ position: 'fixed', right: 20, top: 20 }}>
        {sessionId} menu <button onClick={close}>Close session menu</button>
    </div>, document.body);
}

function WorkerFixture({ hubId, sessionId }: { hubId: string; sessionId: string }) {
    const { anchor, closeMenu, menuProps } = useSessionRowMenu(sessionId);
    return <>
        <Pressable accessibilityRole="button" {...{ dataSet: { worker: hubId } }} style={SESSION_ROW_MENU_STYLE} {...menuProps}>
            <Text>worker / nested task rows</Text>
        </Pressable>
        {anchor && <MenuMarker sessionId={sessionId} close={closeMenu} />}
    </>;
}

function GroupFixture({ hubId, workerId, handleProps }: {
    hubId: string; workerId?: string; handleProps: Record<string, unknown>;
}) {
    const { anchor, closeMenu, menuProps, openMenuAt } = useSessionRowMenu(hubId);
    return <div data-group={hubId}>
        <Pressable
            accessibilityRole="button"
            onPress={() => { window.navigations = (window.navigations || 0) + 1; }}
            style={[{ height: 48, width: 380, backgroundColor: '#ddd', justifyContent: 'center' }, SESSION_ROW_MENU_STYLE]}
            {...menuProps}
            {...handleProps}
        >
            <Text>{hubId} header</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={`Menu ${hubId}`}
                onPress={() => openMenuAt({ x: 400, y: 20 })}>
                <Text>...</Text>
            </Pressable>
        </Pressable>
        <View style={{ height: hubId === 'H1' ? 150 : 60, padding: 8 }}>
            {workerId && <WorkerFixture hubId={hubId} sessionId={workerId} />}
            <p>whole group content</p>
        </View>
        {anchor && <MenuMarker sessionId={hubId} close={closeMenu} />}
    </div>;
}

function App() {
    const orders = useSetting('sessionProjectOrder');
    const groups = splitHubGroups(useAllSessions(), orders['lmc:hubs']).hubs;
    return (
        <ModalProvider>
            <div style={{ width: 380 }}>
                <h3>LMC collaboration and hub sorting checks</h3>
                {['P1', 'H1', 'W1'].map(id => (
                    <button key={id} onClick={() => openCollaborationSheet(id)}>Open {id}</button>
                ))}
                <input id="outside-sorter" aria-label="Focus outside sorter" />
                <SortableHubGroups
                    storageKey="lmc:hubs"
                    items={groups}
                    getId={group => group.hub.id}
                    renderItem={(group, handleProps) => (
                        <GroupFixture hubId={group.hub.id} workerId={group.workers[0]?.id} handleProps={handleProps} />
                    )}
                />
            </div>
        </ModalProvider>
    );
}

createRoot(document.getElementById('root')!).render(<App />);
